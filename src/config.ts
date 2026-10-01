export type Tier = 'free' | 'paid';
export type AuthMode = 'oauth' | 'bearer' | 'none';
export type TransportKind = 'http' | 'stdio';

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  /** Free tier: Gemini 3.x models cannot use Google Search, so grounded calls use `freeSearchModel`. */
  tier: Tier;
  model: string;
  deepModel: string;
  freeSearchModel: string;
  /** Store interactions on Google's side so follow-ups can reuse them via thread_id. */
  store: boolean;
  /** Overall budget for one tool call's Gemini request(s), including retries. */
  timeoutMs: number;
  /** Optional standing context about the user, added to every Gemini system instruction. */
  userContext?: string;
  deepResearch: {
    enabled: boolean;
    agent: string;
    maxAgent: string;
  };
}

export interface AuthConfig {
  mode: AuthMode;
  /** Shared secret: typed on the OAuth consent page, or sent directly as a Bearer token. */
  accessKey?: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Redirect URIs allowed in addition to Claude's callback and loopback URLs. */
  extraRedirectUris: string[];
  /** Skip the redirect allowlist entirely (accept any https or loopback redirect URI). */
  allowAnyRedirectUri: boolean;
}

export interface HttpConfig {
  port: number;
  host: string;
  /** Canonical external base URL, e.g. https://gemini-mcp-123.us-central1.run.app (derived per request when unset). */
  publicUrl?: string;
  trustProxy: boolean | number | string;
}

export interface AppConfig {
  transport: TransportKind;
  gemini: GeminiConfig;
  auth: AuthConfig;
  http: HttpConfig;
  /** Max Gemini-backed tool calls per UTC day per server instance (0 = unlimited). */
  dailyCallLimit: number;
  /** Tool results longer than this are truncated (Claude Code's default cap is ~25k tokens). */
  maxOutputChars: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

const MIN_ACCESS_KEY_LENGTH = 24;

export function loadConfig(env: Env, transport: TransportKind): AppConfig {
  const problems: string[] = [];

  const apiKey = str(env.GEMINI_API_KEY) ?? str(env.GOOGLE_API_KEY);
  if (!apiKey) {
    problems.push('GEMINI_API_KEY is required (create one at https://aistudio.google.com/apikey).');
  }

  const tier = enumValue(env.GEMINI_TIER, ['free', 'paid'] as const, 'free', 'GEMINI_TIER', problems);
  const model = str(env.GEMINI_MODEL) ?? 'gemini-3.8-flash';
  const deepModel = str(env.GEMINI_DEEP_MODEL) ?? (tier === 'paid' ? 'gemini-3.1-pro-preview' : model);

  const gemini: GeminiConfig = {
    apiKey: apiKey ?? '',
    baseUrl: (str(env.GEMINI_API_BASE_URL) ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    apiVersion: str(env.GEMINI_API_VERSION) ?? 'v1beta',
    tier,
    model,
    deepModel,
    freeSearchModel: str(env.GEMINI_FREE_SEARCH_MODEL) ?? 'gemini-2.5-flash',
    store: bool(env.GEMINI_STORE, true, 'GEMINI_STORE', problems),
    timeoutMs: int(env.GEMINI_TIMEOUT_MS, 200_000, 'GEMINI_TIMEOUT_MS', problems, 5_000, 3_600_000),
    userContext: str(env.GEMINI_USER_CONTEXT),
    deepResearch: {
      enabled: bool(env.ENABLE_DEEP_RESEARCH, false, 'ENABLE_DEEP_RESEARCH', problems),
      agent: str(env.DEEP_RESEARCH_AGENT) ?? 'deep-research-preview-04-2026',
      maxAgent: str(env.DEEP_RESEARCH_MAX_AGENT) ?? 'deep-research-max-preview-04-2026',
    },
  };

  const authMode = enumValue(env.AUTH_MODE, ['oauth', 'bearer', 'none'] as const, 'oauth', 'AUTH_MODE', problems);
  const accessKey = str(env.MCP_ACCESS_KEY);
  if (transport === 'http' && authMode !== 'none') {
    if (!accessKey) {
      problems.push(
        'MCP_ACCESS_KEY is required for the HTTP server (generate one with: openssl rand -base64 32). ' +
          'Set AUTH_MODE=none only for local testing.',
      );
    } else if (accessKey.length < MIN_ACCESS_KEY_LENGTH) {
      problems.push(`MCP_ACCESS_KEY must be at least ${MIN_ACCESS_KEY_LENGTH} characters (use a random value).`);
    }
  }

  const auth: AuthConfig = {
    mode: authMode,
    accessKey,
    accessTokenTtlSeconds: int(env.ACCESS_TOKEN_TTL_SECONDS, 3600, 'ACCESS_TOKEN_TTL_SECONDS', problems, 60, 86_400),
    refreshTokenTtlSeconds: int(
      env.REFRESH_TOKEN_TTL_SECONDS,
      90 * 86_400,
      'REFRESH_TOKEN_TTL_SECONDS',
      problems,
      3600,
      400 * 86_400,
    ),
    extraRedirectUris: list(env.OAUTH_EXTRA_REDIRECT_URIS),
    allowAnyRedirectUri: bool(env.OAUTH_ALLOW_ANY_REDIRECT_URI, false, 'OAUTH_ALLOW_ANY_REDIRECT_URI', problems),
  };

  let publicUrl = str(env.PUBLIC_URL);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) {
        problems.push('PUBLIC_URL must use https:// (http is only allowed for localhost).');
      }
      publicUrl = u.origin;
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
    }
  }

  const http: HttpConfig = {
    port: int(env.PORT, 8080, 'PORT', problems, 1, 65_535),
    host: str(env.HOST) ?? '0.0.0.0',
    publicUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };

  const dailyCallLimit = int(env.DAILY_CALL_LIMIT, 300, 'DAILY_CALL_LIMIT', problems, 0, 1_000_000);
  const maxOutputChars = int(env.MAX_OUTPUT_CHARS, 60_000, 'MAX_OUTPUT_CHARS', problems, 2_000, 140_000);

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }

  return { transport, gemini, auth, http, dailyCallLimit, maxOutputChars };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function str(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean, name: string, problems: string[]): boolean {
  const v = str(value)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be true or false (got "${value}").`);
  return fallback;
}

function int(
  value: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
  min: number,
  max: number,
): number {
  const v = str(value);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${value}").`);
    return fallback;
  }
  return n;
}

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
  problems: string[],
): T {
  const v = str(value)?.toLowerCase();
  if (v === undefined) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  problems.push(`${name} must be one of ${allowed.join(', ')} (got "${value}").`);
  return fallback;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = str(value);
  if (v === undefined) return 1; // Cloud Run: one Google front-end hop
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : v;
}
