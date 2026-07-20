import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, Dispatcher, request as undiciRequest, setGlobalDispatcher } from "undici";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("8080"),
  TRUST_PROXY_HOPS: z.string().default("1"),
  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("90"),
  REQUEST_TIMEOUT_MS: z.string().default("45000"),
  CACHE_TTL_SECONDS: z.string().default("300"),
  DEFAULT_CURRENCY: z.string().default("USD"),
  BILLING_SERVICES_JSON: z.string().default("[]"),
  BILLING_CONFIG_FILE: z.string().default(""),
  BILLING_SHARED_BEARER_TOKEN: z.string().default(""),
  OPENAPI_SERVER_URL: z.string().default("http://cloud-billing-service.directus.svc.cluster.local:8080"),
  CORS_ALLOW_ORIGIN: z.string().default("*")
});

const env = envSchema.parse(process.env);
const PORT = Math.max(1, Math.min(65535, Number(env.PORT) || 8080));
const RATE_WINDOW_MS = Math.max(1000, Number(env.RATE_WINDOW_MS) || 60_000);
const RATE_MAX = Math.max(1, Number(env.RATE_MAX) || 90);
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(env.REQUEST_TIMEOUT_MS) || 45_000);
const CACHE_TTL_SECONDS = Math.max(0, Number(env.CACHE_TTL_SECONDS) || 300);
const DEFAULT_CURRENCY = normalizeCurrency(env.DEFAULT_CURRENCY, "USD");
const OPENAPI_SERVER_URL = env.OPENAPI_SERVER_URL || "/";

type JsonRecord = Record<string, unknown>;
type BillingProvider = "aws" | "azure" | "gcp" | "oci" | "mock" | "generic" | "other";
type BillingStatus = "healthy" | "watch" | "over-budget" | "unknown";

type BillingPeriod = {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
  kind?: "current" | "previous";
};

type BillingPeriods = {
  current: BillingPeriod;
  previous: BillingPeriod;
};

type BillingServiceDefinition = JsonRecord & {
  id: string;
  name: string;
  provider?: string;
  providerLabel?: string;
  provider_label?: string;
  providerName?: string;
  provider_name?: string;
  adapter?: string;
  accountRef?: string;
  account_ref?: string;
  region?: string;
  environment?: string;
  owner?: string;
  currency?: string;
  budgetMonthly?: number;
  budget_monthly?: number;
};

type BillingLineItem = {
  label: string;
  amount: number;
  currency: string;
};

type ProviderCostResult = {
  currency: string;
  lineItems: BillingLineItem[];
  warnings: string[];
};

type BillingServiceCost = {
  serviceId: string;
  name: string;
  provider: BillingProvider;
  providerLabel: string;
  provider_label: string;
  accountRef: string;
  region: string;
  environment: string;
  owner: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  monthToDateCost: number;
  forecastCost: number;
  previousMonthCost: number;
  budgetMonthly: number;
  dailyAverageCost: number;
  costChangePercent: number;
  status: BillingStatus;
  lastUpdated: string;
  breakdown: Array<BillingLineItem & { percent: number }>;
  warnings: string[];
};

type BillingSummary = {
  ok: boolean;
  generatedAt: string;
  generated_at: string;
  currency: string;
  periodStart: string;
  period_start: string;
  periodEnd: string;
  period_end: string;
  totals: JsonRecord;
  providerTotals: JsonRecord[];
  provider_totals: JsonRecord[];
  services: BillingServiceCost[];
  warnings: string[];
};

type HasuraActionEnvelope = {
  action?: unknown;
  input?: unknown;
  session_variables?: JsonRecord;
  request_query?: string;
};

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000
  })
);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringList(value: unknown): string[] {
  return asArray(value).map((entry) => asString(entry)).filter(Boolean);
}

function normalizeCurrency(value: unknown, fallback = "USD"): string {
  const normalized = asString(value, fallback).toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
}

function normalizeProvider(value: unknown): BillingProvider {
  const normalized = asString(value).toLowerCase();
  if (
    normalized === "aws" ||
    normalized === "azure" ||
    normalized === "gcp" ||
    normalized === "oci" ||
    normalized === "mock" ||
    normalized === "generic"
  ) {
    return normalized;
  }
  return "other";
}

function providerLabel(provider: BillingProvider, service?: BillingServiceDefinition): string {
  const explicit = service
    ? asString(service.providerLabel || service.provider_label || service.providerName || service.provider_name)
    : "";
  if (explicit) return explicit;
  if (provider === "aws") return "AWS";
  if (provider === "azure") return "Azure";
  if (provider === "gcp") return "GCP";
  if (provider === "oci") return "OCI";
  if (provider === "mock") return "Mock";
  if (provider === "generic") return "Generic";
  return asString(service?.provider, "Other");
}

function parseStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.flatMap((entry) => asString(entry).split(",")) : asString(value).split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(value: unknown, fallback: Date): Date {
  const normalized = asString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return fallback;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000));
}

function daysInUtcMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function buildPeriods(input: JsonRecord): BillingPeriods {
  const now = new Date();
  const defaultStart = startOfUtcMonth(now);
  const currentStart = parseDateOnly(input.from ?? input.start ?? input.periodStart ?? input.period_start, defaultStart);
  const currentEnd = parseDateOnly(input.to ?? input.end ?? input.periodEnd ?? input.period_end, now);
  const safeCurrentEnd = currentEnd > currentStart ? currentEnd : now;
  const previousEnd = startOfUtcMonth(currentStart);
  const previousStart = startOfUtcMonth(addUtcMonths(currentStart, -1));
  return {
    current: { from: dateOnly(currentStart), to: dateOnly(safeCurrentEnd), fromDate: currentStart, toDate: safeCurrentEnd, kind: "current" },
    previous: { from: dateOnly(previousStart), to: dateOnly(previousEnd), fromDate: previousStart, toDate: previousEnd, kind: "previous" }
  };
}

function httpError(status: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { status, details });
}

async function httpJson<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const { statusCode, body } = await undiciRequest(url, {
      method: (init.method ?? "GET") as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      signal: controller.signal
    });
    const text = await body.text();
    let payload: unknown = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw httpError(statusCode, `Non-JSON response from upstream (${statusCode}).`);
      }
    }
    if (statusCode >= 400) {
      const record = asRecord(payload);
      const message = asString(record.error_description) || asString(record.error) || asString(record.message) || `Upstream request failed (${statusCode}).`;
      throw httpError(statusCode, message, payload);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw httpError(408, `Upstream request timed out after ${init.timeoutMs ?? REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacSha256Hex(key: crypto.BinaryLike | crypto.KeyObject, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function loadServices(): Promise<BillingServiceDefinition[]> {
  const source = env.BILLING_CONFIG_FILE ? await readFile(env.BILLING_CONFIG_FILE, "utf8") : env.BILLING_SERVICES_JSON;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw httpError(500, "Billing service configuration JSON is invalid.");
  }
  const services = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed).services);
  return services
    .map((entry) => asRecord(entry))
    .filter((entry) => asString(entry.id) && asString(entry.name))
    .map((entry) => ({ ...entry, id: asString(entry.id), name: asString(entry.name) }));
}

function normalizeLineItems(items: unknown, currency: string): BillingLineItem[] {
  const merged = new Map<string, BillingLineItem>();
  for (const item of asArray(items)) {
    const record = asRecord(item);
    const label = asString(record.label, "Uncategorized");
    const itemCurrency = normalizeCurrency(record.currency, currency);
    const amount = asNumber(record.amount, 0);
    const key = `${label}|${itemCurrency}`;
    const existing = merged.get(key) ?? { label, amount: 0, currency: itemCurrency };
    existing.amount += amount;
    merged.set(key, existing);
  }
  return [...merged.values()].sort((left, right) => right.amount - left.amount);
}

function topBreakdown(items: BillingLineItem[], total: number, currency: string): Array<BillingLineItem & { percent: number }> {
  const top = items.slice(0, 5);
  const otherAmount = items.slice(5).reduce((sum, item) => sum + item.amount, 0);
  const rows = otherAmount > 0 ? [...top, { label: "Other", amount: otherAmount, currency }] : top;
  return rows.map((item) => ({
    label: item.label,
    amount: Number(item.amount.toFixed(2)),
    currency: item.currency,
    percent: total > 0 ? Number(((item.amount / total) * 100).toFixed(2)) : 0
  }));
}

function statusForForecast(forecastCost: number, budgetMonthly: number): BillingStatus {
  if (budgetMonthly <= 0) return "unknown";
  if (forecastCost > budgetMonthly) return "over-budget";
  if (forecastCost >= budgetMonthly * 0.85) return "watch";
  return "healthy";
}

function monthForecast(amount: number, period: BillingPeriod): number {
  if (period.fromDate.getTime() !== startOfUtcMonth(period.fromDate).getTime()) return amount;
  return (amount / daysBetween(period.fromDate, period.toDate)) * daysInUtcMonth(period.fromDate);
}

function prorateMonthlyCost(monthlyCost: number, period: BillingPeriod): number {
  const monthDays = daysInUtcMonth(period.fromDate);
  const elapsedDays = Math.min(monthDays, daysBetween(period.fromDate, period.toDate));
  return monthlyCost * (elapsedDays / monthDays);
}

function configuredNumber(config: JsonRecord, directKeys: string[], envKeys: string[]): number | undefined {
  for (const key of directKeys) {
    const value = asOptionalNumber(config[key]);
    if (value !== undefined) return value;
  }
  for (const key of envKeys) {
    const envName = asString(config[key]);
    if (!envName) continue;
    const value = asOptionalNumber(process.env[envName]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function genericConfig(service: BillingServiceDefinition): JsonRecord {
  return asRecord(service.generic || service.manual || service.staticBilling || service.static_billing);
}

function genericBreakdown(service: BillingServiceDefinition, amount: number, currency: string): BillingLineItem[] {
  const generic = genericConfig(service);
  let source: unknown = generic.breakdown;
  const breakdownJsonEnv = asString(generic.breakdownJsonEnv || generic.breakdown_json_env);
  const rawBreakdownJson = breakdownJsonEnv ? asString(process.env[breakdownJsonEnv]) : "";
  if (rawBreakdownJson) {
    try {
      source = JSON.parse(rawBreakdownJson);
    } catch {
      return [{ label: "Invalid configured breakdown", amount, currency }];
    }
  }
  const configured = normalizeLineItems(source, currency);
  if (configured.length > 0) {
    const total = configured.reduce((sum, item) => sum + item.amount, 0);
    const scale = total > 0 && amount > 0 ? amount / total : 1;
    return configured.map((item) => ({ ...item, amount: item.amount * scale }));
  }
  return [{ label: asString(generic.defaultLineItemLabel || generic.default_line_item_label, "Recurring services"), amount, currency }];
}

async function fetchGenericCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const generic = genericConfig(service);
  const currency = normalizeCurrency(generic.currency || service.currency, DEFAULT_CURRENCY);
  const currentCost = configuredNumber(
    generic,
    ["monthToDateCost", "month_to_date_cost", "currentCost", "current_cost", "cost"],
    ["monthToDateCostEnv", "month_to_date_cost_env", "currentCostEnv", "current_cost_env", "costEnv", "cost_env"]
  );
  const previousCost = configuredNumber(
    generic,
    ["previousMonthCost", "previous_month_cost", "previousCost", "previous_cost"],
    ["previousMonthCostEnv", "previous_month_cost_env", "previousCostEnv", "previous_cost_env"]
  );
  const monthlyRecurringCost = configuredNumber(
    generic,
    ["monthlyRecurringCost", "monthly_recurring_cost", "monthlyCost", "monthly_cost"],
    ["monthlyRecurringCostEnv", "monthly_recurring_cost_env", "monthlyCostEnv", "monthly_cost_env"]
  );
  const warnings = asStringList(generic.warnings);
  let amount: number | undefined;
  if (period.kind === "previous") {
    amount = previousCost ?? (monthlyRecurringCost !== undefined ? prorateMonthlyCost(monthlyRecurringCost, period) : currentCost);
  } else {
    amount = currentCost ?? (monthlyRecurringCost !== undefined ? prorateMonthlyCost(monthlyRecurringCost, period) : undefined);
  }
  if (amount === undefined) {
    amount = 0;
    warnings.push("Generic billing source has no configured amount yet.");
  }
  return { currency, lineItems: genericBreakdown(service, amount, currency), warnings };
}

function mockBreakdown(service: BillingServiceDefinition, amount: number, currency: string): BillingLineItem[] {
  const mock = asRecord(service.mock);
  const configured = asArray(mock.breakdown);
  if (configured.length > 0) {
    const rows = configured.map((entry) => {
      const record = asRecord(entry);
      return { label: asString(record.label, asString(record.name, "Mock usage")), amount: asNumber(record.amount, 0), currency };
    });
    const total = rows.reduce((sum, item) => sum + item.amount, 0);
    const scale = total > 0 ? amount / total : 1;
    return rows.map((item) => ({ ...item, amount: item.amount * scale }));
  }
  return [
    { label: "Compute", amount: amount * 0.52, currency },
    { label: "Storage", amount: amount * 0.31, currency },
    { label: "Network", amount: amount * 0.17, currency }
  ];
}

async function fetchMockCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const mock = asRecord(service.mock);
  const currency = normalizeCurrency(service.currency, DEFAULT_CURRENCY);
  const currentAmount = asNumber(mock.monthToDateCost ?? mock.month_to_date_cost, 0);
  const previousAmount = asNumber(mock.previousMonthCost ?? mock.previous_month_cost, currentAmount * 0.92);
  const amount = period.kind === "previous" ? previousAmount : currentAmount;
  return { currency, lineItems: mockBreakdown(service, amount, currency), warnings: [] };
}

function awsDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function awsCanonicalHeaders(headers: Record<string, string>): { canonicalHeaders: string; signedHeaders: string } {
  const entries = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()] as const).sort(([left], [right]) => left.localeCompare(right));
  return {
    canonicalHeaders: entries.map(([key, value]) => `${key}:${value}\n`).join(""),
    signedHeaders: entries.map(([key]) => key).join(";")
  };
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string, serviceName: string): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = hmacSha256(dateKey, region);
  const dateRegionServiceKey = hmacSha256(dateRegionKey, serviceName);
  return hmacSha256(dateRegionServiceKey, "aws4_request");
}

function awsFilter(service: BillingServiceDefinition): JsonRecord | undefined {
  const aws = asRecord(service.aws);
  const filters: JsonRecord[] = [];
  const linkedAccountId = asString(aws.linkedAccountId || aws.linked_account_id || service.linkedAccountId);
  if (linkedAccountId) filters.push({ Dimensions: { Key: "LINKED_ACCOUNT", Values: [linkedAccountId] } });
  for (const [key, value] of Object.entries(asRecord(aws.dimensionFilters || aws.dimension_filters))) {
    const values = asArray(value).map((entry) => asString(entry)).filter(Boolean);
    if (values.length > 0) filters.push({ Dimensions: { Key: key, Values: values } });
  }
  for (const [key, value] of Object.entries(asRecord(aws.tagFilters || aws.tag_filters || service.tags))) {
    const values = (Array.isArray(value) ? value : [value]).map((entry) => asString(entry)).filter(Boolean);
    if (values.length > 0) filters.push({ Tags: { Key: key, Values: values } });
  }
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : { And: filters };
}

function signAwsRequest(endpoint: string, region: string, accessKeyId: string, secretAccessKey: string, sessionToken: string, body: string, target: string): Record<string, string> {
  const url = new URL(endpoint);
  const amzDate = awsDate();
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-target": target
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  const { canonicalHeaders, signedHeaders } = awsCanonicalHeaders(headers);
  const canonicalRequest = ["POST", url.pathname || "/", url.search.slice(1), canonicalHeaders, signedHeaders, sha256Hex(body)].join("\n");
  const credentialScope = `${dateStamp}/${region}/ce/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacSha256Hex(awsSigningKey(secretAccessKey, dateStamp, region, "ce"), stringToSign);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function fetchAwsCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const aws = asRecord(service.aws);
  const region = asString(aws.region, asString(service.region, "us-east-1")) || "us-east-1";
  const endpoint = asString(aws.endpoint, "https://ce.us-east-1.amazonaws.com");
  const accessKeyId = asString(process.env[asString(aws.accessKeyIdEnv, "AWS_ACCESS_KEY_ID")]);
  const secretAccessKey = asString(process.env[asString(aws.secretAccessKeyEnv, "AWS_SECRET_ACCESS_KEY")]);
  const sessionToken = asString(process.env[asString(aws.sessionTokenEnv, "AWS_SESSION_TOKEN")]);
  if (!accessKeyId || !secretAccessKey) throw httpError(500, `AWS credentials are not configured for ${service.id}.`);
  const metric = asString(aws.metric, "UnblendedCost");
  const filter = awsFilter(service);
  const body = JSON.stringify({
    TimePeriod: { Start: period.from, End: period.to },
    Granularity: asString(aws.granularity, "MONTHLY"),
    Metrics: [metric],
    GroupBy: [{ Type: "DIMENSION", Key: asString(aws.groupByDimension, "SERVICE") }],
    ...(filter ? { Filter: filter } : {})
  });
  const payload = asRecord(await httpJson(endpoint, {
    method: "POST",
    headers: signAwsRequest(endpoint, region, accessKeyId, secretAccessKey, sessionToken, body, "AWSInsightsIndexService.GetCostAndUsage"),
    body
  }));
  const groups = asArray(asRecord(asArray(payload.ResultsByTime)[0]).Groups);
  const lineItems = groups.length > 0
    ? groups.map((group) => {
      const record = asRecord(group);
      const metricRecord = asRecord(asRecord(record.Metrics)[metric]);
      return { label: asString(asArray(record.Keys)[0], "AWS service"), amount: asNumber(metricRecord.Amount, 0), currency: normalizeCurrency(metricRecord.Unit, service.currency) };
    })
    : [{ label: "Total", amount: asNumber(asRecord(asRecord(asRecord(asArray(payload.ResultsByTime)[0]).Total)[metric]).Amount, 0), currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY) }];
  return { currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY), lineItems, warnings: [] };
}

async function azureToken(service: BillingServiceDefinition): Promise<string> {
  const azure = asRecord(service.azure);
  const tenantId = asString(azure.tenantId) || asString(process.env[asString(azure.tenantIdEnv, "AZURE_TENANT_ID")]);
  const clientId = asString(azure.clientId) || asString(process.env[asString(azure.clientIdEnv, "AZURE_CLIENT_ID")]);
  const clientSecret = asString(azure.clientSecret) || asString(process.env[asString(azure.clientSecretEnv, "AZURE_CLIENT_SECRET")]);
  if (!tenantId || !clientId || !clientSecret) throw httpError(500, `Azure credentials are not configured for ${service.id}.`);
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("scope", asString(azure.scope, "https://management.azure.com/.default"));
  const payload = asRecord(await httpJson(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  }));
  const token = asString(payload.access_token);
  if (!token) throw httpError(502, `Azure token response did not include access_token for ${service.id}.`);
  return token;
}

function azureScope(service: BillingServiceDefinition): string {
  const azure = asRecord(service.azure);
  const explicit = asString(azure.scopePath || azure.scope_path);
  if (explicit) return explicit.replace(/^\/+/, "");
  const subscriptionId = asString(azure.subscriptionId || azure.subscription_id);
  if (subscriptionId) return `subscriptions/${encodeURIComponent(subscriptionId)}`;
  const billingAccountId = asString(azure.billingAccountId || azure.billing_account_id);
  if (billingAccountId) return `providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(billingAccountId)}`;
  throw httpError(500, `Azure scope is not configured for ${service.id}.`);
}

async function fetchAzureCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const azure = asRecord(service.azure);
  const token = await azureToken(service);
  const endpoint = `https://management.azure.com/${azureScope(service)}/providers/Microsoft.CostManagement/query?api-version=${encodeURIComponent(asString(azure.apiVersion || azure.api_version, "2025-03-01"))}`;
  const payload = asRecord(await httpJson(endpoint, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "Usage",
      timeframe: "Custom",
      timePeriod: { from: `${period.from}T00:00:00Z`, to: `${period.to}T00:00:00Z` },
      dataset: {
        granularity: "None",
        aggregation: { totalCost: { name: asString(azure.costColumn || azure.cost_column, "PreTaxCost"), function: "Sum" } },
        grouping: [{ type: "Dimension", name: asString(azure.groupByDimension || azure.group_by_dimension, "ServiceName") }]
      }
    })
  }));
  const properties = asRecord(payload.properties);
  const columns = asArray(properties.columns).map((entry) => asString(asRecord(entry).name));
  const costIndex = columns.findIndex((name) => ["pretaxcost", "cost", "totalcost"].includes(name.toLowerCase()));
  const serviceIndex = columns.findIndex((name) => ["servicename", "metercategory"].includes(name.toLowerCase()));
  const currencyIndex = columns.findIndex((name) => name.toLowerCase() === "currency");
  const lineItems = asArray(properties.rows).map((row) => {
    const values = asArray(row);
    return { label: asString(values[serviceIndex], "Azure service"), amount: asNumber(values[costIndex], 0), currency: normalizeCurrency(values[currencyIndex], service.currency) };
  });
  return { currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY), lineItems, warnings: [] };
}

async function gcpAccessToken(service: BillingServiceDefinition): Promise<string> {
  const gcp = asRecord(service.gcp);
  const explicitToken = asString(process.env[asString(gcp.accessTokenEnv || gcp.access_token_env, "GOOGLE_OAUTH_ACCESS_TOKEN")]);
  if (explicitToken) return explicitToken;
  const rawJson = asString(process.env[asString(gcp.serviceAccountJsonEnv || gcp.service_account_json_env, "GOOGLE_APPLICATION_CREDENTIALS_JSON")]);
  const filePath = asString(gcp.serviceAccountPath || gcp.service_account_path) || asString(process.env[asString(gcp.serviceAccountPathEnv || gcp.service_account_path_env, "GOOGLE_APPLICATION_CREDENTIALS")]);
  const account = rawJson ? JSON.parse(rawJson) as JsonRecord : filePath ? JSON.parse(await readFile(filePath, "utf8")) as JsonRecord : {};
  const clientEmail = asString(account.client_email);
  const privateKey = asString(account.private_key).replace(/\\n/g, "\n");
  const tokenUri = asString(account.token_uri, "https://oauth2.googleapis.com/token");
  if (!clientEmail || !privateKey) throw httpError(500, `GCP credentials are not configured for ${service.id}.`);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
    iss: clientEmail,
    scope: asString(gcp.scope, "https://www.googleapis.com/auth/bigquery.readonly"),
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const assertion = `${unsigned}.${base64Url(crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey))}`;
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);
  const payload = asRecord(await httpJson(tokenUri, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  }));
  const token = asString(payload.access_token);
  if (!token) throw httpError(502, `GCP token response did not include access_token for ${service.id}.`);
  return token;
}

async function fetchGcpCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const gcp = asRecord(service.gcp);
  const projectId = asString(gcp.projectId || gcp.project_id);
  const billingTable = asString(gcp.billingTable || gcp.billing_table);
  if (!projectId || !billingTable) throw httpError(500, `GCP projectId and billingTable are required for ${service.id}.`);
  const serviceColumn = asString(gcp.serviceColumn || gcp.service_column, "service.description");
  const costColumn = asString(gcp.costColumn || gcp.cost_column, "cost");
  const currencyColumn = asString(gcp.currencyColumn || gcp.currency_column, "currency");
  const usageStartColumn = asString(gcp.usageStartColumn || gcp.usage_start_column, "usage_start_time");
  const query = `
    SELECT ${serviceColumn} AS service_label, SUM(${costColumn}) AS amount, ANY_VALUE(${currencyColumn}) AS currency
    FROM \`${billingTable}\`
    WHERE ${usageStartColumn} >= TIMESTAMP(@from) AND ${usageStartColumn} < TIMESTAMP(@to)
    GROUP BY service_label
    ORDER BY amount DESC
  `;
  const payload = asRecord(await httpJson(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${await gcpAccessToken(service)}`, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: [
        { name: "from", parameterType: { type: "TIMESTAMP" }, parameterValue: { value: `${period.from}T00:00:00Z` } },
        { name: "to", parameterType: { type: "TIMESTAMP" }, parameterValue: { value: `${period.to}T00:00:00Z` } }
      ]
    })
  }));
  const fields = asArray(asRecord(payload.schema).fields).map((entry) => asString(asRecord(entry).name));
  const lineItems = asArray(payload.rows).map((row) => {
    const values = asArray(asRecord(row).f).map((entry) => asRecord(entry).v);
    return {
      label: asString(values[fields.indexOf("service_label")], "GCP service"),
      amount: asNumber(values[fields.indexOf("amount")], 0),
      currency: normalizeCurrency(values[fields.indexOf("currency")], service.currency)
    };
  });
  return { currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY), lineItems, warnings: [] };
}

async function fetchOciCosts(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const oci = asRecord(service.oci);
  const region = asString(oci.region, asString(service.region, "us-ashburn-1"));
  const endpoint = asString(oci.endpoint, `https://usageapi.${region}.oci.oraclecloud.com`);
  const url = new URL(asString(oci.path, "/20200107/usage"), endpoint).toString();
  const tenancyId = asString(oci.tenancyId) || asString(process.env[asString(oci.tenancyIdEnv || oci.tenancy_id_env, "OCI_TENANCY_ID")]);
  const userId = asString(oci.userId) || asString(process.env[asString(oci.userIdEnv || oci.user_id_env, "OCI_USER_ID")]);
  const fingerprint = asString(oci.fingerprint) || asString(process.env[asString(oci.fingerprintEnv || oci.fingerprint_env, "OCI_FINGERPRINT")]);
  const privateKey = (asString(oci.privateKey) || asString(process.env[asString(oci.privateKeyEnv || oci.private_key_env, "OCI_PRIVATE_KEY")])).replace(/\\n/g, "\n");
  if (!tenancyId || !userId || !fingerprint || !privateKey) throw httpError(500, `OCI credentials are not configured for ${service.id}.`);
  const body = JSON.stringify({
    tenantId: tenancyId,
    timeUsageStarted: `${period.from}T00:00:00.000Z`,
    timeUsageEnded: `${period.to}T00:00:00.000Z`,
    granularity: asString(oci.granularity, "MONTHLY"),
    queryType: asString(oci.queryType || oci.query_type, "COST"),
    groupBy: asArray(oci.groupBy || oci.group_by).length > 0 ? asArray(oci.groupBy || oci.group_by) : ["service"],
    compartmentDepth: Math.max(1, Math.min(6, asNumber(oci.compartmentDepth || oci.compartment_depth, 6)))
  });
  const parsed = new URL(url);
  const date = new Date().toUTCString();
  const contentSha256 = Buffer.from(sha256Hex(body), "hex").toString("base64");
  const requestTarget = `post ${parsed.pathname}${parsed.search}`;
  const signingString = [
    `(request-target): ${requestTarget}`,
    `date: ${date}`,
    `host: ${parsed.host}`,
    `content-length: ${Buffer.byteLength(body)}`,
    "content-type: application/json",
    `x-content-sha256: ${contentSha256}`
  ].join("\n");
  const signature = crypto.createSign("RSA-SHA256").update(signingString).sign(privateKey, "base64");
  const payload = asRecord(await httpJson(url, {
    method: "POST",
    headers: {
      date,
      host: parsed.host,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-content-sha256": contentSha256,
      authorization: `Signature version="1",keyId="${tenancyId}/${userId}/${fingerprint}",algorithm="rsa-sha256",headers="(request-target) date host content-length content-type x-content-sha256",signature="${signature}"`
    },
    body
  }));
  const lineItems = asArray(payload.items || payload.Items).map((entry) => {
    const record = asRecord(entry);
    return {
      label: asString(record.service || record.serviceName || record.service_name, "OCI service"),
      amount: asNumber(record.computedAmount ?? record.computed_amount ?? record.cost ?? record.amount, 0),
      currency: normalizeCurrency(record.currency, service.currency)
    };
  });
  return { currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY), lineItems, warnings: [] };
}

async function fetchProviderPeriod(service: BillingServiceDefinition, period: BillingPeriod): Promise<ProviderCostResult> {
  const adapter = asString(service.adapter || service.billingAdapter || service.billing_adapter || service.provider, "mock").toLowerCase();
  if (adapter === "mock") return fetchMockCosts(service, period);
  if (adapter === "aws") return fetchAwsCosts(service, period);
  if (adapter === "azure") return fetchAzureCosts(service, period);
  if (adapter === "gcp") return fetchGcpCosts(service, period);
  if (adapter === "oci") return fetchOciCosts(service, period);
  if (adapter === "generic" || adapter === "manual" || adapter === "static" || adapter === "fixed") return fetchGenericCosts(service, period);
  throw httpError(500, `Unsupported billing adapter "${adapter}" for ${service.id}.`);
}

async function summarizeService(service: BillingServiceDefinition, periods: BillingPeriods, defaultCurrency: string): Promise<BillingServiceCost> {
  const [current, previous] = await Promise.all([
    fetchProviderPeriod(service, periods.current),
    fetchProviderPeriod(service, periods.previous)
  ]);
  const currency = normalizeCurrency(current.currency || service.currency, defaultCurrency);
  const currentItems = normalizeLineItems(current.lineItems, currency);
  const previousItems = normalizeLineItems(previous.lineItems, currency);
  const monthToDateCost = currentItems.reduce((sum, item) => sum + item.amount, 0);
  const previousMonthCost = previousItems.reduce((sum, item) => sum + item.amount, 0);
  const forecastCost = monthForecast(monthToDateCost, periods.current);
  const dailyAverageCost = monthToDateCost / daysBetween(periods.current.fromDate, periods.current.toDate);
  const budgetMonthly = asNumber(service.budgetMonthly ?? service.budget_monthly, 0);
  const costChangePercent = previousMonthCost > 0 ? ((monthToDateCost - previousMonthCost) / previousMonthCost) * 100 : 0;
  const provider = normalizeProvider(service.provider || service.adapter);
  const label = providerLabel(provider, service);
  return {
    serviceId: service.id,
    name: service.name,
    provider,
    providerLabel: label,
    provider_label: label,
    accountRef: asString(service.accountRef || service.account_ref),
    region: asString(service.region, "global"),
    environment: asString(service.environment, "Platform"),
    owner: asString(service.owner, "Platform"),
    currency,
    periodStart: periods.current.from,
    periodEnd: periods.current.to,
    monthToDateCost: Number(monthToDateCost.toFixed(2)),
    forecastCost: Number(forecastCost.toFixed(2)),
    previousMonthCost: Number(previousMonthCost.toFixed(2)),
    budgetMonthly: Number(budgetMonthly.toFixed(2)),
    dailyAverageCost: Number(dailyAverageCost.toFixed(2)),
    costChangePercent: Number(costChangePercent.toFixed(2)),
    status: statusForForecast(forecastCost, budgetMonthly),
    lastUpdated: new Date().toISOString(),
    breakdown: topBreakdown(currentItems, monthToDateCost, currency),
    warnings: [...current.warnings, ...previous.warnings]
  };
}

function providerTotals(services: BillingServiceCost[], currency: string): JsonRecord[] {
  const totals = new Map<string, JsonRecord & { monthToDateCost: number; forecastCost: number; budgetMonthly: number; serviceCount: number }>();
  for (const service of services) {
    const key = `${service.provider}|${service.providerLabel}`;
    const existing = totals.get(key) ?? {
      provider: service.provider,
      providerLabel: service.providerLabel,
      provider_label: service.providerLabel,
      currency,
      monthToDateCost: 0,
      forecastCost: 0,
      budgetMonthly: 0,
      serviceCount: 0
    };
    existing.monthToDateCost += service.monthToDateCost;
    existing.forecastCost += service.forecastCost;
    existing.budgetMonthly += service.budgetMonthly;
    existing.serviceCount += 1;
    totals.set(key, existing);
  }
  return [...totals.values()].map((entry) => ({
    provider: entry.provider,
    providerLabel: entry.providerLabel,
    provider_label: entry.providerLabel,
    currency: entry.currency,
    monthToDateCost: Number(entry.monthToDateCost.toFixed(2)),
    month_to_date_cost: Number(entry.monthToDateCost.toFixed(2)),
    forecastCost: Number(entry.forecastCost.toFixed(2)),
    forecast_cost: Number(entry.forecastCost.toFixed(2)),
    budgetMonthly: Number(entry.budgetMonthly.toFixed(2)),
    budget_monthly: Number(entry.budgetMonthly.toFixed(2)),
    serviceCount: entry.serviceCount,
    service_count: entry.serviceCount
  })).sort((left, right) => asNumber(right.monthToDateCost) - asNumber(left.monthToDateCost));
}

function serviceMetadata(service: BillingServiceDefinition): JsonRecord {
  const provider = normalizeProvider(service.provider || service.adapter);
  const label = providerLabel(provider, service);
  return {
    id: service.id,
    name: service.name,
    provider,
    providerLabel: label,
    provider_label: label,
    accountRef: asString(service.accountRef || service.account_ref),
    account_ref: asString(service.accountRef || service.account_ref),
    region: asString(service.region, "global"),
    environment: asString(service.environment, "Platform"),
    owner: asString(service.owner, "Platform"),
    currency: normalizeCurrency(service.currency, DEFAULT_CURRENCY),
    budgetMonthly: asNumber(service.budgetMonthly ?? service.budget_monthly, 0),
    budget_monthly: asNumber(service.budgetMonthly ?? service.budget_monthly, 0)
  };
}

const configuredServices = await loadServices();
const cache = new Map<string, { createdAt: number; payload: BillingSummary }>();

async function buildBillingSummary(input: JsonRecord): Promise<BillingSummary> {
  const periods = buildPeriods(input);
  const serviceIds = parseStringList(input.serviceIds ?? input.service_ids ?? input.services);
  const requested = new Set(serviceIds);
  const selected = serviceIds.length > 0 ? configuredServices.filter((service) => requested.has(service.id)) : configuredServices;
  if (selected.length === 0) throw httpError(404, "No configured billing services matched the request.");
  const currency = normalizeCurrency(input.currency, DEFAULT_CURRENCY);
  const results = await Promise.allSettled(selected.map((service) => summarizeService(service, periods, currency)));
  const services: BillingServiceCost[] = [];
  const warnings: string[] = [];
  results.forEach((result, index) => {
    const id = selected[index]?.id ?? "unknown";
    if (result.status === "fulfilled") {
      services.push(result.value);
      warnings.push(...result.value.warnings.map((warning) => `${result.value.serviceId}: ${warning}`));
    } else {
      warnings.push(`${id}: ${result.reason instanceof Error ? result.reason.message : "Unknown provider error."}`);
    }
  });
  const totals = {
    monthToDateCost: Number(services.reduce((sum, service) => sum + service.monthToDateCost, 0).toFixed(2)),
    month_to_date_cost: Number(services.reduce((sum, service) => sum + service.monthToDateCost, 0).toFixed(2)),
    forecastCost: Number(services.reduce((sum, service) => sum + service.forecastCost, 0).toFixed(2)),
    forecast_cost: Number(services.reduce((sum, service) => sum + service.forecastCost, 0).toFixed(2)),
    previousMonthCost: Number(services.reduce((sum, service) => sum + service.previousMonthCost, 0).toFixed(2)),
    previous_month_cost: Number(services.reduce((sum, service) => sum + service.previousMonthCost, 0).toFixed(2)),
    budgetMonthly: Number(services.reduce((sum, service) => sum + service.budgetMonthly, 0).toFixed(2)),
    budget_monthly: Number(services.reduce((sum, service) => sum + service.budgetMonthly, 0).toFixed(2)),
    dailyAverageCost: Number(services.reduce((sum, service) => sum + service.dailyAverageCost, 0).toFixed(2)),
    daily_average_cost: Number(services.reduce((sum, service) => sum + service.dailyAverageCost, 0).toFixed(2))
  };
  const rollup = providerTotals(services, currency);
  return {
    ok: warnings.length === 0,
    generatedAt: new Date().toISOString(),
    generated_at: new Date().toISOString(),
    currency,
    periodStart: periods.current.from,
    period_start: periods.current.from,
    periodEnd: periods.current.to,
    period_end: periods.current.to,
    totals,
    providerTotals: rollup,
    provider_totals: rollup,
    services,
    warnings
  };
}

function cacheKey(input: JsonRecord): string {
  return JSON.stringify(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

async function cachedSummary(input: JsonRecord): Promise<BillingSummary & { cache: JsonRecord }> {
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_SECONDS * 1000) {
    return { ...cached.payload, cache: { hit: true, ttlSeconds: CACHE_TTL_SECONDS, ttl_seconds: CACHE_TTL_SECONDS } };
  }
  const payload = await buildBillingSummary(input);
  cache.set(key, { createdAt: Date.now(), payload });
  return { ...payload, cache: { hit: false, ttlSeconds: CACHE_TTL_SECONDS, ttl_seconds: CACHE_TTL_SECONDS } };
}

async function handleAction(input: JsonRecord): Promise<unknown> {
  const action = asString(input.action, "summary").toLowerCase();
  if (action === "services" || action === "list_services" || action === "listservices") {
    return { ok: true, services: configuredServices.map(serviceMetadata) };
  }
  return cachedSummary(input);
}

function enforceSharedBearer(req: Request): void {
  if (!env.BILLING_SHARED_BEARER_TOKEN) return;
  if (asString(req.header("authorization")) !== `Bearer ${env.BILLING_SHARED_BEARER_TOKEN}`) {
    throw httpError(401, "Unauthorized");
  }
}

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Cloud Billing Service",
    version: "1.0.0",
    description: "Normalized cloud billing aggregation API for internal operations and Hasura actions."
  },
  servers: [{ url: OPENAPI_SERVER_URL }],
  paths: {
    "/healthz": { get: { operationId: "healthz", responses: { "200": { description: "Service process health" } } } },
    "/readyz": { get: { operationId: "readyz", responses: { "200": { description: "Service readiness" } } } },
    "/billing/services": {
      get: {
        operationId: "listBillingServices",
        summary: "List configured billing service metadata",
        responses: {
          "200": {
            description: "Configured services",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    services: { type: "array", items: { $ref: "#/components/schemas/BillingServiceMetadata" } }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/billing/summary": {
      get: {
        operationId: "getBillingSummary",
        summary: "Fetch normalized cloud billing summary",
        parameters: [
          { in: "query", name: "serviceIds", required: false, schema: { type: "string" } },
          { in: "query", name: "currency", required: false, schema: { type: "string" } },
          { in: "query", name: "from", required: false, schema: { type: "string", format: "date" } },
          { in: "query", name: "to", required: false, schema: { type: "string", format: "date" } }
        ],
        responses: {
          "200": {
            description: "Cloud billing summary",
            content: { "application/json": { schema: { $ref: "#/components/schemas/BillingSummary" } } }
          }
        }
      }
    },
    "/hasura/actions/billing": {
      post: {
        operationId: "hasuraFetchCloudBilling",
        summary: "Hasura action endpoint for cloud billing",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  input: {
                    type: "object",
                    properties: {
                      action: { type: "string", enum: ["summary", "services"] },
                      serviceIds: { type: "string" },
                      currency: { type: "string" },
                      from: { type: "string", format: "date" },
                      to: { type: "string", format: "date" }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Cloud billing action payload",
            content: { "application/json": { schema: { $ref: "#/components/schemas/BillingSummary" } } }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      HasuraActionRequest: {
        type: "object",
        properties: {
          action: { type: "object", additionalProperties: true },
          input: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["summary", "services"] },
              serviceIds: { type: "string" },
              service_ids: { type: "string" },
              currency: { type: "string" },
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" }
            }
          },
          session_variables: { type: "object", additionalProperties: true }
        }
      },
      BillingServiceMetadata: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          provider: { type: "string", enum: ["aws", "azure", "gcp", "oci", "mock", "generic", "other"] },
          providerLabel: { type: "string" },
          provider_label: { type: "string" },
          accountRef: { type: "string" },
          account_ref: { type: "string" },
          region: { type: "string" },
          environment: { type: "string" },
          owner: { type: "string" },
          currency: { type: "string" },
          budgetMonthly: { type: "number" },
          budget_monthly: { type: "number" }
        }
      },
      BillingBreakdown: {
        type: "object",
        properties: {
          label: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          percent: { type: "number" }
        }
      },
      BillingServiceCost: {
        allOf: [
          { $ref: "#/components/schemas/BillingServiceMetadata" },
          {
            type: "object",
            properties: {
              serviceId: { type: "string" },
              periodStart: { type: "string", format: "date" },
              periodEnd: { type: "string", format: "date" },
              monthToDateCost: { type: "number" },
              forecastCost: { type: "number" },
              previousMonthCost: { type: "number" },
              dailyAverageCost: { type: "number" },
              costChangePercent: { type: "number" },
              status: { type: "string", enum: ["healthy", "watch", "over-budget", "unknown"] },
              lastUpdated: { type: "string", format: "date-time" },
              breakdown: { type: "array", items: { $ref: "#/components/schemas/BillingBreakdown" } },
              warnings: { type: "array", items: { type: "string" } }
            }
          }
        ]
      },
      BillingSummary: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          generatedAt: { type: "string", format: "date-time" },
          generated_at: { type: "string", format: "date-time" },
          currency: { type: "string" },
          periodStart: { type: "string", format: "date" },
          period_start: { type: "string", format: "date" },
          periodEnd: { type: "string", format: "date" },
          period_end: { type: "string", format: "date" },
          totals: { type: "object", additionalProperties: true },
          providerTotals: { type: "array", items: { type: "object", additionalProperties: true } },
          provider_totals: { type: "array", items: { type: "object", additionalProperties: true } },
          services: { type: "array", items: { $ref: "#/components/schemas/BillingServiceCost" } },
          warnings: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

const app = express();
app.set("trust proxy", Math.max(0, Number(env.TRUST_PROXY_HOPS) || 1));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "512kb" }));
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: RATE_WINDOW_MS, limit: RATE_MAX, standardHeaders: "draft-7", legacyHeaders: false }));

app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", env.CORS_ALLOW_ORIGIN);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "cloud-billing-service",
    version: "1.0.0",
    configured_services: configuredServices.length,
    configuredServices: configuredServices.length
  });
});

app.head("/healthz", (_req, res) => {
  res.status(200).end();
});

app.get("/readyz", (_req, res) => {
  res.status(200).json({ ok: true, configured_services: configuredServices.length });
});

app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiSpec);
});

app.get("/billing/services", (req, res, next) => {
  try {
    enforceSharedBearer(req);
    res.status(200).json({ ok: true, services: configuredServices.map(serviceMetadata) });
  } catch (error) {
    next(error);
  }
});

app.get("/billing/summary", async (req, res, next) => {
  try {
    enforceSharedBearer(req);
    res.status(200).json(await cachedSummary(req.query as JsonRecord));
  } catch (error) {
    next(error);
  }
});

app.post("/hasura/actions/billing", async (req, res, next) => {
  try {
    enforceSharedBearer(req);
    const envelope = asRecord(req.body) as HasuraActionEnvelope;
    const input = asRecord(envelope.input ?? req.body);
    res.status(200).json(await handleAction(input));
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found", status: 404 } });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = Math.max(400, Math.min(599, Number((err as { status?: number }).status) || 500));
  res.status(status).json({
    error: {
      message: err instanceof Error ? err.message : "Internal server error",
      status,
      details: (err as { details?: unknown }).details
    }
  });
});

app.listen(PORT, () => {
  console.log(`[cloud-billing-service] listening on :${PORT} (${configuredServices.length} configured services)`);
});
