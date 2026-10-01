import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../config.js';
import { GeminiApiError, GeminiTimeoutError } from '../gemini/client.js';
import { parseInteraction, renderParsed } from '../gemini/result.js';
import { ThreadUnavailableError, type GeminiRunner, type TaskSpec } from '../gemini/runner.js';
import type { InputContent } from '../gemini/types.js';
import type { DailyLimiter } from '../util/limits.js';
import { errorMessage, log } from '../util/log.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolDeps {
  cfg: AppConfig;
  runner: GeminiRunner;
  limiter: DailyLimiter;
}

export const READ_ONLY_WEB_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// ---- Shared input fields -------------------------------------------------------------------

export const contextField = z
  .string()
  .max(100_000)
  .optional()
  .describe(
    "Background Gemini needs, since it cannot see this conversation: the user's goal or question, relevant details " +
      '(location, timeframe, units, constraints), and what you already found and from where.',
  );

export const depthField = z
  .enum(['quick', 'standard', 'deep'])
  .default('standard')
  .describe(
    "How hard Gemini should work: 'quick' (fast, light reasoning), 'standard' (default), or 'deep' " +
      '(strongest model and maximum reasoning; slower — use for high-stakes or tricky checks).',
  );

export const threadIdField = z
  .string()
  .max(512)
  .optional()
  .describe(
    'Continue an earlier Gemini exchange: pass the thread_id from a previous gemini_* result and Gemini will ' +
      'remember that whole exchange. Omit to start fresh.',
  );

// ---- URL helpers ---------------------------------------------------------------------------

/** Accepts "example.com/page" as well as full URLs; returns undefined for anything that isn't http(s). */
export function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Returns a canonical watch URL for public YouTube video links, else undefined. */
export function youtubeWatchUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined;
}

export function splitUrls(rawUrls: string[]): { web: string[]; youtube: string[]; invalid: string[] } {
  const web: string[] = [];
  const youtube: string[] = [];
  const invalid: string[] = [];
  for (const raw of rawUrls) {
    const url = normalizeUrl(raw);
    if (!url) {
      invalid.push(raw);
      continue;
    }
    const yt = youtubeWatchUrl(url);
    if (yt) {
      if (!youtube.includes(yt)) youtube.push(yt);
    } else if (!web.includes(url)) {
      web.push(url);
    }
  }
  return { web, youtube, invalid };
}

// ---- Execution -----------------------------------------------------------------------------

export interface RunArgs {
  toolName: string;
  heading: string;
  spec: TaskSpec;
  extraNotes?: string[];
}

export async function runGeminiTool(deps: ToolDeps, extra: ToolExtra, args: RunArgs): Promise<CallToolResult> {
  const quota = deps.limiter.tryConsume();
  if (!quota.ok) {
    return errorResult(
      `This server's daily safety limit of ${quota.limit} Gemini calls has been reached (DAILY_CALL_LIMIT). ` +
        'It resets at 00:00 UTC; the server owner can raise it.',
    );
  }

  const started = Date.now();
  const stopProgress = startProgress(extra, 'Gemini is working');
  try {
    const outcome = await deps.runner.run(args.spec, {
      signal: extra.signal,
      deadline: started + deps.cfg.gemini.timeoutMs,
    });
    const parsed = parseInteraction(outcome.interaction);
    const threadId = deps.cfg.gemini.store ? outcome.interaction.id : undefined;
    const text = renderParsed(parsed, {
      heading: args.heading,
      model: outcome.model,
      toolsLabel: outcome.toolsLabel,
      notes: [...outcome.notes, ...(args.extraNotes ?? [])],
      threadId,
      threadHint: threadId
        ? `pass this as \`thread_id\` to any gemini_* tool to continue with Gemini's memory of this exchange (kept ${deps.runner.threadRetention}).`
        : undefined,
      maxChars: deps.cfg.maxOutputChars,
    });
    log.info('tool call completed', {
      tool: args.toolName,
      model: outcome.model,
      ms: Date.now() - started,
      status: parsed.status,
      searches: parsed.searchQueries.length,
      sources: parsed.sources.length,
      inputTokens: parsed.usage?.total_input_tokens,
      outputTokens: parsed.usage?.total_output_tokens,
    });
    return {
      content: [{ type: 'text', text }],
      ...(parsed.status === 'failed' ? { isError: true } : {}),
    };
  } catch (err) {
    log.warn('tool call failed', { tool: args.toolName, ms: Date.now() - started, error: errorMessage(err) });
    return errorResult(describeError(err, deps));
  } finally {
    stopProgress();
  }
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function describeError(err: unknown, deps: ToolDeps): string {
  if (err instanceof ThreadUnavailableError) return err.message;
  if (err instanceof GeminiTimeoutError) {
    return (
      `Gemini didn't finish within ${Math.round(deps.cfg.gemini.timeoutMs / 1000)} seconds. ` +
      "Try depth='quick', fewer claims or URLs per call, or split the request."
    );
  }
  if (err instanceof GeminiApiError) {
    const msg = err.message;
    if (err.reason === 'API_KEY_INVALID' || /api key not valid/i.test(msg) || err.httpStatus === 401) {
      return (
        `The Gemini API key configured on this server was rejected (${msg}). It may be mistyped, deleted, or blocked as leaked. ` +
        'Create a new key at https://aistudio.google.com/apikey and run: UPDATE_GEMINI_KEY=1 ./deploy/cloudrun.sh'
      );
    }
    if (/location is not supported/i.test(msg)) {
      return `Gemini refused the request because the server's region isn't supported by the Gemini API: ${msg}`;
    }
    if (err.httpStatus === 429) {
      return (
        `Gemini rate limit or quota reached: ${msg}\n` +
        'Free-tier keys have low per-minute and per-day limits. Wait a bit and retry, use fewer calls, or enable billing for the key in Google AI Studio.'
      );
    }
    if (err.httpStatus === 403) return `Gemini denied the request (HTTP 403): ${msg}`;
    if (err.httpStatus >= 500) return `Gemini is having problems right now (HTTP ${err.httpStatus}): ${msg}. Try again shortly.`;
    return `Gemini API error (HTTP ${err.httpStatus}${err.status ? ` ${err.status}` : ''}): ${msg}`;
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'The request was cancelled before Gemini finished.';
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `Couldn't reach the Gemini API (network error${cause?.code || cause?.message ? `: ${cause.code ?? cause.message}` : ''}). Try again shortly.`;
  }
  return `Unexpected error while calling Gemini: ${errorMessage(err)}`;
}

/**
 * Sends MCP progress notifications while Gemini works, when the client asked for them. Besides showing
 * status, progress lets clients that support it extend their request timeout.
 */
export function startProgress(extra: ToolExtra, label: string, intervalMs = 10_000): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  const started = Date.now();
  let progress = 0;
  const timer = setInterval(() => {
    progress++;
    const seconds = Math.round((Date.now() - started) / 1000);
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message: `${label} (${seconds}s elapsed)` },
      })
      .catch(() => {});
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Max YouTube videos per request (the API allows up to 10; fewer keeps latency and cost sane). */
export const MAX_VIDEOS = 5;

/** Plain text, or text plus attached YouTube videos (url_context cannot read YouTube; video input can). */
export function buildInput(text: string, youtubeUrls: string[]): string | InputContent[] {
  if (youtubeUrls.length === 0) return text;
  return [{ type: 'text', text }, ...youtubeUrls.map((uri) => ({ type: 'video' as const, uri }))];
}

export function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item.replace(/\s*\n\s*/g, ' ')}`).join('\n');
}

export function section(title: string, body: string | undefined): string {
  const b = body?.trim();
  return b ? `## ${title}\n${b}` : '';
}

export function joinSections(...parts: string[]): string {
  return parts.filter(Boolean).join('\n\n');
}
