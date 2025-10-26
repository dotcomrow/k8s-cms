import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { Agent, request as undiciRequest, setGlobalDispatcher } from "undici";
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
  GITHUB_API_BASE: z.string().default("https://api.github.com")
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

type GitHubEmail = { email: string; primary?: boolean; verified?: boolean; visibility?: string | null };
type GitHubTeam = {
  name: string;
  slug: string;
  organization: { login: string };
  role?: "member" | "maintainer";
};
type GitHubUser = {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  html_url?: string;
};

async function ghFetch<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
  const url = `${env.GITHUB_API_BASE}${path}`;
  const { statusCode, body } = await undiciRequest(url, {
    method: "GET",
    headers: {
      "User-Agent": "directus-github-profile-proxy/1.0",
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
    return JSON.parse(text) as T;
  } catch {
    const err = new Error(`GitHub API ${path} returned non-JSON`);
    (err as any).status = 502;
    throw err;
  }
}

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
  const key = req.get("X-API-Key");
  if (!key || key !== env.API_KEY) {
    const e = new Error("Forbidden: missing or invalid API key");
    (e as any).status = 403;
    throw e;
  }
}

async function fetchProfileBundle(token: string) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(env.TIMEOUT_MS));
  try {
    const [user, emails, teams] = await Promise.all([
      ghFetch<GitHubUser>("/user", token, ac.signal),
      ghFetch<GitHubEmail[]>("/user/emails", token, ac.signal).catch(() => []),
      ghFetch<GitHubTeam[]>("/user/teams", token, ac.signal).catch(() => [])
    ]);

    // Email resolution
    let email = user.email ?? null;
    if (!email && Array.isArray(emails)) {
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }

    // Groups from teams
    const groups: string[] = [];
    if (Array.isArray(teams)) {
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
    }

    return {
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      email,
      groups,
      avatar_url: user.avatar_url,
      html_url: user.html_url
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
