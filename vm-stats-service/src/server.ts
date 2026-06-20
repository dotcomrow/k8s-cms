import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, request as undiciRequest, setGlobalDispatcher } from "undici";
import type { IncomingHttpHeaders } from "http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * -----------------------------
 * Env configuration & parsing
 * -----------------------------
 */
const envSchema = z.object({
  PORT: z.string().default("8080"),

  REQUIRE_API_KEY: z.string().default("false"),
  API_KEY: z.string().optional(),

  ALLOWLIST_ORGS: z.string().default(""),

  GROUP_FORMAT: z.enum(["org:team", "org/team", "team"]).default("org:team"),
  GROUP_PREFIX: z.string().default(""),
  INCLUDE_ORG_AS_GROUP: z.string().default("false"),
  INCLUDE_ROLE_SUFFIX: z.string().default("false"),

  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("60"),
  TIMEOUT_MS: z.string().default("8000"),
  REPORTING_ENABLED: z.string().default("false"),
  REPORTING_REQUIRE_API_KEY: z.string().default("true"),
  REPORTING_SSH_HOST: z.string().default(""),
  REPORTING_SSH_PORT: z.string().default("22"),
  REPORTING_SSH_USER: z.string().default("opc"),
  REPORTING_SSH_KEY_PATH: z.string().default(""),
  REPORTING_SSH_KEY: z.string().default(""),
  REPORTING_STRICT_HOST_KEY: z.string().default("false"),
  REPORTING_COMMAND_TIMEOUT_MS: z.string().default("25000"),
  REPORTING_CONNECT_TIMEOUT_MS: z.string().default("12000"),
  REPORTING_STORAGE_WARNING_PERCENT: z.string().default("80"),
  REPORTING_STORAGE_CRITICAL_PERCENT: z.string().default("90"),
  REPORTING_SYSTEM_ID: z.string().default("oracle-db"),
  REPORTING_DEFAULT_PROCESS_LIMIT: z.string().default("25"),
  REPORTING_MAX_PROCESS_LIMIT: z.string().default("100"),
  REPORTING_DEFAULT_LOG_LINES: z.string().default("200"),
  REPORTING_MAX_LOG_LINES: z.string().default("1200"),
  REPORTING_DEFAULT_SESSIONS_LIMIT: z.string().default("75"),
  REPORTING_MAX_SESSIONS_LIMIT: z.string().default("250"),
  REPORTING_DB_HOST: z.string().default("127.0.0.1"),
  REPORTING_DB_PORT: z.string().default("5432"),
  REPORTING_DB_NAME: z.string().default("directus"),
  REPORTING_DB_USER: z.string().default("postgres"),
  REPORTING_DB_PASSWORD: z.string().default(""),
  SERVICE_MODE: z.enum(["stats"]).default("stats"),
  OPENAPI_SERVER_URL: z.string().default("/"),

  // pagination control for “fetch as much as possible”
  MAX_PAGES: z.string().default("2"),     // how many pages to follow at most
  PER_PAGE: z.string().default("100"),    // items per page

  GITHUB_API_BASE: z.string().default("https://api.github.com"),

  // reverse-proxy trust depth (Cloud Run should be >= 1)
  TRUST_PROXY_HOPS: z.string().default("1")
});

const env = envSchema.parse(process.env);

const toBool = (v: string | undefined) => String(v || "").toLowerCase() === "true";
const splitCSV = (v: string | undefined) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const REQUIRE_API_KEY = toBool(env.REQUIRE_API_KEY);
const REPORTING_ENABLED = toBool(env.REPORTING_ENABLED);
const REPORTING_REQUIRE_API_KEY = toBool(env.REPORTING_REQUIRE_API_KEY);
const REPORTING_SSH_HOST = env.REPORTING_SSH_HOST.trim();
const REPORTING_SSH_PORT = Math.max(1, Math.min(65535, Number(env.REPORTING_SSH_PORT) || 22));
const REPORTING_SSH_USER = env.REPORTING_SSH_USER.trim() || "opc";
const REPORTING_SSH_KEY_PATH = env.REPORTING_SSH_KEY_PATH.trim();
const REPORTING_SSH_KEY = env.REPORTING_SSH_KEY.trim();
const REPORTING_STRICT_HOST_KEY = toBool(env.REPORTING_STRICT_HOST_KEY);
const REPORTING_COMMAND_TIMEOUT_MS = Math.max(1_000, Number(env.REPORTING_COMMAND_TIMEOUT_MS) || 25_000);
const REPORTING_CONNECT_TIMEOUT_MS = Math.max(1_000, Number(env.REPORTING_CONNECT_TIMEOUT_MS) || 12_000);
const REPORTING_STORAGE_WARNING_PERCENT = Math.min(99, Math.max(0, Number(env.REPORTING_STORAGE_WARNING_PERCENT) || 80));
const REPORTING_STORAGE_CRITICAL_PERCENT = Math.min(99, Math.max(0, Number(env.REPORTING_STORAGE_CRITICAL_PERCENT) || 90));
const REPORTING_SYSTEM_ID = env.REPORTING_SYSTEM_ID.trim() || "oracle-db";
const REPORTING_DEFAULT_PROCESS_LIMIT = Math.max(5, Math.min(500, Number(env.REPORTING_DEFAULT_PROCESS_LIMIT) || 25));
const REPORTING_MAX_PROCESS_LIMIT = Math.max(
  REPORTING_DEFAULT_PROCESS_LIMIT,
  Math.min(1000, Number(env.REPORTING_MAX_PROCESS_LIMIT) || 100)
);
const REPORTING_DEFAULT_LOG_LINES = Math.max(50, Math.min(2000, Number(env.REPORTING_DEFAULT_LOG_LINES) || 200));
const REPORTING_MAX_LOG_LINES = Math.max(REPORTING_DEFAULT_LOG_LINES, Math.min(5_000, Number(env.REPORTING_MAX_LOG_LINES) || 1200));
const REPORTING_DEFAULT_SESSIONS_LIMIT = Math.max(10, Math.min(500, Number(env.REPORTING_DEFAULT_SESSIONS_LIMIT) || 75));
const REPORTING_MAX_SESSIONS_LIMIT = Math.max(
  REPORTING_DEFAULT_SESSIONS_LIMIT,
  Math.min(1_000, Number(env.REPORTING_MAX_SESSIONS_LIMIT) || 250)
);
const REPORTING_DB_HOST = env.REPORTING_DB_HOST.trim() || "127.0.0.1";
const REPORTING_DB_PORT = Math.max(1, Math.min(65535, Number(env.REPORTING_DB_PORT) || 5432));
const REPORTING_DB_NAME = env.REPORTING_DB_NAME.trim() || "directus";
const REPORTING_DB_USER = env.REPORTING_DB_USER.trim() || "postgres";
const REPORTING_DB_PASSWORD = env.REPORTING_DB_PASSWORD;
const SERVICE_MODE = env.SERVICE_MODE;
const IS_STATS_SERVICE = true;
const OPENAPI_SERVER_URL = env.OPENAPI_SERVER_URL.trim() || "/";
const INCLUDE_ORG_AS_GROUP = toBool(env.INCLUDE_ORG_AS_GROUP);
const INCLUDE_ROLE_SUFFIX = toBool(env.INCLUDE_ROLE_SUFFIX);
const ALLOWED_ORGS = new Set(splitCSV(env.ALLOWLIST_ORGS));
const PER_PAGE = Math.max(1, Math.min(100, Number(env.PER_PAGE) || 100));
const MAX_PAGES = Math.max(1, Math.min(10, Number(env.MAX_PAGES) || 2));

/**
 * -----------------------------
 * Types
 * -----------------------------
 */
type GitHubEmail = { email: string; primary?: boolean; verified?: boolean; visibility?: string | null };
type GitHubTeam = {
  name: string;
  slug: string;
  organization: { login: string };
  role?: "member" | "maintainer";
};
type GitHubOrg = {
  login: string;
  id: number;
  avatar_url?: string;
  url?: string;
};
type GitHubOrgMembership = {
  organization: GitHubOrg;
  state: "active" | "pending";
  role: "member" | "admin";
};
type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  html_url: string;
  language?: string | null;
  pushed_at?: string | null;
  updated_at?: string | null;
  permissions?: Record<string, boolean>;
};
type GitHubUser = {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  html_url?: string;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  bio?: string | null;
  twitter_username?: string | null;
  created_at?: string;
  updated_at?: string;
};

type HeaderBag = { get(name: string): string | undefined };

/**
 * -----------------------------
 * HTTP client setup
 * -----------------------------
 */
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000
  })
);

function toHeaderBag(h: IncomingHttpHeaders): HeaderBag {
  return {
    get(name: string) {
      const val = h[name.toLowerCase()];
      if (Array.isArray(val)) return val[0];
      if (typeof val === "number") return String(val);
      return val ?? undefined;
    }
  };
}

/**
 * Low-level GitHub GET
 */
async function ghGet<T>(
  pathOrAbsoluteUrl: string,
  token: string,
  signal: AbortSignal
): Promise<{ data: T; headers: HeaderBag }> {
  const url =
    pathOrAbsoluteUrl.startsWith("http://") || pathOrAbsoluteUrl.startsWith("https://")
      ? pathOrAbsoluteUrl
      : `${env.GITHUB_API_BASE}${pathOrAbsoluteUrl}`;

  const { statusCode, body, headers } = await undiciRequest(url, {
    method: "GET",
    headers: {
      "User-Agent": "vm-stats-service/1.0",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal
  });

  const text = await body.text();

  if (statusCode >= 400) {
    const err = new Error(`GitHub API GET ${url} failed: ${statusCode} ${text}`);
    (err as any).status = statusCode === 401 || statusCode === 403 ? 401 : 502;
    throw err;
  }

  const hb = toHeaderBag(headers);

  try {
    return { data: JSON.parse(text) as T, headers: hb };
  } catch {
    const err = new Error(`GitHub API ${url} returned non-JSON`);
    (err as any).status = 502;
    throw err;
  }
}

/**
 * Parse Link header for pagination “next”
 */
function parseNextLink(linkHeader?: string): string | undefined {
  if (!linkHeader) return undefined;
  // format: <https://...&page=2>; rel="next", <...>; rel="last"
  const parts = linkHeader.split(",").map((s) => s.trim());
  for (const p of parts) {
    const m = p.match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (m && m[2] === "next") return m[1];
  }
  return undefined;
}

/**
 * Fetch all pages (up to MAX_PAGES) for a path.
 * Automatically injects per_page if not present.
 */
async function ghGetAll<T>(
  path: string,
  token: string,
  signal: AbortSignal,
  perPage = PER_PAGE,
  maxPages = MAX_PAGES
): Promise<{ items: T[]; lastHeaders?: HeaderBag }> {
  const results: T[] = [];
  let url = path.includes("per_page=") ? path : `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}`;
  let lastHeaders: HeaderBag | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { data, headers } = await ghGet<T[]>(url, token, signal);
    results.push(...(Array.isArray(data) ? data : []));
    lastHeaders = headers;
    const next = parseNextLink(headers.get("link"));
    if (!next) break;
    url = next;
  }
  return { items: results, lastHeaders };
}

/**
 * Group formatting
 */
function formatGroup(opts: { org: string; team: string; role?: string }): string {
  let base: string;
  switch (env.GROUP_FORMAT) {
    case "team":
      base = opts.team;
      break;
    case "org/team":
      base = `${opts.org}/${opts.team}`;
      break;
    case "org:team":
    default:
      base = `${opts.org}:${opts.team}`;
  }
  if (env.GROUP_PREFIX) base = `${env.GROUP_PREFIX}${base}`;
  if (INCLUDE_ROLE_SUFFIX && opts.role) base = `${base}:${opts.role}`;
  return base;
}

type RawQueryValue = string | string[] | undefined;
type ReportQueryArgs = Record<string, string>;
type QueryStringRecord = Record<string, RawQueryValue>;
type HasuraActionEnvelope = {
  action?: unknown;
  input?: unknown;
  [key: string]: unknown;
};

type RemoteCommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

type ReportCollector = {
  id: string;
  description: string;
  collect: (args: ReportQueryArgs, runtime: ReportingRuntime) => Promise<unknown>;
};

type SnapshotCollectorResult = { status: "ok" | "error"; id: string; description: string; payload?: unknown; error?: unknown };

type ReportingRuntime = {
  runRemote: (command: string, timeoutMs?: number) => Promise<RemoteCommandResult>;
  queryPostgresSessions: (limit: number) => Promise<unknown>;
};

type SnapshotSectionState = "healthy" | "warning" | "critical";

type ReportingSectionDefinition = {
  id: string;
  description: string;
  collectors: string[];
  cadence: "fast" | "normal" | "slow";
};

const SSH_SERVICE_NAME = /^[a-zA-Z0-9._@-]+(?:\.service)?$/;
const SERVICE_STATE_FILTERS = new Set(["all", "active", "activating", "inactive", "deactivating", "failed", "exited", "running"]);
const SESSION_SCOPE_FILTERS = new Set(["all", "db", "ssh"]);

const REPORTING_SECTION_DEFINITIONS: ReportingSectionDefinition[] = [
  {
    id: "quick",
    description: "Fast CPU, memory, swap, load, and uptime baseline",
    collectors: ["system", "network"],
    cadence: "fast"
  },
  {
    id: "storage",
    description: "Disk and inode usage for space planning",
    collectors: ["storage"],
    cadence: "normal"
  },
  {
    id: "processes",
    description: "Top processes by resource usage",
    collectors: ["processes"],
    cadence: "normal"
  },
  {
    id: "services",
    description: "Service units and state",
    collectors: ["services"],
    cadence: "normal"
  },
  {
    id: "ports",
    description: "Listening ports and owning process ids",
    collectors: ["ports"],
    cadence: "normal"
  },
  {
    id: "sessions",
    description: "DB and SSH session details",
    collectors: ["sessions"],
    cadence: "normal"
  },
  {
    id: "logs",
    description: "Service logs from journald",
    collectors: ["service_logs"],
    cadence: "slow"
  },
  {
    id: "all",
    description: "Alias for all collectors",
    collectors: [],
    cadence: "normal"
  }
];

const REPORTING_SECTION_SET = new Set(REPORTING_SECTION_DEFINITIONS.map((section) => section.id));
const REPORTING_SECTION_INDEX = new Map<string, ReportingSectionDefinition>(
  REPORTING_SECTION_DEFINITIONS.map((section) => [section.id, section])
);

function asString(value: RawQueryValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return "";
}

function asStringList(value: RawQueryValue): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return value
    .map((v) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .flatMap((v) => v.split(",").map((part) => part.trim()).filter(Boolean));
}

function asInt(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asQueryValue(value: unknown): RawQueryValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    if (items.length === 0) return undefined;
    return items;
  }
  return undefined;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function classifyPercent(value: number, warn: number, critical: number) {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseQueryArgs(query: QueryStringRecord): ReportQueryArgs {
  const parsed: ReportQueryArgs = {};
  Object.entries(query).forEach(([key, value]) => {
    if (typeof value === "string") {
      parsed[key] = value;
      return;
    }
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === "string") parsed[key] = first;
    }
  });
  return parsed;
}

function asStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const values = value.map(asStringValue).filter((v): v is string => typeof v === "string" && v.length > 0);
    if (values.length === 0) return undefined;
    return values.join(",");
  }
  return undefined;
}

function parseObjectArgs(args: unknown): ReportQueryArgs {
  if (!args || Array.isArray(args) || typeof args !== "object") return {};
  const parsed: ReportQueryArgs = {};
  Object.entries(args as Record<string, unknown>).forEach(([key, value]) => {
    const normalized = asStringValue(value);
    if (normalized !== undefined) parsed[key] = normalized;
  });
  return parsed;
}

function parseCollectorNames(raw: RawQueryValue): string[] {
  const values = asStringList(raw)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) return ["all"];
  return values;
}

function parseSectionNames(raw: RawQueryValue): string[] {
  const values = asStringList(raw).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!values.length) return ["all"];
  if (values.includes("all") || values.includes("*")) return ["all"];
  const unknown = values.filter((value) => !REPORTING_SECTION_SET.has(value));
  if (unknown.length) {
    const e = new Error(`Unknown section(s): ${unknown.join(", ")}`);
    (e as any).status = 400;
    throw e;
  }
  if (values.includes("all") || values.includes("*")) return ["all"];
  const unique = [...new Set(values)];
  return unique;
}

function parseSectionParam(raw: string | undefined): string {
  const section = (raw || "").trim().toLowerCase();
  if (!section) {
    const error = new Error("Section path parameter is required.");
    (error as any).status = 400;
    throw error;
  }
  const normalized = section;
  if (!REPORTING_SECTION_SET.has(normalized)) {
    const error = new Error(`Unknown section: ${section}`);
    (error as any).status = 400;
    throw error;
  }
  if (normalized === "all") return "all";
  return normalized;
}

function normalizeSections(raw: RawQueryValue): string[] {
  const parsed = parseSectionNames(raw);
  if (parsed[0] === "all") return ["all"];
  return parsed;
}

function collectorsForSections(rawSections: RawQueryValue): string[] {
  const sections = normalizeSections(rawSections);
  if (sections[0] === "all" || !sections.length) return [];
  const allCollectors = sections.flatMap((section) => REPORTING_SECTION_INDEX.get(section)?.collectors || []);
  return [...new Set(allCollectors)].filter(Boolean);
}

function parseMaybeServiceName(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!SSH_SERVICE_NAME.test(trimmed)) {
    const e = new Error(`Invalid service name: ${trimmed}`);
    (e as any).status = 400;
    throw e;
  }
  return trimmed.endsWith(".service") ? trimmed : `${trimmed}.service`;
}

function parseHostPort(addrPort: string): { host: string; port: string } {
  const addr = addrPort.trim();
  if (!addr || addr === "*") return { host: "*", port: "" };
  if (addr.startsWith("[")) {
    const match = addr.match(/^\[(.*)\]:(\d+)$/);
    if (!match) return { host: addr, port: "" };
    return { host: match[1], port: match[2] };
  }
  const lastColon = addr.lastIndexOf(":");
  if (lastColon === -1) return { host: addr, port: "" };
  return { host: addr.slice(0, lastColon), port: addr.slice(lastColon + 1) };
}

async function resolveSshKeyFile(): Promise<string | undefined> {
  if (REPORTING_SSH_KEY_PATH) return REPORTING_SSH_KEY_PATH;
  if (!REPORTING_SSH_KEY) return undefined;
  const file = path.join("/tmp", `reporting-ssh-${randomUUID()}`);
  await fs.writeFile(file, `${REPORTING_SSH_KEY}\n`, { mode: 0o600, encoding: "utf8" });
  return file;
}

async function runRemoteCommand(
  command: string,
  timeoutMs: number = REPORTING_COMMAND_TIMEOUT_MS
): Promise<RemoteCommandResult> {
  if (!REPORTING_SSH_HOST) {
    const e = new Error("Reporting SSH host is not configured");
    (e as any).status = 500;
    throw e;
  }
  const keyFile = await resolveSshKeyFile();

  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "LogLevel=ERROR",
    "-p",
    String(REPORTING_SSH_PORT),
    "-o",
    `ConnectTimeout=${Math.max(1, Math.min(120, Math.floor(REPORTING_CONNECT_TIMEOUT_MS / 1000)))}`
  ];
  if (!REPORTING_STRICT_HOST_KEY) {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  if (keyFile) {
    args.push("-i", keyFile);
  }
  args.push(`${REPORTING_SSH_USER}@${REPORTING_SSH_HOST}`, command);

  try {
    const { stdout, stderr } = await execFile("ssh", args, {
      timeout: timeoutMs,
      maxBuffer: 8_388_608,
      encoding: "utf8"
    });
    return {
      command,
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
      exitCode: 0,
      timedOut: false
    };
  } catch (err: any) {
    const timedOut = err.killed === true;
    const message = String(err.message || err);
    const code = typeof err.code === "number" ? err.code : 1;
    const error = new Error(
      `SSH command failed (exit ${code}, timeout=${timedOut}): ${message}`
    );
    (error as any).status = code === 255 ? 502 : 500;
    (error as any).causes = {
      command,
      exitCode: code,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || ""),
      timedOut
    };
    throw error;
  }
}

function parseMemInfo(raw: string) {
  const rows = raw.split("\n");
  const values: Record<string, number> = {};
  for (const row of rows) {
    const match = row.match(/^(\w+):\s+(\d+)\s+(\w+)?/);
    if (!match) continue;
    const key = match[1];
    const value = Number(match[2]);
    const unit = (match[3] || "").toLowerCase();
    if (!Number.isFinite(value)) continue;
    values[key] = unit === "kb" ? value * 1024 : value;
  }
  return values;
}

function parseLoadAverage(raw: string) {
  const parts = raw.trim().split(/\s+/);
  return {
    load_1m: Number(parts[0] || 0),
    load_5m: Number(parts[1] || 0),
    load_15m: Number(parts[2] || 0),
    runnable_processes: Number(parts[3] || 0),
    total_processes: Number(parts[4] || 0),
    last_pid: Number(parts[5] || 0)
  };
}

function parseProcCpu(raw: string) {
  const line = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^cpu\s+/.test(line));
  if (!line) throw new Error("Could not parse /proc/stat cpu line");
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
    guest = 0,
    guestNice = 0
  ] = fields;
  const idleTotal = idle + iowait;
  const nonIdle = user + nice + system + irq + softirq + steal + guest + guestNice;
  const total = idleTotal + nonIdle;
  return { total, idle: idleTotal, timestamp: Date.now(), idleBreakdown: { idle, iowait }, nonIdle };
}

function parseNetworkTotals(raw: string) {
  const lines = raw.trim().split("\n");
  lines.shift();
  lines.shift();
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("lo")) continue;
    const [name, ...rest] = trimmed.split(/:\s*/);
    if (!name || !rest.length) continue;
    const fields = rest[0].trim().split(/\s+/).map((value) => Number(value));
    if (fields.length < 16) continue;
    const inboundBytes = fields[0];
    const outboundBytes = fields[8];
    if (Number.isFinite(inboundBytes)) rx += inboundBytes;
    if (Number.isFinite(outboundBytes)) tx += outboundBytes;
  }
  return { rx, tx, timestamp: Date.now(), sampleMs: Date.now() };
}

const PRIORITY_TO_SEVERITY: Record<string, "info" | "warn" | "error"> = {
  "0": "error",
  "1": "error",
  "2": "error",
  "3": "warn",
  "4": "warn",
  "5": "warn",
  "6": "info",
  "7": "info"
};

function parseSystemctlShow(raw: string) {
  const services: Record<string, { id: string; command?: string; pid?: number; description?: string; state?: string; sub_state?: string; load_state?: string }> = {};
  let currentService = "";
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key === "Id") {
      currentService = value;
      if (!services[currentService]) {
        services[currentService] = { id: currentService };
      }
      continue;
    }
    if (!currentService || !services[currentService]) continue;
    if (key === "MainPID") {
      services[currentService].pid = Number(value) || 0;
      continue;
    }
    if (key === "ExecStart") {
      services[currentService].command = value;
      continue;
    }
    if (key === "Description") {
      services[currentService].description = value;
      continue;
    }
    if (key === "ActiveState") {
      services[currentService].state = value;
      continue;
    }
    if (key === "SubState") {
      services[currentService].sub_state = value;
      continue;
    }
    if (key === "LoadState") {
      services[currentService].load_state = value;
    }
  }
  return services;
}

function parseServiceLogLines(raw: string) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, string>;
        const timestampRaw = parsed["__REALTIME_TIMESTAMP"] || parsed["__MONOTONIC_TIMESTAMP"] || "";
        const timestamp = timestampRaw
          ? new Date(Number(timestampRaw) / 1000).toISOString()
          : new Date().toISOString();
        const severity = PRIORITY_TO_SEVERITY[parsed.PRIORITY || "6"] || "info";
        return {
          timestamp,
          severity,
          message: parsed.MESSAGE || parsed.message || "",
          unit: parsed._SYSTEMD_UNIT || parsed.SYSTEMD_UNIT || undefined
        };
      } catch {
        return {
          timestamp: new Date().toISOString(),
          severity: "info" as const,
          message: line,
          unit: undefined
        };
      }
    })
    .filter((entry) => entry.message.length > 0);
}

type CpuSample = { total: number; idle: number; timestamp: number };
type NetworkSample = { rx: number; tx: number; timestamp: number };
const SERVICE_ID_NORMALIZED = REPORTING_SYSTEM_ID;

const CPU_SAMPLE_STATE = new Map<string, CpuSample>();
const NETWORK_SAMPLE_STATE = new Map<string, NetworkSample>();

function deriveCpuPercent(cpuSample: CpuSample, previous?: CpuSample): number | null {
  if (!previous) return null;
  const deltaTotal = cpuSample.total - previous.total;
  const deltaIdle = cpuSample.idle - previous.idle;
  if (deltaTotal <= 0) return 0;
  const percent = ((deltaTotal - deltaIdle) / deltaTotal) * 100;
  return Math.max(0, Math.min(100, Number(percent.toFixed(2))));
}

function deriveNetworkMbps(latest: NetworkSample, previous?: NetworkSample): { network_in_mbps: number; network_out_mbps: number } {
  if (!previous) return { network_in_mbps: 0, network_out_mbps: 0 };
  const deltaMs = latest.timestamp - previous.timestamp;
  if (deltaMs <= 0) return { network_in_mbps: 0, network_out_mbps: 0 };
  const rxRateBytesPerSec = (latest.rx - previous.rx) / (deltaMs / 1000);
  const txRateBytesPerSec = (latest.tx - previous.tx) / (deltaMs / 1000);
  return {
    network_in_mbps: Number(((Math.max(0, rxRateBytesPerSec) * 8) / 1_000_000).toFixed(3)),
    network_out_mbps: Number(((Math.max(0, txRateBytesPerSec) * 8) / 1_000_000).toFixed(3))
  };
}

function deriveSectionHealth(payload: { storageUsedPercent?: number; memoryPercent?: number; swapPercent?: number; cpuPercent?: number }) {
  const statuses = [
    payload.storageUsedPercent ?? 0,
    payload.memoryPercent ?? 0,
    payload.swapPercent ?? 0,
    payload.cpuPercent ?? 0
  ];
  const max = Math.max(...statuses);
  if (max >= REPORTING_STORAGE_CRITICAL_PERCENT) return "critical";
  if (max >= REPORTING_STORAGE_WARNING_PERCENT) return "warning";
  return "healthy";
}

function findStorageSummaryBySection(storage: {
  mountpoints?: Array<{
    mountpoint?: string;
    used_percent?: number;
    used_bytes?: number;
    size_bytes?: number;
    health?: "ok" | "warn" | "critical";
  }>;
  inode_usage?: Array<{ mountpoint?: string; inodes_used_percent?: number }>;
}) {
  const primaryMount =
    storage.mountpoints?.find((row) => row.mountpoint === "/") ||
    storage.mountpoints?.reduce((acc, row) => {
      if (!acc || (row.used_percent || 0) > (acc.used_percent || 0)) return row;
      return acc;
    }, storage.mountpoints[0]);
  if (!primaryMount) return {};
  const inode = storage.inode_usage?.find((row) => row.mountpoint === primaryMount.mountpoint);
  return {
    storageUsedPercent: Number((primaryMount.used_percent ?? 0).toFixed(2)),
    storageUsedBytes: primaryMount.used_bytes || 0,
    storageTotalBytes: primaryMount.size_bytes || 0,
    storageInodePercent: Number((inode?.inodes_used_percent || 0).toFixed(2)),
    health: primaryMount.health
  };
}

function parseJsonPayload(raw: string): unknown {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
      return JSON.parse(line);
    }
  }
  throw new Error("Expected JSON payload but could not parse command output");
}

function parseDf(raw: string) {
  const lines = raw.trim().split("\n");
  const header = lines.shift();
  if (!header || lines.length === 0) return [];
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 6) return null;
      const [filesystem, size, used, available, usePercent, mountpoint] = fields;
      const usedPct = Number.parseInt((usePercent || "0").replace("%", ""), 10) || 0;
      return {
        filesystem,
        mountpoint,
        size_bytes: Number(size) || 0,
        used_bytes: Number(used) || 0,
        available_bytes: Number(available) || 0,
        used_percent: usedPct,
        health: classifyPercent(usedPct, REPORTING_STORAGE_WARNING_PERCENT, REPORTING_STORAGE_CRITICAL_PERCENT)
      };
    })
    .filter(Boolean);
}

function parseDfInodes(raw: string) {
  const lines = raw.trim().split("\n");
  const header = lines.shift();
  if (!header || lines.length === 0) return [];
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 6) return null;
      const [filesystem, inodes, inodesUsed, inodesFree, inodesPercent, mountpoint] = fields;
      const usedPercent = Number.parseInt((inodesPercent || "0").replace("%", ""), 10) || 0;
      return {
        filesystem,
        mountpoint,
        inodes,
        inodes_used: Number(inodesUsed) || 0,
        inodes_free: Number(inodesFree) || 0,
        inodes_used_percent: usedPercent,
        inode_health: classifyPercent(usedPercent, REPORTING_STORAGE_WARNING_PERCENT, REPORTING_STORAGE_CRITICAL_PERCENT)
      };
    })
    .filter(Boolean);
}

function parseProcesses(raw: string) {
  const lines = raw.trim().split("\n");
  return lines
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) return null;
      const [pid, ppid, user, cpu, mem, state, etime, ...cmdParts] = parts;
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        user,
        cpu_pct: Number(cpu),
        mem_pct: Number(mem),
        state,
        elapsed_seconds: etime,
        command: cmdParts.join(" ")
      };
    })
    .filter(Boolean);
}

type ParsedService = {
  name: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  description: string;
};

function parseServices(raw: string, hostOnly?: boolean): ParsedService[] {
  const lines = raw.trim().split("\n");
  const services = lines
    .filter(Boolean)
    .map((line) => {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 5) return null;
      const [name, load, active, sub, ...rest] = tokens;
      return {
        name,
        load_state: load,
        active_state: active,
        sub_state: sub,
        description: hostOnly ? "" : rest.join(" ")
      };
    })
    .filter((service): service is ParsedService => Boolean(service));
  return services;
}

function parseServicesFromSsh(raw: string) {
  const lines = raw
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/);
    const [user, tty, loginDate, loginTime, from] = fields;
    return {
      user,
      tty,
      login: [loginDate, loginTime].filter(Boolean).join(" "),
      from: from || "local"
    };
  });
}

function parseListeningPorts(raw: string) {
  const lines = raw.trim().split("\n").filter(Boolean);
  return lines
    .filter((line) => !line.startsWith("State"))
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 6) return null;
      const protocol = cols[0];
      const localAddress = cols[3] ?? "";
      const peerAddress = cols[4] ?? "";
      const processSpec = cols.slice(5).join(" ");
      const local = parseHostPort(localAddress);
      const peer = parseHostPort(peerAddress);
      const pidMatches = [...processSpec.matchAll(/"([^"]+)",pid=(\d+),fd=\d+/g)];
      const processes = pidMatches.map((m) => ({ name: m[1], pid: Number(m[2]) }));
      return {
        protocol,
        local: { host: local.host, port: local.port },
        peer: { host: peer.host, port: peer.port },
        processes
      };
    })
    .filter(Boolean);
}

async function queryPostgresSessions(limit: number) {
  if (!REPORTING_DB_PASSWORD) {
    throw new Error("DB password is not configured");
  }

  const safeLimit = asInt(String(limit), 20, 1, 1000);
  const sampleLimit = Math.min(safeLimit, 50);
  const sql = `
WITH session_rows AS (
  SELECT
    pid,
    datname,
    usename,
    application_name,
    COALESCE(client_addr::text, '') AS client_addr,
    state,
    wait_event_type,
    wait_event,
    backend_start,
    query_start,
    CASE WHEN query IS NULL THEN '' ELSE left(regexp_replace(query, E'\\s+', ' ', 'g'), 500) END AS query
  FROM pg_stat_activity
  ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, state_change DESC NULLS LAST
  LIMIT ${safeLimit}
),
summary AS (
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE state = 'active')::int AS active,
    COUNT(*) FILTER (WHERE state = 'idle')::int AS idle,
    COUNT(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
    COUNT(*) FILTER (WHERE wait_event IS NOT NULL)::int AS waiting,
    COALESCE(
      (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
      0
    ) AS max_connections
  FROM pg_stat_activity
)
SELECT json_build_object(
  'summary', (SELECT row_to_json(summary) FROM summary),
  'sessions', COALESCE((SELECT json_agg(row_to_json(session_rows) ORDER BY state NULLS LAST) FROM session_rows), '[]'::json),
  'top_queries', COALESCE((
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT
        datname,
        usename,
        COALESCE(client_addr::text, '') AS client_addr,
        LEFT(regexp_replace(query, E'\\s+', ' ', 'g'), 500) AS query
      FROM pg_stat_activity
      WHERE query IS NOT NULL AND query <> ''
      ORDER BY query_start DESC NULLS LAST
      LIMIT ${sampleLimit}
    ) t
  ), '[]'::json)
) AS payload;
  `.trim();

  const sqlOneLine = sql.replace(/\s+/g, " ");
  const cmd = `${REPORTING_DB_PASSWORD ? `PGPASSWORD=${shellQuote(REPORTING_DB_PASSWORD)} ` : ""}psql -h ${shellQuote(
    REPORTING_DB_HOST
  )} -p ${REPORTING_DB_PORT} -U ${shellQuote(REPORTING_DB_USER)} -d ${shellQuote(REPORTING_DB_NAME)} -qAtX -c ${shellQuote(
    sqlOneLine
  )}`;
  const result = await runRemoteCommand(cmd, Math.max(REPORTING_COMMAND_TIMEOUT_MS, 10_000));
  const parsed = parseJsonPayload(result.stdout);
  if (!parsed) {
    const err = new Error("Postgres status command did not return valid JSON");
    (err as any).status = 500;
    throw err;
  }
  return parsed;
}

const reportingCollectors: ReportCollector[] = [
  {
    id: "storage",
    description: "Storage usage and inode pressure with thresholds",
    collect: async () => {
      const [bytesOut, inodeOut] = await Promise.all([
        runRemoteCommand("df -P -B1 -x tmpfs -x devtmpfs"),
        runRemoteCommand("df -P -i -x tmpfs -x devtmpfs")
      ]);
      const rows = parseDf(bytesOut.stdout);
      const inodeRows = parseDfInodes(inodeOut.stdout);
      return {
        mountpoints: rows,
        inode_usage: inodeRows,
        generated_at_unix: nowUnix(),
        warning_threshold_percent: REPORTING_STORAGE_WARNING_PERCENT,
        critical_threshold_percent: REPORTING_STORAGE_CRITICAL_PERCENT,
        count: rows.length
      };
    }
  },
  {
    id: "system",
    description: "CPU, memory, swap, and load baseline",
    collect: async () => {
      const [loadOut, memOut, procOut, cpuOut] = await Promise.all([
        runRemoteCommand("cat /proc/loadavg"),
        runRemoteCommand("cat /proc/meminfo"),
        runRemoteCommand("cat /proc/uptime"),
        runRemoteCommand("cat /proc/stat | head -n 1")
      ]);

      const load = parseLoadAverage(loadOut.stdout);
      const mem = parseMemInfo(memOut.stdout);
      const memTotal = mem.MemTotal || 0;
      const memAvailable = mem.MemAvailable || 0;
      const memUsed = memTotal > 0 ? memTotal - memAvailable : 0;
      const memUsedPercent = memTotal > 0 ? Number((memUsed / memTotal) * 100) : 0;
      const swapTotal = mem.SwapTotal || 0;
      const swapFree = mem.SwapFree || 0;
      const swapUsed = Math.max(0, swapTotal - swapFree);
      const swapUsedPercent = swapTotal > 0 ? Number((swapUsed / swapTotal) * 100) : 0;
      const cpuSample = parseProcCpu(cpuOut.stdout);
      const lastCpuSample = CPU_SAMPLE_STATE.get(SERVICE_ID_NORMALIZED);
      CPU_SAMPLE_STATE.set(SERVICE_ID_NORMALIZED, cpuSample);
      const cpuPercent = deriveCpuPercent(cpuSample, lastCpuSample);

      return {
        cpu_percent: cpuPercent,
        load,
        uptime_seconds: Number(procOut.stdout.split(" ")[0] || 0),
        memory: {
          total_bytes: memTotal,
          available_bytes: memAvailable,
          used_bytes: memUsed,
          used_percent: Number(memUsedPercent.toFixed(2)),
          cached_bytes: mem.Cached || 0,
          buffered_bytes: mem.Buffers || 0,
          swap_total_bytes: swapTotal,
          swap_free_bytes: swapFree,
          swap_used_bytes: swapUsed,
          swap_used_percent: Number(swapUsedPercent.toFixed(2)),
          health: classifyPercent(memUsedPercent, REPORTING_STORAGE_WARNING_PERCENT, REPORTING_STORAGE_CRITICAL_PERCENT)
        }
      };
    }
  },
  {
    id: "network",
    description: "Network in/out throughput in Mbps",
    collect: async () => {
      const out = await runRemoteCommand("cat /proc/net/dev");
      const sample = parseNetworkTotals(out.stdout);
      const lastSample = NETWORK_SAMPLE_STATE.get(SERVICE_ID_NORMALIZED);
      NETWORK_SAMPLE_STATE.set(SERVICE_ID_NORMALIZED, sample);
      const { network_in_mbps, network_out_mbps } = deriveNetworkMbps(sample, lastSample);
      return {
        network_in_mbps,
        network_out_mbps,
        bytes_in: sample.rx,
        bytes_out: sample.tx,
        sample_ms: sample.timestamp
      };
    }
  },
  {
    id: "processes",
    description: "Top running processes by CPU",
    collect: async (args) => {
      const limit = asInt(args.limit, REPORTING_DEFAULT_PROCESS_LIMIT, 1, REPORTING_MAX_PROCESS_LIMIT);
      const out = await runRemoteCommand(
        `ps -eo pid,ppid,user,%cpu,%mem,state,etime,cmd --sort=-%cpu --no-headers | head -n ${limit}`
      );
      return {
        count: limit,
        limit,
        processes: parseProcesses(out.stdout)
      };
    }
  },
  {
    id: "services",
    description: "Service units and states",
    collect: async (args) => {
      const state = (args.state || "all").trim().toLowerCase();
      const normalizedState = SERVICE_STATE_FILTERS.has(state) ? state : "all";
      const stateArg = normalizedState === "all" ? "" : ` --state=${normalizedState}`;
      const out = await runRemoteCommand(`systemctl list-units --type=service --no-pager --no-legend${stateArg}`);
      const services = parseServices(out.stdout, false);
      const names = services
        .map((service) => String(service.name || "").trim())
        .filter(Boolean)
        .slice(0, 100)
        .map((serviceName) => shellQuote(serviceName));
      let enrich: ReturnType<typeof parseSystemctlShow> = {};
      if (names.length) {
        try {
          const showOut = await runRemoteCommand(
            `systemctl show ${names.join(" ")} -p Id -p LoadState -p ActiveState -p SubState -p MainPID -p ExecStart -p Description`
          );
          enrich = parseSystemctlShow(showOut.stdout);
        } catch {
          enrich = {};
        }
      }
      const merged = services.map((service) => {
        const m = enrich[service.name];
        if (!m) return service;
        return {
          ...service,
          id: service.name,
          load_state: m.load_state || service.load_state,
          active_state: m.state || service.active_state,
          sub_state: m.sub_state || service.sub_state,
          pid: m.pid || 0,
          command: m.command || service.description,
          description: m.description || service.description
        };
      });
      return {
        requested_state: normalizedState,
        services: merged
      };
    }
  },
  {
    id: "ports",
    description: "Listening sockets and owning processes",
    collect: async () => {
      const out = await runRemoteCommand("ss -ltnup");
      return {
        listeners: parseListeningPorts(out.stdout)
      };
    }
  },
  {
    id: "service_logs",
    description: "Latest service logs from journalctl",
    collect: async (args) => {
      const rawService = parseMaybeServiceName(args.service);
      const service = rawService || "postgresql.service";
      const lines = asInt(args.lines, REPORTING_DEFAULT_LOG_LINES, 1, REPORTING_MAX_LOG_LINES);
      const tail = `-n ${lines}`;
      const since = asString(args.since).trim();
      const sinceArg = since ? ` --since ${shellQuote(since)}` : "";
      const out = await runRemoteCommand(
        `journalctl -u ${shellQuote(service)} --no-pager -o json ${tail}${sinceArg}`
      );
      const logs = parseServiceLogLines(out.stdout);
      return {
        service,
        lines_requested: lines,
        lines_returned: logs.length,
        since: since || null,
        logs
      };
    }
  },
  {
    id: "sessions",
    description: "Session summary for DB and SSH/session endpoints",
    collect: async (args) => {
      const scope = (asString(args.scope) || "all").toLowerCase();
      if (!SESSION_SCOPE_FILTERS.has(scope)) {
        const e = new Error(`Unknown sessions scope: ${scope}`);
        (e as any).status = 400;
        throw e;
      }
      const limit = asInt(args.limit, REPORTING_DEFAULT_SESSIONS_LIMIT, 1, REPORTING_MAX_SESSIONS_LIMIT);
      const result: Record<string, unknown> = {};
      if (scope === "all" || scope === "db") {
        result.db = await queryPostgresSessions(limit);
      }
      if (scope === "all" || scope === "ssh") {
        const [whoOut, establishedOut] = await Promise.all([
          runRemoteCommand("who"),
          runRemoteCommand("ss -tn state established")
        ]);
        const sessions = parseServicesFromSsh(whoOut.stdout);
        const sshNet = establishedOut.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => /:22/.test(line));
        result.ssh = {
          users: sessions,
          ssh_connections: sshNet.length,
          ssh_entries: sshNet.map((line) => line.trim())
        };
      }
      return result;
    }
  }
];

const reportingCollectorMap = new Map<string, ReportCollector>(
  reportingCollectors.map((collector) => [collector.id, collector])
);

function collectRequestedForSections(
  rawCollectors: RawQueryValue,
  rawSections: RawQueryValue
): { requested: string[]; selectedCollectors: string[] } {
  const sections = normalizeSections(rawSections);
  if (sections[0] !== "all" && sections.length) {
    const mapped = collectorsForSections(sections);
    return { requested: sections, selectedCollectors: mapped };
  }

  const requested = parseCollectorNames(rawCollectors);
  if (requested[0] === "all" || !requested.length) {
    const defaultCollectorIds = [...reportingCollectorMap.keys()].filter((id) => id !== "service_logs");
    return { requested: ["all"], selectedCollectors: defaultCollectorIds };
  }
  const requestedUnique = [...new Set(requested.filter(Boolean))];
  return { requested: requestedUnique, selectedCollectors: requestedUnique };
}

async function collectRequestedReportData(
  rawCollectors: RawQueryValue,
  args: ReportQueryArgs,
  rawSections?: RawQueryValue
) {
  const { requested, selectedCollectors } = collectRequestedForSections(rawCollectors, rawSections);
  const unknown = selectedCollectors.filter((id) => !reportingCollectorMap.has(id));
  if (unknown.length) {
    const error = new Error(`Unknown collector(s): ${unknown.join(", ")}`);
    (error as any).status = 400;
    throw error;
  }

  const runtime: ReportingRuntime = {
    runRemote: runRemoteCommand,
    queryPostgresSessions
  };

  const collectors = [];
  let anyError = false;
  for (const id of selectedCollectors) {
    const collector = reportingCollectorMap.get(id);
    if (!collector) continue;
    try {
      const collected = await collector.collect(args, runtime);
      collectors.push({
        id: collector.id,
        description: collector.description,
        status: "ok",
        payload: collected
      });
    } catch (err: any) {
      anyError = true;
      collectors.push({
        id,
        description: collector.description,
        status: "error",
        payload: {
          message: err.message || "Collector failed",
          status: err.status || 500
        }
      });
    }
  }

  return {
    generated_at_unix: nowUnix(),
    requested,
    target: {
      system_id: (args.system_id || REPORTING_SYSTEM_ID) as string,
      ssh_host: REPORTING_SSH_HOST || null,
      db_host: REPORTING_DB_HOST || null,
      db_port: REPORTING_DB_PORT,
      has_db_password: !!REPORTING_DB_PASSWORD
    },
    collectors,
    all_ok: !anyError
  };
}

function buildServiceHealth(raw: {
  active_state?: string;
  sub_state?: string;
  load_state?: string;
}): "running" | "degraded" | "stopped" {
  const active = (raw.active_state || "").toLowerCase();
  const sub = (raw.sub_state || "").toLowerCase();
  if (active === "active" && sub === "running") return "running";
  if (active === "failed" || active === "deactivating" || active === "inactive") return "degraded";
  return "stopped";
}

function buildSystemSnapshotFromCollectors(collectors: SnapshotCollectorResult[]) {
  const asObject = (id: string) => {
    const match = collectors.find((entry) => entry.id === id);
    if (!match || match.status !== "ok" || typeof match.payload !== "object" || !match.payload) return {};
    return match.payload as Record<string, unknown>;
  };

  const storage = asObject("storage");
  const system = asObject("system");
  const network = asObject("network");
  const sessions = asObject("sessions");
  const services = asObject("services");
  const ports = asObject("ports");
  const processes = asObject("processes");
  const logs = asObject("service_logs");

  const storageSummary = findStorageSummaryBySection(storage as any);
  const storageUsedPercent = Number(storageSummary.storageUsedPercent || 0);
  const memory = system["memory"] as Record<string, number> | undefined;
  const memoryPercent = Number(memory?.used_percent || 0);
  const swapPercent = Number(memory?.swap_used_percent || 0);
  const cpuPercent = system["cpu_percent"] === null ? 0 : Number(system["cpu_percent"] || 0);
  const loadAverageDetails = (system["load"] as Record<string, unknown>) || {};
  const loadAverage = Number(Number(loadAverageDetails.load_1m || 0).toFixed(2));
  const procRows = (processes["processes"] as Array<Record<string, unknown>>) || [];
  const serviceRows = (services["services"] as Array<Record<string, unknown>>) || [];
  const processCount = Number(procRows.length || 0);
  const listenerRows = (ports["listeners"] as Array<Record<string, unknown>>) || [];

  const serviceByPid = new Map<number, Record<string, unknown>>();
  for (const service of serviceRows) {
    const pid = Number(service.pid || 0);
    if (!pid) continue;
    serviceByPid.set(pid, service);
  }

  const listeningPorts = listenerRows.flatMap((row) => {
    const local = row["local"] as Record<string, string>;
    const entries = (row["processes"] as Array<Record<string, unknown>>) || [];
    return entries.map((entry) => {
      const pid = Number(entry.pid || 0);
      const owner = serviceByPid.get(pid);
      return {
        protocol: String(row.protocol || ""),
        localAddress: local?.host || "",
        port: Number(local?.port || 0),
        serviceId: owner ? String(owner.id || owner.name || "") : "",
        processName: String(entry.name || ""),
        pid,
        description: owner ? String(owner.description || "") : ""
      };
    });
  });

  const dbSummary = sessions["db"] as Record<string, any>;
  const sshSummary = sessions["ssh"] as Record<string, unknown> | undefined;
  const dbSessionSummary = (dbSummary?.summary || {}) as Record<string, number>;
  const sshUsers = Array.isArray(sshSummary?.users) ? sshSummary.users : [];
  const serviceLogs = {} as Record<string, unknown>;
  if (logs && typeof logs.service === "string" && Array.isArray(logs.logs)) {
    serviceLogs[logs.service] = logs.logs;
  }

  return {
    systemId: REPORTING_SYSTEM_ID,
    collectedAt: new Date().toISOString(),
    status: deriveSectionHealth({
      storageUsedPercent,
      memoryPercent,
      swapPercent,
      cpuPercent
    }),
    cpuPercent,
    loadAverage,
    loadAverageDetails,
    memoryPercent,
    swapPercent,
    diskPercent: storageUsedPercent,
    storageUsedPercent,
    storageUsedGb: Number(((storageSummary.storageUsedBytes || 0) / 1024 ** 3).toFixed(2)),
    storageTotalGb: Number(((storageSummary.storageTotalBytes || 0) / 1024 ** 3).toFixed(2)),
    storageInodePercent: Number((storageSummary.storageInodePercent || 0).toFixed(2)),
    networkInMbps: Number(network["network_in_mbps"] || 0),
    networkOutMbps: Number(network["network_out_mbps"] || 0),
    dbSessions: Number(dbSessionSummary.total || 0),
    sshSessions: Array.isArray(sshUsers) ? sshUsers.length : 0,
    processCount,
    services: serviceRows.map((service) => ({
      id: String(service.name || service.id || ""),
      name: String(service.name || ""),
      status: buildServiceHealth({
        active_state: String(service.active_state || ""),
        sub_state: String(service.sub_state || ""),
        load_state: String(service.load_state || "")
      }),
      command: String(service.command || service.description || ""),
      pid: Number(service.pid || 0),
      description: String(service.description || "")
    })),
    listeningPorts,
    serviceLogs,
    uptimeHours: Number((((system["uptime_seconds"] as number) || 0) / 3600).toFixed(2))
  };
}

function filterSnapshotFields(snapshot: Record<string, unknown>, fields: string[]) {
  if (!fields.length) return snapshot;
  const requested = new Set(fields.map((field) => field.trim()).filter(Boolean));
  const filtered: Record<string, unknown> = {};
  requested.forEach((field) => {
    if (field in snapshot) filtered[field] = snapshot[field];
  });
  return filtered;
}

function formatReportingError(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "Reporting request failed";
  const status = (error as any)?.status || 500;
  return { message, status };
}

function getBearerToken(req: Request): string {
  const auth = req.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    const e = new Error("Missing or invalid Authorization header; expected 'Bearer <token>'");
    (e as any).status = 401;
    throw e;
  }
  return auth.substring("Bearer ".length).trim();
}

function enforceApiKey(req: Request): void {
  if (!REQUIRE_API_KEY) return;
  const headerKey = req.get("X-API-Key");
  const queryKey = (req.query?.key as string) || (req.query?.api_key as string);
  const provided = headerKey || queryKey;
  if (!provided || provided !== env.API_KEY) {
    const e = new Error("Forbidden: missing or invalid API key");
    (e as any).status = 403;
    throw e;
  }
}

function enforceReportingApiKey(req: Request): void {
  if (!REPORTING_REQUIRE_API_KEY) return;
  const headerKey = req.get("X-API-Key");
  const queryKey = (req.query?.key as string) || (req.query?.api_key as string);
  const provided = headerKey || queryKey;
  if (!provided || provided !== env.API_KEY) {
    const e = new Error("Forbidden: missing or invalid API key for reporting endpoint");
    (e as any).status = 403;
    throw e;
  }
}

/**
 * Compose the “as-much-as-possible” profile bundle
 */
async function fetchProfileBundle(token: string) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(env.TIMEOUT_MS));

  try {
    // Base user
    const { data: user, headers: userH } = await ghGet<GitHubUser>("/user", token, ac.signal);

    // Emails
    let emails: GitHubEmail[] = [];
    try {
      const { data } = await ghGet<GitHubEmail[]>("/user/emails", token, ac.signal);
      emails = data || [];
    } catch {
      emails = [];
    }

    // Resolve primary email
    let email = user.email ?? null;
    if (!email && emails.length) {
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
      email = primary?.email ?? null;
    }

    // Teams (all pages)
    const { items: teams } = await ghGetAll<GitHubTeam>("/user/teams", token, ac.signal);

    // Orgs (all pages)
    const { items: orgs } = await ghGetAll<GitHubOrg>("/user/orgs", token, ac.signal);

    // Org memberships (state/role per org)
    const { items: orgMemberships } = await ghGetAll<GitHubOrgMembership>("/user/memberships/orgs", token, ac.signal);

    // Repos (first N pages, sorted by updated)
    const { items: repos, lastHeaders: reposH } = await ghGetAll<GitHubRepo>(
      "/user/repos?sort=updated&direction=desc",
      token,
      ac.signal
    );

    // Build “groups” for Directus mapping
    const groups: string[] = [];
    for (const t of teams) {
      const org = t?.organization?.login;
      const team = t?.slug || t?.name;
      if (!org || !team) continue;
      if (ALLOWED_ORGS.size && !ALLOWED_ORGS.has(org)) continue;
      groups.push(formatGroup({ org, team, role: t.role }));
      if (INCLUDE_ORG_AS_GROUP) {
        groups.push(env.GROUP_PREFIX ? `${env.GROUP_PREFIX}${org}` : org);
      }
    }

    // Rate limit info (best effort; prefer last repos call if present)
    const rateHeaders = reposH ?? userH;
    const rate_limit = {
      limit: Number(rateHeaders?.get("x-ratelimit-limit") || 0),
      remaining: Number(rateHeaders?.get("x-ratelimit-remaining") || 0),
      used: Number(rateHeaders?.get("x-ratelimit-used") || 0),
      reset: Number(rateHeaders?.get("x-ratelimit-reset") || 0)
    };

    // Scopes on the token (useful for debugging)
    const oauth_scopes = (userH.get("x-oauth-scopes") || "").split(",").map((s) => s.trim()).filter(Boolean);

    // Trim repos to a lean shape to keep payload reasonable
    const repos_min = repos.map((r) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      private: r.private,
      fork: r.fork,
      html_url: r.html_url,
      language: r.language ?? null,
      pushed_at: r.pushed_at ?? null,
      updated_at: r.updated_at ?? null,
      permissions: r.permissions ?? undefined
    }));

    // Final payload
    return {
      // core identity for Directus
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      email,

      // directus group claim
      groups,

      // extras (helpful for your dashboards / debugging)
      avatar_url: user.avatar_url,
      html_url: user.html_url,
      company: user.company ?? null,
      blog: user.blog ?? null,
      location: user.location ?? null,
      bio: user.bio ?? null,
      twitter_username: user.twitter_username ?? null,
      created_at: user.created_at ?? null,
      updated_at: user.updated_at ?? null,

      emails,            // raw email array (when available)
      orgs,              // organizations the user belongs to
      org_memberships: orgMemberships.map((m) => ({
        organization: m.organization?.login,
        org_id: m.organization?.id,
        state: m.state,
        role: m.role
      })),
      teams: teams.map((t) => ({
        org: t.organization?.login,
        slug: t.slug,
        name: t.name,
        role: t.role
      })),
      repos: repos_min,  // recent repos (paginated)

      oauth_scopes,
      rate_limit
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * -----------------------------
 * Express app
 * -----------------------------
 */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", Math.max(0, Number(env.TRUST_PROXY_HOPS) || 1));

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "64kb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  rateLimit({
    windowMs: Number(env.RATE_WINDOW_MS),
    max: Number(env.RATE_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    // Cloud Run sets X-Forwarded-For; trust proxy is set above.
    // Keep runtime resilient even if upstream proxy config drifts.
    validate: false
  })
);

// Health
app.get("/", (_req, res) => res.status(200).json({ status: "ok" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

const REPORTING_OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "VM Stats Service",
    version: "1.2.0",
    description:
      "Internal API exposing VM reporting collectors for the oracle-db host and Hasura integration."
  },
  servers: [{ url: OPENAPI_SERVER_URL }],
  paths: {
    "/healthz": {
      get: {
        summary: "Health check",
        operationId: "healthz",
        responses: {
          "200": {
            description: "Service health",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } }
              }
            }
          }
        }
      }
    },
    "/stats/collectors": {
      get: {
        summary: "List reporting collectors",
        operationId: "listStatsCollectors",
        description: "Enumerates available collectors and reusable snapshot sections.",
        responses: {
          "200": {
            description: "Available collectors",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CollectorAndSectionListResponse" }
              }
            }
          }
        }
      }
    },
    "/stats/systems": {
      get: {
        summary: "List monitored systems",
        operationId: "listStatsSystems",
        responses: {
          "200": {
            description: "Available systems",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SystemListResponse" }
              }
            }
          }
        }
      }
    },
    "/stats": {
      get: {
        summary: "Fetch VM stats",
        operationId: "getStats",
        parameters: [
          {
            in: "query",
            name: "collector",
            required: false,
            schema: { type: "string" },
            description: "Collector name (repeatable as comma list)"
          },
          {
            in: "query",
            name: "collectors",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated collectors"
          },
          { in: "query", name: "state", required: false, schema: { type: "string" }, description: "Service state filter" },
          { in: "query", name: "sections", required: false, schema: { type: "string" }, description: "Comma-separated sections (quick,storage,processes,services,ports,sessions,logs)" },
          { in: "query", name: "scope", required: false, schema: { type: "string" }, description: "Session scope filter" },
          { in: "query", name: "limit", required: false, schema: { type: "integer" }, description: "Result limit" },
          { in: "query", name: "service", required: false, schema: { type: "string" }, description: "Target service name" },
          { in: "query", name: "lines", required: false, schema: { type: "integer" }, description: "Log lines" },
          { in: "query", name: "since", required: false, schema: { type: "string" }, description: "Log range start" },
          { in: "query", name: "system_id", required: false, schema: { type: "string" }, description: "System identifier override" }
        ],
        responses: {
          "200": {
            description: "Collected stats",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          },
          "207": {
            description: "Partial stats; one or more collectors failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          }
        }
      }
    },
    "/stats/snapshot": {
      get: {
        summary: "Fetch normalized snapshot for UI",
        operationId: "getStatsSnapshot",
        parameters: [
          {
            in: "query",
            name: "sections",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated sections to fetch"
          },
          {
            in: "query",
            name: "fields",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated snapshot fields to include"
          },
          { in: "query", name: "collector", required: false, schema: { type: "string" }, description: "Collector override" },
          { in: "query", name: "service", required: false, schema: { type: "string" }, description: "Target service (for logs section)" },
          { in: "query", name: "lines", required: false, schema: { type: "integer" }, description: "Log lines when requesting logs section" },
          { in: "query", name: "since", required: false, schema: { type: "string" }, description: "Log start time" },
          { in: "query", name: "system_id", required: false, schema: { type: "string" }, description: "System identifier override" }
        ],
        responses: {
          "200": {
            description: "Normalized system snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SnapshotEnvelope" }
              }
            }
          },
          "207": {
            description: "Partial snapshot; one or more collectors failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SnapshotEnvelope" }
              }
            }
          }
        }
      }
    },
    "/stats/sections/{section}": {
      get: {
        summary: "Fetch a single reporting section",
        operationId: "getStatsBySection",
        parameters: [
          {
            in: "path",
            name: "section",
            required: true,
            schema: { type: "string" },
            description: "Section name (quick, storage, processes, services, ports, sessions, logs, all)"
          },
          {
            in: "query",
            name: "collector",
            required: false,
            schema: { type: "string" },
            description: "Collector override"
          },
          { in: "query", name: "state", required: false, schema: { type: "string" }, description: "Service state filter" },
          { in: "query", name: "scope", required: false, schema: { type: "string" }, description: "Session scope filter" },
          { in: "query", name: "limit", required: false, schema: { type: "integer" }, description: "Result limit" },
          { in: "query", name: "service", required: false, schema: { type: "string" }, description: "Target service name" },
          { in: "query", name: "lines", required: false, schema: { type: "integer" }, description: "Log lines" },
          { in: "query", name: "since", required: false, schema: { type: "string" }, description: "Log range start" },
          { in: "query", name: "system_id", required: false, schema: { type: "string" }, description: "System identifier override" }
        ],
        responses: {
          "200": {
            description: "Collected stats for section",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          },
          "207": {
            description: "Partial section response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          }
        }
      }
    },
    "/stats/sections/{section}/snapshot": {
      get: {
        summary: "Fetch a normalized section snapshot",
        operationId: "getStatsSnapshotBySection",
        parameters: [
          {
            in: "path",
            name: "section",
            required: true,
            schema: { type: "string" },
            description: "Section name (quick, storage, processes, services, ports, sessions, logs, all)"
          },
          {
            in: "query",
            name: "fields",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated snapshot fields to include"
          },
          { in: "query", name: "collector", required: false, schema: { type: "string" }, description: "Collector override" },
          { in: "query", name: "service", required: false, schema: { type: "string" }, description: "Target service (for logs section)" },
          { in: "query", name: "lines", required: false, schema: { type: "integer" }, description: "Log lines when requesting logs section" },
          { in: "query", name: "since", required: false, schema: { type: "string" }, description: "Log range start" },
          { in: "query", name: "system_id", required: false, schema: { type: "string" }, description: "System identifier override" }
        ],
        responses: {
          "200": {
            description: "Normalized section snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SnapshotEnvelope" }
              }
            }
          },
          "207": {
            description: "Partial section snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SnapshotEnvelope" }
              }
            }
          }
        }
      }
    },
    "/stats/logs": {
      get: {
        summary: "Fetch logs for one service",
        operationId: "getServiceLogs",
        parameters: [
          { in: "query", name: "service", required: true, schema: { type: "string" }, description: "Service name (.service optional)" },
          { in: "query", name: "lines", required: false, schema: { type: "integer" }, description: "Number of lines" },
          { in: "query", name: "since", required: false, schema: { type: "string" }, description: "Log range start" }
        ],
        responses: {
          "200": {
            description: "Service log lines",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ServiceLogResponse" }
              }
            }
          },
          "207": {
            description: "Partial logs response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ServiceLogResponse" }
              }
            }
          },
          "400": {
            description: "service parameter missing",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { $ref: "#/components/schemas/ErrorResponse" } } }
              }
            }
          }
        }
      }
    },
    "/hasura/actions/stats": {
      post: {
        summary: "Hasura action endpoint for VM reporting",
        description: "Accepts a Hasura action envelope and returns the stats response payload.",
        operationId: "hasuraFetchStats",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/HasuraActionRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Hasura action stats payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          },
          "207": {
            description: "Partial stats; one or more collectors failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StatsResponseEnvelope" }
              }
            }
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key"
      }
    },
    schemas: {
      CollectorSummary: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" }
        },
        required: ["id", "description"]
      },
      CollectorListResponse: {
        type: "object",
        properties: {
          status: { type: "string" },
          enabled: { type: "boolean" },
          collectors: { type: "array", items: { $ref: "#/components/schemas/CollectorSummary" } }
        }
      },
      CollectorAndSectionListResponse: {
        type: "object",
        properties: {
          status: { type: "string" },
          enabled: { type: "boolean" },
          collectors: { type: "array", items: { $ref: "#/components/schemas/CollectorSummary" } },
          sections: { type: "array", items: { $ref: "#/components/schemas/CollectorSection" } }
        }
      },
      SystemListResponse: {
        type: "object",
        properties: {
          systems: { type: "array", items: { $ref: "#/components/schemas/MonitoredSystem" } }
        }
      },
      ServiceLogResponse: {
        type: "object",
        properties: {
          all_ok: { type: "boolean" },
          ran_at: { type: "string", format: "date-time" },
          system_id: { type: "string" },
          service: { type: "string" },
          lines_requested: { type: "integer" },
          since: { type: "string", nullable: true },
          logs: { type: "array", items: { $ref: "#/components/schemas/ServiceLogLine" } }
        }
      },
      CollectorSection: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          cadence: { type: "string" },
          collectors: { type: "array", items: { type: "string" } }
        }
      },
      CollectorResult: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string" }, payload: { type: "object", additionalProperties: true } }
      },
      StatsResponseEnvelope: {
        type: "object",
        properties: {
          all_ok: { type: "boolean" },
          requested: { type: "array", items: { type: "string" } },
          ran_at: { type: "string", format: "date-time" },
          results: { type: "array", items: { $ref: "#/components/schemas/CollectorResult" } },
          collectors: { type: "array", items: { $ref: "#/components/schemas/CollectorResult" } },
          target: { $ref: "#/components/schemas/StatsTarget" }
        }
      },
      HasuraActionRequest: {
        type: "object",
        properties: {
          action: { type: "object", additionalProperties: true },
          input: {
            type: "object",
            description: "Args passed to /stats in query-style form",
            additionalProperties: {
              oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }]
            }
          },
          session_variables: { type: "object", additionalProperties: { type: "string" } },
          request_query: { type: "string" }
        }
      },
      SnapshotEnvelope: {
        type: "object",
        properties: {
          all_ok: { type: "boolean" },
          requested: { type: "array", items: { type: "string" } },
          ran_at: { type: "string", format: "date-time" },
          target: { $ref: "#/components/schemas/StatsTarget" },
          snapshot: { $ref: "#/components/schemas/StatsSnapshot" },
          collectors: { type: "array", items: { $ref: "#/components/schemas/CollectorResult" } }
        }
      },
      StatsSnapshot: {
        type: "object",
        properties: {
          systemId: { type: "string" },
          collectedAt: { type: "string", format: "date-time" },
          status: { type: "string" },
          cpuPercent: { type: "number", format: "float" },
          memoryPercent: { type: "number", format: "float" },
          swapPercent: { type: "number", format: "float" },
          diskPercent: { type: "number", format: "float" },
          networkInMbps: { type: "number", format: "float" },
          networkOutMbps: { type: "number", format: "float" },
          storageUsedGb: { type: "number", format: "float" },
          storageTotalGb: { type: "number", format: "float" },
          storageUsedPercent: { type: "number", format: "float" },
          storageInodePercent: { type: "number", format: "float" },
          dbSessions: { type: "integer" },
          sshSessions: { type: "integer" },
          processCount: { type: "integer" },
          uptimeHours: { type: "number", format: "float" },
          services: { type: "array", items: { type: "object" } },
          listeningPorts: { type: "array", items: { type: "object" } },
          serviceLogs: { type: "object", additionalProperties: { type: "array", items: { $ref: "#/components/schemas/ServiceLogLine" } } },
          loadAverage: { type: "number", format: "float" },
          loadAverageDetails: { type: "object", additionalProperties: true }
        }
      },
      ServiceLogLine: {
        type: "object",
        properties: {
          timestamp: { type: "string" },
          severity: { type: "string" },
          message: { type: "string" },
          unit: { type: "string", nullable: true }
        },
        required: ["timestamp", "severity", "message"]
      },
      StatsTarget: {
        type: "object",
        properties: {
          system_id: { type: "string" },
          ssh_host: { type: "string" },
          db_host: { type: "string" },
          db_port: { type: "integer" },
          has_db_password: { type: "boolean" }
        }
      },
      MonitoredSystem: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          ssh_host: { type: "string" },
          db_host: { type: "string" },
          db_port: { type: "integer" },
          sections: { type: "array", items: { $ref: "#/components/schemas/CollectorSection" } }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          message: { type: "string" },
          status: { type: "integer" }
        }
      }
    }
  }
};

if (IS_STATS_SERVICE) {
  app.get("/openapi.json", (_req, res) => {
    res.status(200).json(REPORTING_OPENAPI_SPEC);
  });

  app.get("/stats/collectors", (_req: Request, res: Response) => {
    if (!REPORTING_ENABLED) {
      res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
      return;
    }
    if (REPORTING_REQUIRE_API_KEY) {
      try {
        enforceReportingApiKey(_req);
      } catch (err) {
        const status = (err as any).status || 403;
        res.status(status).json({
          error: {
            message: (err as Error).message || "Forbidden",
            status
          }
        });
        return;
      }
    }
    res.status(200).json({
      status: "ok",
      enabled: REPORTING_ENABLED,
      sections: REPORTING_SECTION_DEFINITIONS.filter((section) => section.id !== "all").map((section) => ({
        id: section.id,
        description: section.description,
        cadence: section.cadence,
        collectors: section.collectors
      })),
      collectors: reportingCollectors.map((collector) => ({
        id: collector.id,
        description: collector.description
      }))
    });
  });

  app.get("/stats/systems", async (_req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      res.status(200).json({
        systems: [
          {
            id: REPORTING_SYSTEM_ID,
            name: REPORTING_SYSTEM_ID,
            ssh_host: REPORTING_SSH_HOST || null,
            db_host: REPORTING_DB_HOST || null,
            db_port: REPORTING_DB_PORT,
            sections: REPORTING_SECTION_DEFINITIONS.filter((section) => section.id !== "all")
          }
        ]
      });
    } catch {
      res.status(500).json({ error: { message: "Unable to list systems", status: 500 } });
    }
  });

  app.get("/stats", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);
      const args = parseQueryArgs(req.query as QueryStringRecord);
      const collector = asQueryValue(req.query.collector) || asQueryValue(req.query.collectors);
      const sections = asQueryValue(req.query.sections);
      const result = await collectRequestedReportData(collector, args, sections);
      res.status(result.all_ok ? 200 : 207).json({
        ...result,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        results: result.collectors
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });

  app.get("/stats/snapshot", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);
      const args = parseQueryArgs(req.query as QueryStringRecord);
      const fields = asStringList(asQueryValue(req.query.fields));
      const collector = asQueryValue(req.query.collector) || asQueryValue(req.query.collectors);
      const sections = asQueryValue(req.query.sections);
      const result = await collectRequestedReportData(collector, args, sections);
      const snapshot = buildSystemSnapshotFromCollectors(result.collectors as unknown as SnapshotCollectorResult[]);
      const filtered = filterSnapshotFields(snapshot, fields);
      res.status(result.all_ok ? 200 : 207).json({
        all_ok: result.all_ok,
        requested: result.requested,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        target: result.target,
        snapshot: filtered,
        collectors: result.collectors
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });

  app.get("/stats/sections/:section", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);
      const section = parseSectionParam(req.params.section);
      const args = parseQueryArgs(req.query as QueryStringRecord);
      const collector = asQueryValue(req.query.collector) || asQueryValue(req.query.collectors);
      const result = await collectRequestedReportData(collector, args, section);
      res.status(result.all_ok ? 200 : 207).json({
        ...result,
        section,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        results: result.collectors
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });

  app.get("/stats/sections/:section/snapshot", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);
      const section = parseSectionParam(req.params.section);
      const args = parseQueryArgs(req.query as QueryStringRecord);
      const fields = asStringList(asQueryValue(req.query.fields));
      const collector = asQueryValue(req.query.collector) || asQueryValue(req.query.collectors);
      const result = await collectRequestedReportData(collector, args, section);
      const snapshot = buildSystemSnapshotFromCollectors(result.collectors as unknown as SnapshotCollectorResult[]);
      const filtered = filterSnapshotFields(snapshot, fields);
      res.status(result.all_ok ? 200 : 207).json({
        all_ok: result.all_ok,
        requested: result.requested,
        section,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        target: result.target,
        snapshot: filtered,
        collectors: result.collectors
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });

  app.get("/stats/logs", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);
      const args = parseQueryArgs(req.query as QueryStringRecord);
      if (!args.service) {
        res.status(400).json({ error: { message: "service is required for /stats/logs", status: 400 } });
        return;
      }
      const result = await collectRequestedReportData("service_logs", args);
      const entries = result.collectors.find((item) => item.id === "service_logs");
      if (!entries || entries.status !== "ok") {
        const payload = entries?.payload as Record<string, unknown> | undefined;
        res.status(207).json({
          all_ok: result.all_ok,
          ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
          system_id: result.target.system_id,
          service: args.service,
          lines_requested: payload?.lines_requested || null,
          since: payload?.since || null,
          logs: payload?.logs || []
        });
        return;
      }
      const payload = entries.payload as Record<string, unknown>;
      res.status(200).json({
        all_ok: result.all_ok,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        system_id: result.target.system_id,
        service: args.service,
        lines_requested: payload.lines_requested || null,
        since: payload.since || null,
        logs: payload.logs || []
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });

  app.post("/hasura/actions/stats", async (req: Request, res: Response) => {
    try {
      if (!REPORTING_ENABLED) {
        res.status(404).json({ error: { message: "Reporting is disabled", status: 404 } });
        return;
      }
      enforceReportingApiKey(req);

      const actionBody = req.body as HasuraActionEnvelope;
      const actionInput =
        actionBody && typeof actionBody === "object" && "input" in actionBody
          ? actionBody.input
          : (req.body as unknown);

      const args = parseObjectArgs(actionInput);
      const result = await collectRequestedReportData(
        ("collector" in args ? args.collector : args.collectors) as RawQueryValue,
        args,
        args.sections
      );
      res.status(result.all_ok ? 200 : 207).json({
        ...result,
        ran_at: new Date(result.generated_at_unix * 1000).toISOString(),
        results: result.collectors
      });
    } catch (err) {
      const { message, status } = formatReportingError(err);
      const errAny = err as { causes?: unknown };
      res.status(status).json({
        error: {
          message,
          status,
          details: errAny?.causes || undefined
        }
      });
    }
  });
}

// 404 fallback for unknown routes
// 404
app.use((_req, res) => res.status(404).json({ error: { message: "Not Found", status: 404 } }));

// Error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message, status } });
});

// Start
app.listen(Number(env.PORT), "0.0.0.0", () => {
  console.log(`[vm-stats-service] listening on :${env.PORT}`);
  console.log(`[vm-stats-service] service_mode=${SERVICE_MODE}`);
  console.log(
    `[vm-stats-service] trust_proxy=${String(app.get("trust proxy"))} rate_limit_window_ms=${
      env.RATE_WINDOW_MS
    } rate_limit_max=${env.RATE_MAX}`
  );
  if (REQUIRE_API_KEY) console.log(`[vm-stats-service] API key required via header X-API-Key`);
  if (REPORTING_ENABLED) {
    console.log(
      `[vm-stats-service] reporting enabled (db_host=${REPORTING_DB_HOST || "n/a"}, ssh_host=${REPORTING_SSH_HOST || "n/a"})`
    );
  } else {
    console.log("[vm-stats-service] reporting disabled; set REPORTING_ENABLED=true to expose /stats");
  }
});
