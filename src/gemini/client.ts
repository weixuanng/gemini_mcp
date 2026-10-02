import type { CreateInteractionBody, Interaction } from './types.js';
import { log } from '../util/log.js';
import { sleep } from '../util/sleep.js';

export interface GeminiClientOptions {
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  /** Aborted when the MCP client cancels the tool call. */
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms) covering all attempts. */
  deadline: number;
}

const MAX_ATTEMPTS = 3;
const MAX_SERVER_RETRY_DELAY_MS = 20_000;

export class GeminiApiError extends Error {
  override name = 'GeminiApiError';

  constructor(
    message: string,
    readonly httpStatus: number,
    readonly status?: string,
    readonly reason?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** A quota of zero means the feature or model isn't included in this tier (typical free-tier response). */
  get isQuotaZero(): boolean {
    return /limit:\s*0\b/i.test(this.message);
  }

  /**
   * "This model/tool isn't part of your plan" rather than "slow down". Plain 429 rate-limit messages also
   * mention billing, so for 429s only a zero quota counts.
   */
  get looksLikeTierRestriction(): boolean {
    if (this.isQuotaZero) return true;
    if (this.httpStatus !== 400 && this.httpStatus !== 403) return false;
    return /free[ -]?tier|requires? (?:a )?(?:paid|billing)|billing (?:account )?(?:is )?(?:required|not enabled)|not available (?:on|for|in) (?:the |your )?(?:free|current) (?:tier|plan)/i.test(
      this.message,
    );
  }

  /** The model itself can't be used with this key: retired, closed to new users, or unknown. */
  get isModelUnavailable(): boolean {
    if (!/\bmodels?\b/i.test(this.message)) return false;
    if (this.httpStatus === 404) return true;
    return this.httpStatus === 400 && /no longer available|not found|does not exist|unknown model|is not available/i.test(this.message);
  }

  get isTransient(): boolean {
    if (this.httpStatus === 429) return !this.isQuotaZero;
    return [408, 500, 502, 503, 504].includes(this.httpStatus);
  }
}

export class GeminiTimeoutError extends Error {
  override name = 'GeminiTimeoutError';
}

export class GeminiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  createInteraction(body: CreateInteractionBody, opts: RequestOptions): Promise<Interaction> {
    return this.request<Interaction>('POST', 'interactions', body, opts);
  }

  getInteraction(id: string, opts: RequestOptions): Promise<Interaction> {
    return this.request<Interaction>('GET', `interactions/${encodeURIComponent(id)}`, undefined, opts);
  }

  cancelInteraction(id: string, opts: RequestOptions): Promise<Interaction> {
    return this.request<Interaction>('POST', `interactions/${encodeURIComponent(id)}/cancel`, {}, opts);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: RequestOptions): Promise<T> {
    const url = `${this.opts.baseUrl}/${this.opts.apiVersion}/${path}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = opts.deadline - Date.now();
      if (remaining <= 0) break;
      opts.signal?.throwIfAborted();

      const timeout = AbortSignal.timeout(remaining);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            'x-goog-api-key': this.opts.apiKey,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        if (res.ok) {
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new GeminiApiError(`Gemini API returned invalid JSON (HTTP ${res.status}).`, res.status);
          }
        }
        throw parseApiError(res.status, text, res.headers.get('retry-after'));
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (timeout.aborted) {
          throw new GeminiTimeoutError('Gemini did not respond in time.');
        }
        lastError = err;
        const retryable = err instanceof GeminiApiError ? err.isTransient : isNetworkError(err);
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;

        const serverDelay = err instanceof GeminiApiError ? err.retryAfterMs : undefined;
        if (serverDelay !== undefined && serverDelay > MAX_SERVER_RETRY_DELAY_MS) throw err;
        const delay = serverDelay ?? (attempt === 1 ? 1_000 : 3_000);
        if (Date.now() + delay >= opts.deadline) throw err;

        log.warn('Retrying Gemini request', {
          attempt,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay, opts.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new GeminiTimeoutError('Gemini did not respond in time.');
  }
}

function parseApiError(httpStatus: number, bodyText: string, retryAfterHeader: string | null): GeminiApiError {
  let message = `Gemini API error (HTTP ${httpStatus})`;
  let status: string | undefined;
  let reason: string | undefined;
  let retryAfterMs = parseRetryAfterHeader(retryAfterHeader);

  try {
    const parsed: unknown = JSON.parse(bodyText);
    // The API sometimes wraps the error object in an array.
    const container = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: Record<string, unknown> } | undefined;
    const error = container?.error;
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string' && error.message) message = error.message;
      if (typeof error.status === 'string') status = error.status;
      const details = Array.isArray(error.details) ? (error.details as Array<Record<string, unknown>>) : [];
      for (const d of details) {
        const type = typeof d['@type'] === 'string' ? (d['@type'] as string) : '';
        if (type.endsWith('ErrorInfo') && typeof d.reason === 'string') reason = d.reason;
        if (type.endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
          const seconds = Number.parseFloat(d.retryDelay);
          if (Number.isFinite(seconds)) retryAfterMs = Math.ceil(seconds * 1000);
        }
      }
    }
  } catch {
    if (bodyText.trim()) message = `${message}: ${bodyText.trim().slice(0, 300)}`;
  }
  return new GeminiApiError(message, httpStatus, status, reason, retryAfterMs);
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError; // fetch() rejects with TypeError on network failures
}
