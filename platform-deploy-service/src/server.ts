import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent, Dispatcher, request as undiciRequest, setGlobalDispatcher } from "undici";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("8080"),
  TRUST_PROXY_HOPS: z.string().default("1"),
  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("120"),
  REQUEST_TIMEOUT_MS: z.string().default("10000"),
  DIRECTUS_BASE_URL: z.string().default("http://directus-service.directus.svc.cluster.local:8055"),
  DIRECTUS_HEALTH_PATH: z.string().default("/server/health"),
  DIRECTUS_STATIC_TOKEN: z.string().default(""),
  DIRECTUS_TOKEN_VAULT_PATH: z.string().default("secret/data/directus/gravitee/openapi/admin"),
  DIRECTUS_TOKEN_VAULT_KEY: z.string().default("token"),
  INTERNAL_TOKEN: z.string().default(""),
  INTERNAL_TOKEN_VAULT_PATH: z.string().default("secret/data/platform-deploy-service"),
  INTERNAL_TOKEN_VAULT_KEY: z.string().default("token"),
  VAULT_ADDR: z.string().default("http://vault.vault.svc.cluster.local:8200"),
  VAULT_TOKEN_FILE: z.string().default("/vault-secrets/vault-token"),
  TOKEN_CACHE_SECONDS: z.string().default("300"),
  OPENAPI_SERVER_URL: z.string().default("http://platform-deploy-service.directus.svc.cluster.local:8080"),
  KUBERNETES_NAMESPACE: z.string().default(""),
  KUBERNETES_TOKEN_FILE: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/token"),
  KUBERNETES_CA_FILE: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  KUBERNETES_NAMESPACE_FILE: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/namespace"),
  KUBERNETES_API_URL: z.string().default("https://kubernetes.default.svc"),
  DEPLOY_RUNNER_IMAGE: z.string().default("ghcr.io/dotcomrow/platform-app-deploy-runner:latest"),
  DEPLOY_RUNNER_SERVICE_ACCOUNT: z.string().default("platform-deploy-runner"),
  DEPLOY_SECRET_NAME: z.string().default("platform-deploy-secrets"),
  DEPLOY_STATE_PVC_NAME: z.string().default("platform-deploy-state"),
  DEPLOY_JOB_TTL_SECONDS: z.string().default("86400"),
  DEPLOY_JOB_ACTIVE_DEADLINE_SECONDS: z.string().default("3600"),
  DEPLOY_CALLBACK_BASE_URL: z.string().default("http://platform-deploy-service.directus.svc.cluster.local:8080"),
  DEFAULT_ORG_NAME: z.string().default("suncoast-systems")
});

const env = envSchema.parse(process.env);
const PORT = Math.max(1, Math.min(65535, Number(env.PORT) || 8080));
const RATE_WINDOW_MS = Math.max(1000, Number(env.RATE_WINDOW_MS) || 60_000);
const RATE_MAX = Math.max(1, Number(env.RATE_MAX) || 120);
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(env.REQUEST_TIMEOUT_MS) || 10_000);
const DIRECTUS_BASE_URL = env.DIRECTUS_BASE_URL.replace(/\/+$/, "");
const DIRECTUS_HEALTH_PATH = env.DIRECTUS_HEALTH_PATH.startsWith("/")
  ? env.DIRECTUS_HEALTH_PATH
  : `/${env.DIRECTUS_HEALTH_PATH}`;
const VAULT_ADDR = env.VAULT_ADDR.replace(/\/+$/, "");
const TOKEN_CACHE_SECONDS = Math.max(5, Number(env.TOKEN_CACHE_SECONDS) || 300);
const KUBERNETES_API_URL = env.KUBERNETES_API_URL.replace(/\/+$/, "");
const DEPLOY_JOB_TTL_SECONDS = Math.max(60, Number(env.DEPLOY_JOB_TTL_SECONDS) || 86_400);
const DEPLOY_JOB_ACTIVE_DEADLINE_SECONDS = Math.max(300, Number(env.DEPLOY_JOB_ACTIVE_DEADLINE_SECONDS) || 3600);

type JsonRecord = Record<string, unknown>;
type OperationType = "create" | "update" | "redeploy" | "delete" | "destroy";
type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type DeploymentStatus = "not_deployed" | "queued" | "deploying" | "deployed" | "failed" | "destroying" | "destroyed";

type DirectusListResponse<T> = {
  data?: T[];
};

type DirectusItemResponse<T> = {
  data?: T;
};

type PlatformOrganization = {
  id: string;
  organization_key?: string | null;
  name?: string | null;
  default_domain?: string | null;
  settings_json?: JsonRecord | null;
};

type PlatformApp = {
  id: string;
  organization_id?: string | PlatformOrganization | null;
  app_key: string;
  display_name?: string | null;
  site_key: string;
  keycloak_realm: "internal" | "external";
  domain?: string | null;
  production_hostname?: string | null;
  preview_hostname?: string | null;
  production_url?: string | null;
  preview_url?: string | null;
  app_auth_slug_production?: string | null;
  app_auth_slug_preview?: string | null;
  terraform_workspace_production?: string | null;
  terraform_workspace_preview?: string | null;
  terraform_project?: string | null;
  template_source_repo?: string | null;
  template_ref?: string | null;
  config_json?: JsonRecord | null;
};

type PlatformOperation = {
  id: string;
  app_id: string;
  operation_type: OperationType;
  status: OperationStatus;
};

type VaultCacheEntry = {
  expiresAt: number;
  value: string;
};

const vaultCache = new Map<string, VaultCacheEntry>();
let kubernetesDispatcher: Agent | null = null;

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000
  })
);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, max = 1200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  const root = asRecord(payload);
  const directError = asString(root?.error);
  if (directError) return directError;
  const errors = Array.isArray(root?.errors) ? root?.errors : [];
  const firstError = asRecord(errors[0]);
  const firstMessage = asString(firstError?.message);
  if (firstMessage) return firstMessage;
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
    dispatcher?: Dispatcher;
  } = {}
): Promise<{ statusCode: number; payload: T; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await undiciRequest(url, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {})
      },
      dispatcher: init.dispatcher,
      signal: controller.signal
    });
    const text = await response.body.text();
    const payload = await parseJsonResponse(text);
    return { statusCode: response.statusCode, payload: payload as T, text };
  } finally {
    clearTimeout(timer);
  }
}

async function vaultToken(): Promise<string> {
  const token = await readFile(env.VAULT_TOKEN_FILE, "utf8");
  return token.trim();
}

async function vaultValue(path: string, key: string): Promise<string> {
  const cacheKey = `${path}#${key}`;
  const cached = vaultCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const token = await vaultToken();
  const normalizedPath = path.replace(/^\/+/, "").replace(/^v1\//, "");
  const result = await httpJson<JsonRecord>(`${VAULT_ADDR}/v1/${normalizedPath}`, {
    headers: { "x-vault-token": token },
    timeoutMs: REQUEST_TIMEOUT_MS
  });
  if (result.statusCode >= 400) {
    throw new Error(`Vault read ${path} failed: ${result.statusCode} ${truncate(result.text, 500)}`);
  }

  const payload = asRecord(result.payload) ?? {};
  const data = asRecord(payload.data) ?? {};
  const nested = asRecord(data.data);
  const value = asString((nested ?? data)[key]);
  if (!value) {
    throw new Error(`Vault read ${path} did not return key ${key}`);
  }
  vaultCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + TOKEN_CACHE_SECONDS * 1000
  });
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
  const result = await httpJson<unknown>(`${DIRECTUS_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    timeoutMs: init.timeoutMs ?? REQUEST_TIMEOUT_MS,
    headers: { authorization: `Bearer ${token}` }
  });
  if (result.statusCode >= 400) {
    throw new Error(`Directus ${init.method ?? "GET"} ${path} failed: ${result.statusCode} ${truncate(extractErrorMessage(result.payload, result.text), 700)}`);
  }
  return result.payload as T;
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

async function getApp(appId: string): Promise<PlatformApp> {
  const fields = [
    "id",
    "organization_id.id",
    "organization_id.organization_key",
    "organization_id.name",
    "organization_id.default_domain",
    "organization_id.settings_json",
    "app_key",
    "display_name",
    "site_key",
    "keycloak_realm",
    "domain",
    "production_hostname",
    "preview_hostname",
    "production_url",
    "preview_url",
    "app_auth_slug_production",
    "app_auth_slug_preview",
    "terraform_workspace_production",
    "terraform_workspace_preview",
    "terraform_project",
    "template_source_repo",
    "template_ref",
    "config_json"
  ].join(",");
  const response = await directusJson<DirectusItemResponse<PlatformApp>>(`/items/platform_apps/${encodeURIComponent(appId)}${queryString({ fields })}`);
  if (!response.data?.id) {
    throw Object.assign(new Error(`Platform app ${appId} was not found`), { status: 404 });
  }
  return response.data;
}

async function createOperation(app: PlatformApp, operationType: OperationType, inputJson: JsonRecord): Promise<PlatformOperation> {
  const response = await directusJson<DirectusItemResponse<PlatformOperation>>("/items/platform_app_operations", {
    method: "POST",
    body: {
      id: randomUUID(),
      app_id: app.id,
      operation_type: operationType,
      status: "queued",
      execution_provider: "local_terraform",
      requested_at: new Date().toISOString(),
      terraform_workspace: app.terraform_workspace_production || app.app_key,
      input_json: inputJson,
      result_json: {}
    }
  });
  if (!response.data?.id) {
    throw new Error("Directus did not return a platform operation id");
  }
  return response.data;
}

async function updateOperation(operationId: string, patch: JsonRecord): Promise<void> {
  await directusJson<DirectusItemResponse<PlatformOperation>>(`/items/platform_app_operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    body: patch
  });
}

async function updateApp(appId: string, patch: JsonRecord): Promise<void> {
  await directusJson<DirectusItemResponse<PlatformApp>>(`/items/platform_apps/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    body: patch
  });
}

function organizationFromApp(app: PlatformApp): PlatformOrganization | null {
  return asRecord(app.organization_id) as PlatformOrganization | null;
}

function settingsFromApp(app: PlatformApp): JsonRecord {
  const organization = organizationFromApp(app);
  const orgSettings = asRecord(organization?.settings_json) ?? {};
  const appConfig = asRecord(app.config_json) ?? {};
  const deployment = asRecord(appConfig.deployment) ?? {};
  return {
    ...orgSettings,
    deployment: {
      ...(asRecord(orgSettings.deployment) ?? {}),
      ...(asRecord(deployment) ?? {})
    },
    template: {
      ...(asRecord(orgSettings.template) ?? {}),
      ...(asRecord(deployment.template) ?? {})
    }
  };
}

function deploymentSettings(app: PlatformApp): JsonRecord {
  return asRecord(settingsFromApp(app).deployment) ?? {};
}

function templateSettings(app: PlatformApp): JsonRecord {
  return asRecord(settingsFromApp(app).template) ?? {};
}

function domainFor(app: PlatformApp): string {
  return asString(app.domain)
    || asString(organizationFromApp(app)?.default_domain)
    || asString(deploymentSettings(app).baseDomain, "suncoast.systems");
}

function productionHostname(app: PlatformApp): string {
  return asString(app.production_hostname, `${app.app_key}.${domainFor(app)}`);
}

function previewHostname(app: PlatformApp): string {
  return asString(app.preview_hostname, `${app.app_key}-preview.${domainFor(app)}`);
}

function productionUrl(app: PlatformApp): string {
  return asString(app.production_url, `https://${productionHostname(app)}`);
}

function previewUrl(app: PlatformApp): string {
  return asString(app.preview_url, `https://${previewHostname(app)}`);
}

function templateRepository(app: PlatformApp): string {
  return asString(app.template_source_repo) || asString(templateSettings(app).repository);
}

function templateProdRef(app: PlatformApp): string {
  return asString(app.template_ref) || asString(templateSettings(app).prodRef, "prod");
}

function templatePreviewRef(app: PlatformApp): string {
  return asString(templateSettings(app).previewRef, "dev");
}

function keycloakAuthHost(app: PlatformApp): string {
  return asString(deploymentSettings(app).keycloakAuthHost, "auth-origin.suncoast.systems");
}

function authGatewayUrl(app: PlatformApp): string {
  return asString(deploymentSettings(app).appAuthGatewayUrl);
}

function authGatewayAdminUrl(app: PlatformApp): string {
  return asString(deploymentSettings(app).appAuthGatewayAdminUrl);
}

function terraformProject(app: PlatformApp): string {
  return asString(app.terraform_project) || asString(deploymentSettings(app).terraformProject);
}

function operationSequence(operationType: OperationType): string {
  if (operationType === "delete" || operationType === "destroy") {
    return "destroy";
  }
  if (operationType === "update" || operationType === "redeploy") {
    return "recreate";
  }
  return "create";
}

function buildRunnerInput(app: PlatformApp, operationType: OperationType, operationId: string): JsonRecord {
  const sequence = operationSequence(operationType);
  return {
    operation_id: operationId,
    operation_type: operationType,
    sequence,
    app_id: app.id,
    app_key: app.app_key,
    site_key: app.site_key,
    keycloak_realm: app.keycloak_realm,
    domain: domainFor(app),
    production_hostname: productionHostname(app),
    preview_hostname: previewHostname(app),
    production_url: productionUrl(app),
    preview_url: previewUrl(app),
    template_repository: templateRepository(app),
    template_prod_ref: templateProdRef(app),
    template_preview_ref: templatePreviewRef(app),
    terraform_project: terraformProject(app),
    keycloak_auth_host: keycloakAuthHost(app),
    app_auth_gateway_url: authGatewayUrl(app),
    app_auth_gateway_admin_url: authGatewayAdminUrl(app),
    app_auth_slug_production: asString(app.app_auth_slug_production, app.app_key),
    app_auth_slug_preview: asString(app.app_auth_slug_preview, `${app.app_key}-preview`),
    terraform_workspace_production: asString(app.terraform_workspace_production, app.app_key),
    terraform_workspace_preview: asString(app.terraform_workspace_preview, `${app.app_key}-preview`)
  };
}

async function kubernetesNamespace(): Promise<string> {
  if (env.KUBERNETES_NAMESPACE) {
    return env.KUBERNETES_NAMESPACE;
  }
  return (await readFile(env.KUBERNETES_NAMESPACE_FILE, "utf8")).trim();
}

async function kubernetesToken(): Promise<string> {
  return (await readFile(env.KUBERNETES_TOKEN_FILE, "utf8")).trim();
}

async function kubernetesAgent(): Promise<Agent> {
  if (kubernetesDispatcher) {
    return kubernetesDispatcher;
  }
  const ca = await readFile(env.KUBERNETES_CA_FILE, "utf8");
  kubernetesDispatcher = new Agent({
    connect: {
      ca
    }
  });
  return kubernetesDispatcher;
}

async function kubernetesJson<T>(path: string, init: { method?: Dispatcher.HttpMethod; body?: unknown } = {}): Promise<T> {
  const token = await kubernetesToken();
  const result = await httpJson<T>(`${KUBERNETES_API_URL}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    dispatcher: await kubernetesAgent(),
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  if (result.statusCode >= 400) {
    throw new Error(`Kubernetes ${init.method ?? "GET"} ${path} failed: ${result.statusCode} ${truncate(result.text, 1000)}`);
  }
  return result.payload;
}

function safeJobName(appKey: string, operationId: string): string {
  const suffix = operationId.replace(/-/g, "").slice(0, 10);
  const base = `platform-app-${appKey}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base.slice(0, Math.max(1, 52 - suffix.length))}-${suffix}`;
}

function envValue(name: string, value: unknown): JsonRecord {
  return { name, value: String(value ?? "") };
}

function secretEnv(name: string, key: string): JsonRecord {
  return {
    name,
    valueFrom: {
      secretKeyRef: {
        name: env.DEPLOY_SECRET_NAME,
        key,
        optional: true
      }
    }
  };
}

async function createDeployJob(app: PlatformApp, operation: PlatformOperation, input: JsonRecord): Promise<string> {
  const namespace = await kubernetesNamespace();
  const jobName = safeJobName(app.app_key, operation.id);
  const callbackBaseUrl = env.DEPLOY_CALLBACK_BASE_URL.replace(/\/+$/, "");

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels: {
        app: "platform-app-deploy-runner",
        "platform.suncoast.systems/app-id": app.id,
        "platform.suncoast.systems/operation-id": operation.id
      }
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: DEPLOY_JOB_TTL_SECONDS,
      activeDeadlineSeconds: DEPLOY_JOB_ACTIVE_DEADLINE_SECONDS,
      template: {
        metadata: {
          labels: {
            app: "platform-app-deploy-runner",
            "platform.suncoast.systems/app-id": app.id,
            "platform.suncoast.systems/operation-id": operation.id
          }
        },
        spec: {
          serviceAccountName: env.DEPLOY_RUNNER_SERVICE_ACCOUNT,
          restartPolicy: "Never",
          containers: [
            {
              name: "runner",
              image: env.DEPLOY_RUNNER_IMAGE,
              imagePullPolicy: "Always",
              command: ["/bin/sh", "/runner/run.sh"],
              env: [
                envValue("APP_ID", app.id),
                envValue("APP_KEY", app.app_key),
                envValue("OPERATION_ID", operation.id),
                envValue("OPERATION_TYPE", operation.operation_type),
                envValue("DEPLOY_SEQUENCE", input.sequence),
                envValue("SITE_KEY", app.site_key),
                envValue("KEYCLOAK_REALM", app.keycloak_realm),
                envValue("DOMAIN", input.domain),
                envValue("PRODUCTION_HOSTNAME", input.production_hostname),
                envValue("PREVIEW_HOSTNAME", input.preview_hostname),
                envValue("PRODUCTION_URL", input.production_url),
                envValue("PREVIEW_URL", input.preview_url),
                envValue("TEMPLATE_REPOSITORY", input.template_repository),
                envValue("TEMPLATE_PROD_REF", input.template_prod_ref),
                envValue("TEMPLATE_PREVIEW_REF", input.template_preview_ref),
                envValue("TERRAFORM_PROJECT", input.terraform_project),
                envValue("KEYCLOAK_AUTH_HOST", input.keycloak_auth_host),
                envValue("APP_AUTH_GATEWAY_URL", input.app_auth_gateway_url),
                envValue("APP_AUTH_GATEWAY_ADMIN_URL", input.app_auth_gateway_admin_url),
                envValue("APP_AUTH_APP_SLUG_PRODUCTION", input.app_auth_slug_production),
                envValue("APP_AUTH_APP_SLUG_PREVIEW", input.app_auth_slug_preview),
                envValue("TERRAFORM_WORKSPACE_PRODUCTION", input.terraform_workspace_production),
                envValue("TERRAFORM_WORKSPACE_PREVIEW", input.terraform_workspace_preview),
                envValue("PLATFORM_DEPLOY_CALLBACK_URL", callbackBaseUrl),
                secretEnv("PLATFORM_DEPLOY_SERVICE_TOKEN", "service-token"),
                secretEnv("CLOUDFLARE_API_TOKEN", "cloudflare-api-token"),
                secretEnv("CLOUDFLARE_ACCOUNT_ID", "cloudflare-account-id"),
                secretEnv("CLOUDFLARE_ZONE_ID", "cloudflare-zone-id"),
                secretEnv("DIRECTUS_GRAPHQL_ENDPOINT", "directus-graphql-endpoint"),
                secretEnv("APP_AUTH_GATEWAY_ADMIN_TOKEN", "app-auth-gateway-admin-token"),
                secretEnv("VAULT_ADDR", "vault-addr"),
                secretEnv("VAULT_TOKEN", "vault-token")
              ],
              volumeMounts: [
                { name: "runner-script", mountPath: "/runner", readOnly: true },
                { name: "deploy-state", mountPath: "/state" },
                { name: "workspace", mountPath: "/workspace" }
              ],
              resources: {
                requests: { cpu: "250m", memory: "768Mi" },
                limits: { cpu: "2", memory: "3Gi" }
              }
            }
          ],
          volumes: [
            { name: "runner-script", configMap: { name: "platform-app-deploy-runner", defaultMode: 493 } },
            { name: "deploy-state", persistentVolumeClaim: { claimName: env.DEPLOY_STATE_PVC_NAME } },
            { name: "workspace", emptyDir: {} }
          ]
        }
      }
    }
  };

  await kubernetesJson(`/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, {
    method: "POST",
    body: job
  });
  return jobName;
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

function operationTypeFromBody(body: JsonRecord, fallback: OperationType): OperationType {
  const value = asString(body.operation_type) || asString(body.operationType);
  if (value === "create" || value === "update" || value === "redeploy" || value === "delete" || value === "destroy") {
    return value;
  }
  return fallback;
}

async function queueOperation(appId: string, operationType: OperationType): Promise<JsonRecord> {
  const app = await getApp(appId);
  const templateRepo = templateRepository(app);
  if (!templateRepo) {
    throw Object.assign(new Error("App template repository is not configured."), { status: 422 });
  }

  const operationInput = buildRunnerInput(app, operationType, "pending");
  const operation = await createOperation(app, operationType, operationInput);
  const input = buildRunnerInput(app, operationType, operation.id);
  await updateOperation(operation.id, { input_json: input });

  const queuedStatus: DeploymentStatus = operationSequence(operationType) === "destroy" ? "destroying" : "queued";
  await updateApp(app.id, {
    deployment_status: queuedStatus,
    last_error: null
  });

  try {
    const jobName = await createDeployJob(app, operation, input);
    await updateOperation(operation.id, {
      result_json: {
        job_name: jobName,
        namespace: await kubernetesNamespace()
      }
    });
    return { ok: true, app_id: app.id, operation_id: operation.id, job_name: jobName };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create deploy job.";
    await updateOperation(operation.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message
    });
    await updateApp(app.id, {
      deployment_status: "failed",
      last_error: message
    });
    throw error;
  }
}

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Platform Deploy API",
    version: "1.0.0",
    description: "Internal Kubernetes control plane for Directus-managed shell app deployments."
  },
  servers: [{ url: env.OPENAPI_SERVER_URL }],
  paths: {
    "/healthz": { get: { operationId: "healthz", responses: { "200": { description: "Service health" } } } },
    "/readyz": { get: { operationId: "readyz", responses: { "200": { description: "Dependency readiness" } } } },
    "/internal/apps/{id}/deploy": { post: { operationId: "queueDeploy", responses: { "200": { description: "Deploy queued" } } } },
    "/internal/apps/{id}/destroy": { post: { operationId: "queueDestroy", responses: { "200": { description: "Destroy queued" } } } }
  }
};

const app = express();
app.set("trust proxy", Math.max(0, Number(env.TRUST_PROXY_HOPS) || 1));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "512kb" }));
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: RATE_WINDOW_MS, limit: RATE_MAX, standardHeaders: "draft-7", legacyHeaders: false }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, service: "platform-deploy-service", version: "1.0.0" });
});

app.get("/readyz", async (_req, res) => {
  try {
    const token = await directusToken();
    const namespace = await kubernetesNamespace();
    const result = await httpJson<unknown>(`${DIRECTUS_BASE_URL}${DIRECTUS_HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS
    });
    if (result.statusCode >= 400) {
      res.status(503).json({ ok: false, reason: "directus_health_failed", status: result.statusCode });
      return;
    }
    res.status(200).json({ ok: true, namespace, directus_base_url: DIRECTUS_BASE_URL });
  } catch (error) {
    res.status(503).json({
      ok: false,
      reason: "platform_deploy_dependency_failed",
      error: error instanceof Error ? truncate(error.message, 500) : "Unknown readiness error"
    });
  }
});

app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiSpec);
});

app.post("/internal/apps/:id/deploy", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const body = asRecord(req.body) ?? {};
    const result = await queueOperation(req.params.id, operationTypeFromBody(body, "redeploy"));
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/internal/apps/:id/destroy", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const body = asRecord(req.body) ?? {};
    const result = await queueOperation(req.params.id, operationTypeFromBody(body, "destroy"));
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/internal/operations/:id/start", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const body = asRecord(req.body) ?? {};
    const appId = asString(body.app_id);
    const operationType = operationTypeFromBody(body, "redeploy");
    await updateOperation(req.params.id, {
      status: "running",
      started_at: new Date().toISOString()
    });
    if (appId) {
      await updateApp(appId, {
        deployment_status: operationSequence(operationType) === "destroy" ? "destroying" : "deploying",
        last_error: null
      });
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/operations/:id/finish", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const body = asRecord(req.body) ?? {};
    const appId = asString(body.app_id);
    const operationType = operationTypeFromBody(body, "redeploy");
    const succeeded = asString(body.status) === "succeeded";
    const deploymentStatus: DeploymentStatus = succeeded
      ? operationSequence(operationType) === "destroy" ? "destroyed" : "deployed"
      : "failed";
    const errorMessage = asString(body.error_message);
    await updateOperation(req.params.id, {
      status: succeeded ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      result_json: asRecord(body.result_json) ?? {},
      error_message: errorMessage || null,
      log_excerpt: asString(body.log_excerpt) || null
    });
    if (appId) {
      await updateApp(appId, {
        deployment_status: deploymentStatus,
        last_deployed_at: succeeded && deploymentStatus === "deployed" ? new Date().toISOString() : undefined,
        last_error: succeeded ? null : errorMessage || "Deployment failed."
      });
    }
    res.status(200).json({ ok: true });
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
  console.log(`[platform-deploy-service] listening on :${PORT}`);
});
