import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, request as undiciRequest, setGlobalDispatcher } from "undici";
import type { IncomingHttpHeaders } from "http";
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
      "User-Agent": "directus-github-profile-proxy/1.2",
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
    legacyHeaders: false
  })
);

// Health
app.get("/", (_req, res) => res.status(200).json({ status: "ok" }));

// Main profile endpoint for Directus AUTH_GITHUB_PROFILE_URL
app.get("/github", async (req: Request, res: Response) => {
  try {
    enforceApiKey(req);
    const token = getBearerToken(req);
    const profile = await fetchProfileBundle(token);
    res.status(200).json(profile);
  } catch (err) {
    const status = (err as any).status || 500;
    res.status(status).json({
      error: {
        message: (err as Error).message || "Internal Server Error",
        status
      }
    });
  }
});

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
  console.log(`[profile-proxy] listening on :${env.PORT}`);
  if (REQUIRE_API_KEY) console.log(`[profile-proxy] API key required via header X-API-Key`);
});
