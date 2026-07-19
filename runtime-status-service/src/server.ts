import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, Dispatcher, request as undiciRequest, setGlobalDispatcher } from "undici";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("8080"),
  TRUST_PROXY_HOPS: z.string().default("1"),
  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("90"),
  REQUEST_TIMEOUT_MS: z.string().default("8000"),
  RUN_TIMEOUT_MS: z.string().default("30000"),
  DIRECTUS_BASE_URL: z.string().default("http://directus-service.directus.svc.cluster.local:8055"),
  DIRECTUS_HEALTH_PATH: z.string().default("/server/health"),
  DIRECTUS_STATIC_TOKEN: z.string().default(""),
  DIRECTUS_TOKEN_VAULT_PATH: z.string().default("secret/data/directus/gravitee/openapi/admin"),
  DIRECTUS_TOKEN_VAULT_KEY: z.string().default("token"),
  INTERNAL_TOKEN: z.string().default(""),
  INTERNAL_TOKEN_VAULT_PATH: z.string().default("secret/data/runtime-status-service"),
  INTERNAL_TOKEN_VAULT_KEY: z.string().default("token"),
  VAULT_ADDR: z.string().default("http://vault.vault.svc.cluster.local:8200"),
  VAULT_TOKEN_FILE: z.string().default("/vault-secrets/vault-token"),
  TOKEN_CACHE_SECONDS: z.string().default("300"),
  OPENAPI_SERVER_URL: z.string().default("http://runtime-status-service.directus.svc.cluster.local:8080"),
  DEFAULT_MANUAL_HIGH_IMPACT_ALLOWED: z.string().default("false")
});

const env = envSchema.parse(process.env);
const PORT = Math.max(1, Math.min(65535, Number(env.PORT) || 8080));
const RATE_WINDOW_MS = Math.max(1000, Number(env.RATE_WINDOW_MS) || 60_000);
const RATE_MAX = Math.max(1, Number(env.RATE_MAX) || 90);
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(env.REQUEST_TIMEOUT_MS) || 8000);
const RUN_TIMEOUT_MS = Math.max(5000, Number(env.RUN_TIMEOUT_MS) || 30_000);
const DIRECTUS_BASE_URL = env.DIRECTUS_BASE_URL.replace(/\/+$/, "");
const DIRECTUS_HEALTH_PATH = env.DIRECTUS_HEALTH_PATH.startsWith("/")
  ? env.DIRECTUS_HEALTH_PATH
  : `/${env.DIRECTUS_HEALTH_PATH}`;
const VAULT_ADDR = env.VAULT_ADDR.replace(/\/+$/, "");
const TOKEN_CACHE_SECONDS = Math.max(5, Number(env.TOKEN_CACHE_SECONDS) || 300);
const OPENAPI_SERVER_URL = env.OPENAPI_SERVER_URL || "/";
const DEFAULT_MANUAL_HIGH_IMPACT_ALLOWED = env.DEFAULT_MANUAL_HIGH_IMPACT_ALLOWED.toLowerCase() === "true";

type JsonRecord = Record<string, unknown>;
type CanaryStatus = "running" | "succeeded" | "failed" | "skipped";
type CanarySeverity = "healthy" | "warning" | "critical" | "unknown";

type DirectusListResponse<T> = {
  data?: T[];
};

type DirectusItemResponse<T> = {
  data?: T;
};

type CanaryDefinition = {
  id?: string;
  key: string;
  name: string;
  domain: string;
  status: string;
  description?: string | null;
  enabled: boolean;
  impact_level: string;
  schedule_hint?: string | null;
  max_frequency_seconds: number;
  timeout_ms: number;
  config_json: JsonRecord;
  sort?: number | null;
  date_created?: string | null;
  date_updated?: string | null;
};

type CanaryRun = {
  id: string;
  definition_key: string;
  trigger_source: string;
  status: CanaryStatus;
  severity: CanarySeverity;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  details_json?: JsonRecord | null;
  evidence_json?: JsonRecord | null;
  error?: string | null;
  request_id?: string | null;
};

type CanaryStep = {
  id?: string;
  run_id: string;
  definition_key: string;
  step_key: string;
  name: string;
  status: CanaryStatus;
  severity: CanarySeverity;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  details_json?: JsonRecord | null;
  error?: string | null;
  sort?: number | null;
};

type CanaryStepConfig = {
  key: string;
  name?: string;
  type?: string;
  method?: string;
  url?: string;
  auth?: "none" | "directus";
  expect_status?: number[];
  timeout_ms?: number;
  optional?: boolean;
};

type CanaryRunResult = {
  run: CanaryRun;
  steps: CanaryStep[];
};

type VaultCacheEntry = {
  expiresAt: number;
  value: string;
};

const vaultCache = new Map<string, VaultCacheEntry>();

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000
  })
);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(asString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampTimeout(value: unknown, fallback: number): number {
  return Math.max(1000, Math.min(RUN_TIMEOUT_MS, asNumber(value, fallback)));
}

function httpMethod(value: unknown, fallback: Dispatcher.HttpMethod = "GET"): Dispatcher.HttpMethod {
  const normalized = asString(value, fallback).toUpperCase();
  if (normalized === "GET" || normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE" || normalized === "HEAD" || normalized === "OPTIONS") {
    return normalized;
  }
  return fallback;
}

function truncate(value: string, max = 1200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  const root = asRecord(payload);
  const directError = asString(root?.error);
  if (directError) {
    return directError;
  }
  const errors = asArray(root?.errors);
  const firstError = asRecord(errors[0]);
  const firstMessage = asString(firstError?.message);
  if (firstMessage) {
    return firstMessage;
  }
  const detail = asString(root?.detail);
  if (detail) {
    return detail;
  }
  return fallback;
}

async function parseJsonResponse(text: string): Promise<unknown> {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function httpJson<T>(
  url: string,
  init: {
    method?: Dispatcher.HttpMethod;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<{ statusCode: number; payload: T; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const response = await undiciRequest(url, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {})
      },
      body,
      signal: controller.signal
    });
    const text = await response.body.text();
    const payload = await parseJsonResponse(text);
    return { statusCode: response.statusCode, payload: payload as T, text };
  } finally {
    clearTimeout(timer);
  }
}

async function readVaultToken(): Promise<string> {
  try {
    return (await readFile(env.VAULT_TOKEN_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

async function vaultValue(path: string, key: string): Promise<string> {
  const cacheKey = `${path}#${key}`;
  const cached = vaultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const token = await readVaultToken();
  if (!token) {
    throw new Error("Vault token is unavailable");
  }

  const { statusCode, payload, text } = await httpJson<JsonRecord>(`${VAULT_ADDR}/v1/${path}`, {
    headers: { "X-Vault-Token": token },
    timeoutMs: REQUEST_TIMEOUT_MS
  });
  if (statusCode >= 400) {
    throw new Error(`Vault read ${path} failed: ${statusCode} ${truncate(text, 300)}`);
  }

  const data = asRecord(asRecord(payload)?.data);
  const values = asRecord(data?.data);
  const value = asString(values?.[key]) || asString(values?.value);
  if (!value) {
    throw new Error(`Vault read ${path} did not contain ${key}`);
  }
  vaultCache.set(cacheKey, { value, expiresAt: Date.now() + TOKEN_CACHE_SECONDS * 1000 });
  return value;
}

async function directusToken(): Promise<string> {
  if (env.DIRECTUS_STATIC_TOKEN) {
    return env.DIRECTUS_STATIC_TOKEN;
  }
  return vaultValue(env.DIRECTUS_TOKEN_VAULT_PATH, env.DIRECTUS_TOKEN_VAULT_KEY);
}

async function internalToken(): Promise<string> {
  if (env.INTERNAL_TOKEN) {
    return env.INTERNAL_TOKEN;
  }
  if (!env.INTERNAL_TOKEN_VAULT_PATH) {
    return "";
  }
  return vaultValue(env.INTERNAL_TOKEN_VAULT_PATH, env.INTERNAL_TOKEN_VAULT_KEY);
}

async function directusJson<T>(path: string, init: { method?: Dispatcher.HttpMethod; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const token = await directusToken();
  const { statusCode, payload, text } = await httpJson<unknown>(`${DIRECTUS_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    timeoutMs: init.timeoutMs ?? REQUEST_TIMEOUT_MS,
    headers: { authorization: `Bearer ${token}` }
  });
  if (statusCode >= 400) {
    throw new Error(`Directus ${init.method ?? "GET"} ${path} failed: ${statusCode} ${truncate(extractErrorMessage(payload, text), 500)}`);
  }
  return payload as T;
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

async function listDefinitions(includeDisabled = false): Promise<CanaryDefinition[]> {
  const filter = includeDisabled ? undefined : JSON.stringify({ enabled: { _eq: true } });
  const response = await directusJson<DirectusListResponse<CanaryDefinition>>(
    `/items/runtime_canary_definitions${queryString({
      limit: 200,
      sort: "sort,key",
      filter
    })}`
  );
  return response.data ?? [];
}

async function getDefinition(definitionKey: string): Promise<CanaryDefinition | null> {
  const response = await directusJson<DirectusListResponse<CanaryDefinition>>(
    `/items/runtime_canary_definitions${queryString({
      limit: 1,
      filter: JSON.stringify({ key: { _eq: definitionKey } })
    })}`
  );
  return response.data?.[0] ?? null;
}

async function listRuns(definitionKey = "", limit = 100): Promise<CanaryRun[]> {
  const filter = definitionKey ? JSON.stringify({ definition_key: { _eq: definitionKey } }) : undefined;
  const response = await directusJson<DirectusListResponse<CanaryRun>>(
    `/items/runtime_canary_runs${queryString({
      limit: Math.max(1, Math.min(250, limit)),
      sort: "-started_at",
      filter
    })}`
  );
  return response.data ?? [];
}

async function getRun(runId: string): Promise<CanaryRun | null> {
  const response = await directusJson<DirectusItemResponse<CanaryRun>>(`/items/runtime_canary_runs/${encodeURIComponent(runId)}`);
  return response.data ?? null;
}

async function listRunSteps(runId: string): Promise<CanaryStep[]> {
  const response = await directusJson<DirectusListResponse<CanaryStep>>(
    `/items/runtime_canary_run_steps${queryString({
      limit: 200,
      sort: "sort,started_at",
      filter: JSON.stringify({ run_id: { _eq: runId } })
    })}`
  );
  return response.data ?? [];
}

async function latestRunForDefinition(definitionKey: string): Promise<CanaryRun | null> {
  const runs = await listRuns(definitionKey, 1);
  return runs[0] ?? null;
}

function getStepConfigs(definition: CanaryDefinition): CanaryStepConfig[] {
  const config = asRecord(definition.config_json) ?? {};
  return asArray(config.steps)
    .map((step): CanaryStepConfig | null => {
      const raw = asRecord(step);
      if (!raw) {
        return null;
      }
      const key = asString(raw.key);
      const url = asString(raw.url);
      if (!key || !url) {
        return null;
      }
      return {
        key,
        url,
        name: asString(raw.name, key),
        type: asString(raw.type, "http"),
        method: asString(raw.method, "GET").toUpperCase(),
        auth: asString(raw.auth, "none") === "directus" ? "directus" : "none",
        expect_status: asArray(raw.expect_status)
          .map((entry) => Math.trunc(asNumber(entry, 0)))
          .filter((entry) => entry >= 100 && entry <= 599),
        timeout_ms: clampTimeout(raw.timeout_ms, definition.timeout_ms || REQUEST_TIMEOUT_MS),
        optional: raw.optional === true
      };
    })
    .filter((step): step is CanaryStepConfig => !!step);
}

function severityFromStepStatuses(steps: CanaryStep[]): CanarySeverity {
  if (steps.some((step) => step.severity === "critical")) {
    return "critical";
  }
  if (steps.some((step) => step.severity === "warning")) {
    return "warning";
  }
  if (steps.length > 0 && steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
    return "healthy";
  }
  return "unknown";
}

function statusFromStepStatuses(steps: CanaryStep[]): CanaryStatus {
  if (steps.some((step) => step.status === "failed" && step.severity === "critical")) {
    return "failed";
  }
  if (steps.length > 0 && steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  if (steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
    return "succeeded";
  }
  return "failed";
}

async function createRun(definition: CanaryDefinition, triggerSource: string, requestId: string): Promise<CanaryRun> {
  const startedAt = new Date().toISOString();
  const response = await directusJson<DirectusItemResponse<CanaryRun>>("/items/runtime_canary_runs", {
    method: "POST",
    body: {
      definition_key: definition.key,
      trigger_source: triggerSource,
      status: "running",
      severity: "unknown",
      started_at: startedAt,
      summary: "Canary run started.",
      request_id: requestId,
      details_json: {},
      evidence_json: {}
    }
  });
  if (!response.data?.id) {
    throw new Error("Directus did not return a runtime canary run id");
  }
  return response.data;
}

async function updateRun(runId: string, patch: Partial<CanaryRun>): Promise<CanaryRun> {
  const response = await directusJson<DirectusItemResponse<CanaryRun>>(`/items/runtime_canary_runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    body: patch
  });
  if (!response.data) {
    throw new Error(`Directus did not return updated run ${runId}`);
  }
  return response.data;
}

async function createStep(step: CanaryStep): Promise<CanaryStep> {
  const response = await directusJson<DirectusItemResponse<CanaryStep>>("/items/runtime_canary_run_steps", {
    method: "POST",
    body: step
  });
  return response.data ?? step;
}

async function executeHttpStep(definition: CanaryDefinition, runId: string, stepConfig: CanaryStepConfig, sort: number): Promise<CanaryStep> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const expectedStatuses = stepConfig.expect_status && stepConfig.expect_status.length > 0 ? stepConfig.expect_status : [200];
  const headers: Record<string, string> = {};
  if (stepConfig.auth === "directus") {
    headers.authorization = `Bearer ${await directusToken()}`;
  }

  let step: CanaryStep;
  try {
    const result = await httpJson<unknown>(stepConfig.url ?? "", {
      method: httpMethod(stepConfig.method),
      headers,
      timeoutMs: stepConfig.timeout_ms ?? definition.timeout_ms ?? REQUEST_TIMEOUT_MS
    });
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    const ok = expectedStatuses.includes(result.statusCode);
    const body = asRecord(result.payload);
    step = {
      run_id: runId,
      definition_key: definition.key,
      step_key: stepConfig.key,
      name: stepConfig.name ?? stepConfig.key,
      status: ok ? "succeeded" : "failed",
      severity: ok ? "healthy" : stepConfig.optional ? "warning" : "critical",
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      summary: ok
        ? `HTTP ${result.statusCode}`
        : `Expected ${expectedStatuses.join(", ")} but received HTTP ${result.statusCode}`,
      details_json: {
        url: stepConfig.url,
        method: stepConfig.method,
        expected_status: expectedStatuses,
        actual_status: result.statusCode,
        response: body ?? truncate(result.text, 2000)
      },
      sort
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    step = {
      run_id: runId,
      definition_key: definition.key,
      step_key: stepConfig.key,
      name: stepConfig.name ?? stepConfig.key,
      status: "failed",
      severity: stepConfig.optional ? "warning" : "critical",
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Date.now() - started,
      summary: "Step request failed.",
      details_json: {
        url: stepConfig.url,
        method: stepConfig.method,
        expected_status: expectedStatuses
      },
      error: error instanceof Error ? truncate(error.message, 2000) : "Unknown step failure",
      sort
    };
  }

  return createStep(step);
}

async function runDefinition(definition: CanaryDefinition, triggerSource: string, requestId: string): Promise<CanaryRunResult> {
  const latest = await latestRunForDefinition(definition.key);
  if (latest?.status === "running") {
    return {
      run: {
        ...latest,
        status: "skipped",
        severity: "warning",
        summary: "A previous run is still active; this request was skipped.",
        completed_at: new Date().toISOString()
      },
      steps: []
    };
  }

  if (triggerSource !== "manual" && latest?.started_at) {
    const ageSeconds = Math.floor((Date.now() - new Date(latest.started_at).getTime()) / 1000);
    if (ageSeconds >= 0 && ageSeconds < definition.max_frequency_seconds) {
      return {
        run: {
          id: latest.id,
          definition_key: definition.key,
          trigger_source: triggerSource,
          status: "skipped",
          severity: "healthy",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          summary: `Skipped; latest run is ${ageSeconds}s old and cooldown is ${definition.max_frequency_seconds}s.`,
          details_json: { latest_run_id: latest.id, latest_started_at: latest.started_at },
          evidence_json: {},
          request_id: requestId
        },
        steps: []
      };
    }
  }

  if (triggerSource !== "schedule" && definition.impact_level !== "low" && !DEFAULT_MANUAL_HIGH_IMPACT_ALLOWED) {
    return {
      run: {
        id: randomUUID(),
        definition_key: definition.key,
        trigger_source: triggerSource,
        status: "skipped",
        severity: "warning",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 0,
        summary: "Run skipped because this canary is not low impact.",
        details_json: { impact_level: definition.impact_level },
        evidence_json: {},
        request_id: requestId
      },
      steps: []
    };
  }

  let run: CanaryRun;
  try {
    run = await createRun(definition, triggerSource, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create run";
    if (message.includes("runtime_canary_runs_active_unique") || message.toLowerCase().includes("duplicate")) {
      const active = await latestRunForDefinition(definition.key);
      return {
        run: {
          ...(active ?? {
            id: randomUUID(),
            definition_key: definition.key,
            trigger_source: triggerSource,
            status: "skipped" as CanaryStatus,
            severity: "warning" as CanarySeverity,
            started_at: new Date().toISOString()
          }),
          status: "skipped",
          severity: "warning",
          completed_at: new Date().toISOString(),
          summary: "A run became active before this request could start; this request was skipped.",
          request_id: requestId
        },
        steps: []
      };
    }
    throw error;
  }
  const started = new Date(run.started_at).getTime();
  const stepConfigs = getStepConfigs(definition);
  const steps: CanaryStep[] = [];
  for (let i = 0; i < stepConfigs.length; i += 1) {
    steps.push(await executeHttpStep(definition, run.id, stepConfigs[i], i + 1));
  }

  const status = statusFromStepStatuses(steps);
  const severity = severityFromStepStatuses(steps);
  const completedAt = new Date().toISOString();
  const failedSteps = steps.filter((step) => step.status === "failed");
  const summary = status === "succeeded"
    ? `All ${steps.length} checks passed.`
    : `${failedSteps.length} of ${steps.length} checks failed.`;
  const updatedRun = await updateRun(run.id, {
    status,
    severity,
    completed_at: completedAt,
    duration_ms: Math.max(0, Date.now() - started),
    summary,
    details_json: {
      step_count: steps.length,
      failed_step_count: failedSteps.length,
      impact_level: definition.impact_level
    },
    evidence_json: {
      steps: steps.map((step) => ({
        key: step.step_key,
        status: step.status,
        severity: step.severity,
        summary: step.summary,
        duration_ms: step.duration_ms
      }))
    },
    error: failedSteps.map((step) => step.error || step.summary).filter(Boolean).join("; ") || null
  });
  return { run: updatedRun, steps };
}

async function buildSummary(): Promise<JsonRecord> {
  const definitions = await listDefinitions(true);
  const runs = await listRuns("", 250);
  const latestByDefinition = new Map<string, CanaryRun>();
  for (const run of runs) {
    if (!latestByDefinition.has(run.definition_key)) {
      latestByDefinition.set(run.definition_key, run);
    }
  }
  const items = definitions.map((definition) => ({
    definition,
    latest_run: latestByDefinition.get(definition.key) ?? null
  }));
  const enabledItems = items.filter((item) => item.definition.enabled);
  const critical = enabledItems.filter((item) => item.latest_run?.severity === "critical").length;
  const warning = enabledItems.filter((item) => item.latest_run?.severity === "warning").length;
  const healthy = enabledItems.filter((item) => item.latest_run?.severity === "healthy").length;
  return {
    ok: critical === 0,
    generated_at: new Date().toISOString(),
    counts: {
      definitions: definitions.length,
      enabled: enabledItems.length,
      healthy,
      warning,
      critical,
      unknown: Math.max(0, enabledItems.length - healthy - warning - critical)
    },
    items
  };
}

async function handleAction(input: JsonRecord): Promise<unknown> {
  const action = asString(input.action, "summary").toLowerCase();
  const definitionKey = asString(input.definition_key) || asString(input.definitionKey);
  const runId = asString(input.run_id) || asString(input.runId);
  const limit = Math.max(1, Math.min(250, Math.trunc(asNumber(input.limit, 100))));

  if (action === "definitions") {
    return { ok: true, definitions: await listDefinitions(input.include_disabled === true) };
  }
  if (action === "runs") {
    return { ok: true, runs: await listRuns(definitionKey, limit) };
  }
  if (action === "rundetail" || action === "run_detail") {
    if (!runId) {
      throw Object.assign(new Error("run_id is required"), { status: 400 });
    }
    const run = await getRun(runId);
    return { ok: !!run, run, steps: run ? await listRunSteps(run.id) : [] };
  }
  if (action === "trigger") {
    if (!definitionKey) {
      throw Object.assign(new Error("definition_key is required"), { status: 400 });
    }
    const definition = await getDefinition(definitionKey);
    if (!definition) {
      throw Object.assign(new Error(`Canary definition '${definitionKey}' was not found`), { status: 404 });
    }
    const requestedSource = asString(input.source, "manual").toLowerCase();
    const triggerSource = requestedSource === "flink" ? "flink" : "manual";
    const requestId = asString(input.request_id) || asString(input.requestId) || randomUUID();
    const result = await runDefinition(definition, triggerSource, requestId);
    return { ok: true, run: result.run, steps: result.steps, result };
  }

  return buildSummary();
}

async function enforceInternalAuth(req: Request): Promise<void> {
  const expected = await internalToken();
  if (!expected) {
    return;
  }
  const actual = asString(req.header("authorization"));
  if (actual !== `Bearer ${expected}`) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Runtime Status API",
    version: "1.0.0",
    description: "Canary definition, run history, and lightweight runtime status checks for internal operations."
  },
  servers: [{ url: OPENAPI_SERVER_URL }],
  paths: {
    "/healthz": {
      get: {
        operationId: "healthz",
        responses: { "200": { description: "Service process health" } }
      }
    },
    "/readyz": {
      get: {
        operationId: "readyz",
        responses: { "200": { description: "Service dependency readiness" }, "503": { description: "Dependency unavailable" } }
      }
    },
    "/hasura/actions/runtime-status": {
      post: {
        operationId: "hasuraFetchRuntimeStatus",
        summary: "Hasura action endpoint for runtime canary status",
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
                      action: { type: "string", enum: ["summary", "definitions", "runs", "run_detail", "trigger"] },
                      definition_key: { type: "string" },
                      run_id: { type: "string" },
                      source: { type: "string", enum: ["manual", "flink"] },
                      request_id: { type: "string" },
                      limit: { type: "integer" }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Runtime canary status payload" } }
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

app.get("/healthz", async (_req, res) => {
  res.status(200).json({ ok: true, service: "runtime-status-service", version: "1.0.0" });
});

app.get("/readyz", async (_req, res) => {
  try {
    const token = await directusToken();
    const result = await httpJson<unknown>(`${DIRECTUS_BASE_URL}${DIRECTUS_HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS
    });
    if (result.statusCode >= 400) {
      res.status(503).json({ ok: false, reason: "directus_health_failed", status: result.statusCode });
      return;
    }
    res.status(200).json({ ok: true, directus_base_url: DIRECTUS_BASE_URL, directus_health_path: DIRECTUS_HEALTH_PATH });
  } catch (error) {
    res.status(503).json({
      ok: false,
      reason: "runtime_status_dependency_failed",
      error: error instanceof Error ? truncate(error.message, 500) : "Unknown readiness error"
    });
  }
});

app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiSpec);
});

app.post("/hasura/actions/runtime-status", async (req, res, next) => {
  try {
    const envelope = asRecord(req.body) ?? {};
    const input = asRecord(envelope.input) ?? envelope;
    res.status(200).json(await handleAction(input));
  } catch (error) {
    next(error);
  }
});

app.post("/internal/canaries/run", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const body = asRecord(req.body) ?? {};
    const definitionKey = asString(body.definition_key) || asString(body.definitionKey);
    const source = asString(body.source, "schedule");
    const requestId = asString(body.request_id) || randomUUID();
    const definitions = definitionKey
      ? [await getDefinition(definitionKey)].filter((entry): entry is CanaryDefinition => !!entry)
      : await listDefinitions(false);
    const results: CanaryRunResult[] = [];
    for (const definition of definitions) {
      results.push(await runDefinition(definition, source, requestId));
    }
    res.status(200).json({ ok: true, request_id: requestId, results });
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
      status
    }
  });
});

app.listen(PORT, () => {
  console.log(`[runtime-status-service] listening on :${PORT}`);
});
