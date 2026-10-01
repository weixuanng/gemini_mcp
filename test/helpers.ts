import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createHttpApp } from '../src/http/app.js';
import { setLogLevel } from '../src/util/log.js';

setLogLevel(process.env.TEST_LOG_LEVEL ?? 'error');

export const API_KEY = 'test-gemini-key';
export const ACCESS_KEY = 'test-access-key-0123456789-abcdefghij';

// ---- Mock Gemini Interactions API ------------------------------------------------------------

export interface MockOptions {
  /** Behave like a free-tier key: Gemini 3.x + google_search fails with a zero quota. */
  freeTier?: boolean;
  /** Number of GETs a deep-research run stays in progress. */
  deepResearchPolls?: number;
  /** Fail this many POSTs with HTTP 503 before succeeding. */
  transientFailures?: number;
  /** Models this key has no quota for (e.g. a Pro preview on a new paid project). */
  unavailableModels?: string[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  headers: IncomingMessage['headers'];
}

export interface MockGemini {
  url: string;
  requests: RecordedRequest[];
  options: MockOptions;
  lastCreate(): any;
  close(): Promise<void>;
}

const SEGMENT_1 = 'The Eiffel Tower is about 330 m tall — café owners agree ☕.';
const SEGMENT_2 = 'It was completed in 1889.';
export const ANSWER_TEXT = `**Overall:** ${SEGMENT_1} ${SEGMENT_2}\n`;
export const SOURCE_A = 'https://www.toureiffel.paris/en/the-monument/key-figures';
export const SOURCE_B = 'https://en.wikipedia.org/wiki/Eiffel_Tower';

function byteRange(text: string, segment: string): { start_index: number; end_index: number } {
  const charStart = text.indexOf(segment);
  const start = Buffer.byteLength(text.slice(0, charStart));
  return { start_index: start, end_index: start + Buffer.byteLength(segment) };
}

export async function startMockGemini(options: MockOptions = {}): Promise<MockGemini> {
  const requests: RecordedRequest[] = [];
  const deepRuns = new Map<string, { polls: number; agent: string }>();
  let counter = 0;
  let transientLeft = options.transientFailures ?? 0;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const apiError = (res: ServerResponse, code: number, status: string, message: string, wrapInArray = false) => {
    const error = { error: { code, message, status } };
    send(res, code, wrapInArray ? [error] : error);
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? '';
    requests.push({ method: req.method ?? '', path, body, headers: req.headers });

    if (req.headers['x-goog-api-key'] !== API_KEY) {
      apiError(res, 400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', true);
      return;
    }

    const getMatch = path.match(/^\/v1beta\/interactions\/([^/]+)$/);
    const cancelMatch = path.match(/^\/v1beta\/interactions\/([^/]+)\/cancel$/);

    if (req.method === 'POST' && path === '/v1beta/interactions') {
      if (transientLeft > 0) {
        transientLeft--;
        apiError(res, 503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
        return;
      }
      if (body.agent) {
        const id = `dr_${++counter}`;
        deepRuns.set(id, { polls: options.deepResearchPolls ?? 1, agent: body.agent });
        send(res, 200, { id, status: 'in_progress', agent: body.agent, created: new Date().toISOString() });
        return;
      }
      if (body.previous_interaction_id === 'expired-thread') {
        apiError(res, 404, 'NOT_FOUND', 'Interaction expired-thread not found.');
        return;
      }
      if (options.unavailableModels?.includes(body.model)) {
        apiError(res, 429, 'RESOURCE_EXHAUSTED', `Quota exceeded for metric: generate_content_requests, limit: 0, model: ${body.model}`);
        return;
      }
      const tools: string[] = (body.tools ?? []).map((t: { type: string }) => t.type);
      if (options.freeTier && tools.includes('google_search') && String(body.model).startsWith('gemini-3')) {
        apiError(
          res,
          429,
          'RESOURCE_EXHAUSTED',
          `Quota exceeded for metric: generativelanguage.googleapis.com/search_grounding_requests_free_tier, limit: 0, model: ${body.model}`,
        );
        return;
      }
      const inputText =
        typeof body.input === 'string'
          ? body.input
          : (body.input as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
      const urls = [...inputText.matchAll(/^- (https?:\/\/\S+)/gm)].map((m) => m[1]!).filter((u) => !u.includes('youtube.com'));

      const steps: any[] = [{ type: 'thought', summary: [{ type: 'text', text: 'Planning searches.' }], signature: 'sig' }];
      if (tools.includes('google_search')) {
        steps.push(
          // Narration before a tool call is not part of the final answer.
          { type: 'model_output', content: [{ type: 'text', text: 'Let me search for that. ' }] },
          { type: 'google_search_call', id: 's1', arguments: { queries: ['eiffel tower height', 'eiffel tower completion year'] } },
          { type: 'google_search_result', call_id: 's1', result: [{ search_suggestions: '<div>chips</div>' }] },
        );
      }
      if (tools.includes('url_context') && urls.length > 0) {
        steps.push(
          { type: 'model_output', content: [{ type: 'text', text: 'Let me also read the sources. ' }] },
          { type: 'url_context_call', id: 'u1', arguments: { urls } },
          {
            type: 'url_context_result',
            call_id: 'u1',
            result: urls.map((url, i) => ({ url, status: i === 1 ? 'paywall' : 'success' })),
          },
        );
      }
      steps.push({
        type: 'model_output',
        content: [
          {
            type: 'text',
            text: ANSWER_TEXT,
            annotations: [
              { type: 'url_citation', url: SOURCE_A, title: 'toureiffel.paris', ...byteRange(ANSWER_TEXT, SEGMENT_1) },
              { type: 'url_citation', url: SOURCE_A, title: 'toureiffel.paris', ...byteRange(ANSWER_TEXT, SEGMENT_2) },
              { type: 'url_citation', url: SOURCE_B, title: 'wikipedia.org', ...byteRange(ANSWER_TEXT, SEGMENT_2) },
            ],
          },
        ],
      });
      send(res, 200, {
        id: `int_${++counter}`,
        status: 'completed',
        model: body.model,
        steps,
        usage: { total_input_tokens: 1234, total_output_tokens: 456, total_thought_tokens: 789 },
      });
      return;
    }

    if (req.method === 'GET' && getMatch) {
      const id = decodeURIComponent(getMatch[1]!);
      const run = deepRuns.get(id);
      if (!run) {
        apiError(res, 404, 'NOT_FOUND', `Interaction ${id} not found.`);
        return;
      }
      if (run.polls > 0) {
        run.polls--;
        send(res, 200, {
          id,
          status: 'in_progress',
          agent: run.agent,
          created: new Date(Date.now() - 4 * 60_000).toISOString(),
          steps: [{ type: 'thought', summary: [{ type: 'text', text: 'Reading 14 sources on EV battery recycling.' }] }],
        });
        return;
      }
      send(res, 200, {
        id,
        status: 'completed',
        agent: run.agent,
        steps: [
          { type: 'google_search_call', id: 'd1', arguments: { queries: ['ev battery recycling rates 2026'] } },
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: '# Report\nRecycling rates rose sharply.',
                annotations: [{ type: 'url_citation', url: SOURCE_B, title: 'wikipedia.org', start_index: 9, end_index: 39 }],
              },
            ],
          },
        ],
        usage: { total_input_tokens: 250000, total_output_tokens: 60000 },
      });
      return;
    }

    if (req.method === 'POST' && cancelMatch) {
      send(res, 200, { id: decodeURIComponent(cancelMatch[1]!), status: 'cancelled' });
      return;
    }

    apiError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${path}`);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    options,
    lastCreate: () => [...requests].reverse().find((r) => r.method === 'POST' && r.path === '/v1beta/interactions')?.body,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---- App under test -------------------------------------------------------------------------

export interface RunningApp {
  baseUrl: string;
  cfg: AppConfig;
  close(): Promise<void>;
}

export async function startApp(env: Record<string, string>): Promise<RunningApp> {
  const cfg = loadConfig(
    {
      GEMINI_API_KEY: API_KEY,
      MCP_ACCESS_KEY: ACCESS_KEY,
      HOST: '127.0.0.1',
      TRUST_PROXY: 'false',
      ...env,
    },
    'http',
  );
  const app = createHttpApp(cfg, buildDeps(cfg));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cfg,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- OAuth client provider for the MCP SDK client -------------------------------------------

export const TEST_REDIRECT = 'http://localhost:43210/callback';

export class TestOAuthProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  tokenSet?: OAuthTokens;
  verifier?: string;
  authorizationUrl?: URL;

  get redirectUrl(): string {
    return TEST_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test MCP Client',
      redirect_uris: [TEST_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.tokenSet;
  }
  saveTokens(tokens: OAuthTokens) {
    this.tokenSet = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('no verifier');
    return this.verifier;
  }
}

/** Plays the user: opens the consent page, types the access key, and returns the redirect. */
export async function completeConsent(
  baseUrl: string,
  authorizationUrl: URL,
  accessKey: string,
  action: 'approve' | 'deny' = 'approve',
): Promise<Response> {
  const page = await fetch(authorizationUrl);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`consent page HTTP ${page.status}: ${html}`);
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
  if (!request) throw new Error('no request field on consent page');
  return fetch(`${baseUrl}/authorize/consent`, {
    method: 'POST',
    body: new URLSearchParams({ request, access_key: accessKey, action }),
    redirect: 'manual',
  });
}
