import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, request as undiciRequest, setGlobalDispatcher, Headers } from "undici";
import { z } from "zod";

/** -----------------------------
 * Env configuration & parsing
 * ----------------------------*/
const envSchema = z.object({
  PORT: z.string().default("8080"),

  REQUIRE_API_KEY: z.string().default("false"),
  API_KEY: z.string().optional(),
  ALLOWLIST_ORGS: z.string().default(""),
  GROUP_FORMAT: z.enum(["org:team", "org/team", "team"]).default("org:team"),
  GROUP_PREFIX: z.string().default(""),
  INCLUDE_ORG_AS_GROUP: z.string().default("false"),
  INCLUDE_ROLE_SUFFIX: z.string().default("false"),

  // Extra includes (default: safe/lightweight)
  INCLUDE_ORGS: z.string().default("true"),
  INCLUDE_ORG_MEMBERSHIPS: z.string().default("true"),
  INCLUDE_TEAMS: z.string().default("true"),
  INCLUDE_EMAILS: z.string().default("true"),
  INCLUDE_SSH_KEYS: z.string().default("true"),
  INCLUDE_GPG_KEYS: z.string().default("true"),
  INCLUDE_INSTALLATIONS: z.string().default("false"),
  INCLUDE_REPOS: z.string().default("false"), // can be heavy

  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("60"),
  TIMEOUT_MS: z.string().default("8000"),
  GITHUB_API_BASE: z.string().default("https://api.github.com")
});

const env = envSchema.parse(process.env);

const toBool = (v: string | undefined) => String(v || "").toLowerCase() === "true";
const splitCSV = (v: string | undefined) =>
  String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

const REQUIRE_API_KEY = toBool(env.REQUIRE_API_KEY);
const INCLUDE_ORG_AS_GROUP = toBool(env.INCLUDE_ORG_AS_GROUP);
const INCLUDE_ROLE_SUFFIX = toBool(env.INCLUDE_ROLE_SUFFIX);
const ALLOWED_ORGS = new Set(splitCSV(env.ALLOWLIST_ORGS));

const INC = {
  ORGS: toBool(env.INCLUDE_ORGS),
  ORG_MEMBERSHIPS: toBool(env.INCLUDE_ORG_MEMBERSHIPS),
  TEAMS: toBool(env.INCLUDE_TEAMS),
  EMAILS: toBool(env.INCLUDE_EMAILS),
  SSH_KEYS: toBool(env.INCLUDE_SSH_KEYS),
  GPG_KEYS: toBool(env.INCLUDE_GPG_KEYS),
  INSTALLATIONS: toBool(env.INCLUDE_INSTALLATIONS),
  REPOS: toBool(env.INCLUDE_REPOS)
};

/** -----------------------------
 * HTTP client setup
 * ----------------------------*/
setGlobalDispatcher(
  new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 })
);

// --- Types (subset + extras we use) ---
type GitHubEmail = { email: string; primary?: boolean; verified?: boolean; visibility?: string | null };
type GitHubTeam = {
  id: number;
  name: string;
  slug: string;
  organization: { login: string; id?: number };
  permission?: string;     // classic teams
  privacy?: string;
  role?: "member" | "maintainer"; // from /user/teams
};
type GitHubOrg = { id: number; login: string; description?: string; avatar_url?: string; html_url?: string };
type GitHubOrgMembership = { organization: GitHubOrg; state: "active" | "pending"; role: "admin" | "member" };
type GitHubKey = { id: number; key: string; title?: string; created_at?: string; verified?: boolean };
type GitHubGpgKey = { id: number; key_id?: string; public_key: string; created_at?: string; can_sign?: boolean };
type GitHubInstallation = { id: number; account: { login: string; id: number; type: string } };
type GitHubRepo = { id: number; name: string; full_name: string; private: boolean; fork: boolean; html_url: string };
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
  site_admin?: boolean;
  hireable?: boolean | null;
  suspended_at?: string | null;
  created_at?: string;
  updated_at?: string;
  followers?: number;
  following?: number;
  public_repos?: number;
  public_gists?: number;
  total_private_repos?: number;
  owned_private_repos?: number;
  plan?: { name: string; space: number; collaborators: number; private_repos: number };
};

// generic GitHub GET that returns data + headers
async function ghGet<T>(path: string, token: string, signal: AbortSignal): Promise<{ data: T; headers: Headers }> {
  const url = `${env.GITHUB_API_BASE}${path}`;
  const { statusCode, body, headers } = await undiciRequest(url, {
    method: "GET",
    headers: {
      "User-Agent": "directus-github-profile-proxy/1.1",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal
  });
  const text = await body.text();
  if (statusCode >= 400) {
    const err = new Error(`GitHub API ${path} failed: ${statusCode} ${text}`);
    (err as any).status = 502;
    throw err;
  }
  try {
    return { data: JSON.parse(text) as T, headers };
  } catch {
    const err = new Error(`GitHub API ${path} returned non-JSON`);
    (err as any).status = 502;
    throw err;
  }
}

function formatGroup(opts: { org: string; team: string; role?: string }): string {
  let base: string;
  switch (env.GROUP_FORMAT) {
    case "team": base = opts.team; break;
    case "org/team": base = `${opts.org}/${opts.team}`; break;
    case "org:team":
    default: base = `${opts.org}:${opts.team}`;
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

/** -----------------------------
 * Data aggregation
 * ----------------------------*/
async function fetchProfileBundle(token: string) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(env.TIMEOUT_MS));
  try {
    // Base user + header-derived metadata
    const { data: user, headers: userHdrs } = await ghGet<GitHubUser>("/user", token, ac.signal);

    const scopes = (userHdrs.get("x-oauth-scopes") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const rate = {
      limit: Number(userHdrs.get("x-ratelimit-limit") || 0),
      remaining: Number(userHdrs.get("x-ratelimit-remaining") || 0),
      reset: Number(userHdrs.get("x-ratelimit-reset") || 0)
    };

    // Parallel optional fetches
    const [
      emailsRes,
      teamsRes,
      orgsRes,
      orgMshipsRes,
      sshRes,
      gpgRes,
      installsRes,
      reposRes
    ] = await Promise.all([
      INC.EMAILS ? ghGet<GitHubEmail[]>("/user/emails", token, ac.signal).catch(() => ({ data: [] as GitHubEmail[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubEmail[], headers: new Headers() }),
      INC.TEAMS ? ghGet<GitHubTeam[]>("/user/teams", token, ac.signal).catch(() => ({ data: [] as GitHubTeam[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubTeam[], headers: new Headers() }),
      INC.ORGS ? ghGet<GitHubOrg[]>("/user/orgs", token, ac.signal).catch(() => ({ data: [] as GitHubOrg[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubOrg[], headers: new Headers() }),
      INC.ORG_MEMBERSHIPS ? ghGet<GitHubOrgMembership[]>("/user/memberships/orgs", token, ac.signal).catch(() => ({ data: [] as GitHubOrgMembership[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubOrgMembership[], headers: new Headers() }),
      INC.SSH_KEYS ? ghGet<GitHubKey[]>("/user/keys", token, ac.signal).catch(() => ({ data: [] as GitHubKey[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubKey[], headers: new Headers() }),
      INC.GPG_KEYS ? ghGet<GitHubGpgKey[]>("/user/gpg_keys", token, ac.signal).catch(() => ({ data: [] as GitHubGpgKey[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubGpgKey[], headers: new Headers() }),
      INC.INSTALLATIONS ? ghGet<{ total_count: number; installations: GitHubInstallation[] }>("/user/installations", token, ac.signal).catch(() => ({ data: { total_count: 0, installations: [] }, headers: new Headers() })) : Promise.resolve({ data: { total_count: 0, installations: [] }, headers: new Headers() }),
      INC.REPOS ? ghGet<GitHubRepo[]>("/user/repos?per_page=100&sort=updated", token, ac.signal).catch(() => ({ data: [] as GitHubRepo[], headers: new Headers() })) : Promise.resolve({ data: [] as GitHubRepo[], headers: new Headers() })
    ]);

    const emails = emailsRes.data || [];
    const teams = teamsRes.data || [];
    const orgs = orgsRes.data || [];
    const orgMemberships = orgMshipsRes.data || [];
    const sshKeys = sshRes.data || [];
    const gpgKeys = gpgRes.data || [];
    const installations = installsRes.data || { total_count: 0, installations: [] };
    const repos = reposRes.data || [];

    // Email resolution (prefer primary+verified)
    let resolvedEmail = user.email ?? null;
    if (!resolvedEmail && emails.length) {
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      resolvedEmail = primary?.email ?? null;
    }

    // Groups from teams (respect allowlist & formatting)
    const groups: string[] = [];
    for (const t of teams) {
      const org = t?.organization?.login;
      const team = t?.slug || t?.name;
      if (!org || !team) continue;
      if (ALLOWED_ORGS.size && !ALLOWED_ORGS.has(org)) continue;
      groups.push(formatGroup({ org, team, role: t.role }));
      if (INCLUDE_ORG_AS_GROUP) groups.push(env.GROUP_PREFIX ? `${env.GROUP_PREFIX}${org}` : org);
    }

    // Build rich response (keep top-level fields friendly to Directus)
    return {
      // Minimal identity (unchanged)
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      email: resolvedEmail,
      groups,

      // Handy identity links
      avatar_url: user.avatar_url,
      html_url: user.html_url,

      // Profile details
      profile: {
        company: user.company ?? null,
        blog: user.blog ?? null,
        location: user.location ?? null,
        bio: user.bio ?? null,
        twitter_username: user.twitter_username ?? null,
        site_admin: !!user.site_admin,
        hireable: user.hireable ?? null,
        suspended_at: user.suspended_at ?? null,
        created_at: user.created_at ?? null,
        updated_at: user.updated_at ?? null
      },

      // Counts & plan
      stats: {
        followers: user.followers ?? 0,
        following: user.following ?? 0,
        public_repos: user.public_repos ?? 0,
        public_gists: user.public_gists ?? 0,
        total_private_repos: user.total_private_repos ?? undefined,
        owned_private_repos: user.owned_private_repos ?? undefined
      },
      plan: user.plan ?? null,

      // Collections (conditioned by env toggles)
      emails, // may be []
      orgs,   // may be []
      org_memberships: orgMemberships, // may be []
      teams: teams.map(t => ({
        id: t.id,
        org: t.organization?.login,
        slug: t.slug,
        name: t.name,
        role: t.role,          // member | maintainer
        permission: t.permission, // read | write | admin (classic)
        privacy: t.privacy
      })),
      ssh_keys: sshKeys.map(k => ({ id: k.id, title: k.title, key: k.key, created_at: k.created_at, verified: k.verified })),
      gpg_keys: gpgKeys.map(k => ({ id: k.id, key_id: k.key_id, public_key: k.public_key, created_at: k.created_at, can_sign: k.can_sign })),
      installations: {
        total_count: installations.total_count ?? 0,
        list: installations.installations ?? []
      },
      repos: INC.REPOS
        ? repos.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, private: r.private, fork: r.fork, html_url: r.html_url }))
        : undefined,

      // Token / rate diagnostics
      oauth: {
        scopes
      },
      rate_limit: rate
    };
  } finally {
    clearTimeout(timer);
  }
}

/** -----------------------------
 * Express app
 * ----------------------------*/
const app = express();
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
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
      error: { message: (err as Error).message || "Internal Server Error", status }
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
