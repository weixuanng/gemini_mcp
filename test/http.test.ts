import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ACCESS_KEY,
  SOURCE_A,
  SOURCE_B,
  TEST_REDIRECT,
  TestOAuthProvider,
  completeConsent,
  startApp,
  startMockGemini,
  type MockGemini,
  type RunningApp,
} from './helpers.js';

function textOf(result: unknown): string {
  const r = result as CallToolResult;
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

async function connectWithOAuth(app: RunningApp): Promise<{ client: Client; provider: TestOAuthProvider }> {
  const provider = new TestOAuthProvider();
  const url = new URL(`${app.baseUrl}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })), UnauthorizedError);
  assert.ok(provider.authorizationUrl, 'client should have been sent to the authorization page');

  const res = await completeConsent(app.baseUrl, provider.authorizationUrl, ACCESS_KEY);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, TEST_REDIRECT);
  assert.equal(location.searchParams.get('state'), provider.authorizationUrl.searchParams.get('state'));
  const code = location.searchParams.get('code');
  assert.ok(code);

  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await transport.finishAuth(code);
  await client.connect(transport);
  return { client, provider };
}

describe('HTTP server, free tier, OAuth', () => {
  let mock: MockGemini;
  let app: RunningApp;
  let client: Client;
  let provider: TestOAuthProvider;

  before(async () => {
    mock = await startMockGemini({ deepResearchPolls: 1 });
    app = await startApp({ GEMINI_API_BASE_URL: mock.url, ENABLE_DEEP_RESEARCH: 'true' });
    ({ client, provider } = await connectWithOAuth(app));
  });

  after(async () => {
    await client?.close();
    await app?.close();
    await mock?.close();
  });

  test('unauthenticated MCP requests get 401 with a resource_metadata pointer', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate') ?? '';
    assert.match(header, /^Bearer /);
    assert.match(header, new RegExp(`resource_metadata="${app.baseUrl}/.well-known/oauth-protected-resource/mcp"`));
  });

  test('discovery metadata matches what Claude expects', async () => {
    const prm: any = await (await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${app.baseUrl}/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${app.baseUrl}/`]);
    const as: any = await (await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, `${app.baseUrl}/`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(as.registration_endpoint, `${app.baseUrl}/register`);
    assert.equal(as.authorization_endpoint, `${app.baseUrl}/authorize`);
  });

  test('lists the tools and prompts', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'gemini_analyze_urls',
        'gemini_ask',
        'gemini_deep_research_result',
        'gemini_deep_research_start',
        'gemini_second_opinion',
        'gemini_verify_claims',
        'gemini_web_search',
      ],
    );
    const verify = tools.find((t) => t.name === 'gemini_verify_claims')!;
    assert.equal(verify.annotations?.readOnlyHint, true);
    assert.deepEqual(verify.inputSchema.required, ['claims']);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['fact_check_with_gemini', 'research_with_gemini', 'second_opinion_from_gemini']);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /independent second reviewer/);
    assert.match(instructions, /free API tier/);
  });

  test('gemini_verify_claims: free tier uses gemini-2.5-flash with search and cites sources', async () => {
    const result = await client.callTool({
      name: 'gemini_verify_claims',
      arguments: {
        claims: ['The Eiffel Tower is 330 m tall.', 'It was completed in 1889.'],
        cited_sources: ['https://www.toureiffel.paris/en', 'https://example.com/paywalled', 'youtu.be/dQw4w9WgXcQ'],
        context: 'User is planning a trip to Paris.',
      },
    });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.match(text, /## Gemini fact-check \(2 claims\)/);
    assert.match(text, /Model: gemini-2\.5-flash/);
    assert.match(text, /café owners agree ☕\. \[1\] It was completed in 1889\. \[1, 2\]/);
    assert.ok(!/Let me (also read|search)/.test(text), 'interim narration must not leak into the answer');
    assert.ok(text.includes(`1. [toureiffel.paris](${SOURCE_A})`));
    assert.ok(text.includes(`2. [wikipedia.org](${SOURCE_B})`));
    assert.match(text, /\[eiffel tower height\]\(https:\/\/www\.google\.com\/search\?q=eiffel%20tower%20height\)/);
    assert.match(text, /🔒 paywalled — not read — https:\/\/example\.com\/paywalled/);
    assert.match(text, /Free API tier: Google Search ran on gemini-2\.5-flash/);
    assert.match(text, /\*\*thread_id:\*\* `int_\d+`/);

    const body = mock.lastCreate();
    assert.equal(body.model, 'gemini-2.5-flash');
    assert.equal(body.generation_config, undefined, 'no thinking_level for 2.5 models');
    assert.deepEqual(body.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
    assert.equal(body.store, true);
    assert.match(body.system_instruction, /Fact-check each numbered claim/);
    assert.match(body.system_instruction, /Cited sources check/);
    assert.ok(Array.isArray(body.input), 'YouTube citation should be attached as video input');
    assert.equal(body.input[0].type, 'text');
    assert.match(body.input[0].text, /1\. The Eiffel Tower is 330 m tall\./);
    assert.match(body.input[0].text, /User is planning a trip to Paris\./);
    assert.deepEqual(body.input[1], { type: 'video', uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  });

  test('gemini_ask continues a thread via previous_interaction_id; expired threads explain themselves', async () => {
    const first = textOf(await client.callTool({ name: 'gemini_web_search', arguments: { query: 'How tall is the Eiffel Tower?' } }));
    const threadId = /\*\*thread_id:\*\* `([^`]+)`/.exec(first)?.[1];
    assert.ok(threadId);

    const followUp = await client.callTool({
      name: 'gemini_ask',
      arguments: { message: 'Source X says 324 m. Reconsider?', thread_id: threadId },
    });
    assert.ok(!followUp.isError);
    const body = mock.lastCreate();
    assert.equal(body.previous_interaction_id, threadId);
    assert.equal(body.model, 'gemini-3.8-flash', 'no search requested, so the newest model is used even on the free tier');
    assert.deepEqual(body.generation_config, { thinking_level: 'medium' });
    assert.equal(body.tools, undefined);

    const expired = await client.callTool({ name: 'gemini_ask', arguments: { message: 'hi', thread_id: 'expired-thread' } });
    assert.equal(expired.isError, true);
    assert.match(textOf(expired), /no longer has thread expired-thread .*1 day on the free tier/);
  });

  test('gemini_analyze_urls reads web pages with url_context and attaches YouTube videos', async () => {
    const result = await client.callTool({
      name: 'gemini_analyze_urls',
      arguments: {
        urls: ['https://example.org/study.pdf', 'https://www.youtube.com/watch?v=abcdefghijk'],
        task: 'Does the study support the claim in the video?',
        depth: 'deep',
      },
    });
    assert.ok(!result.isError, textOf(result));
    const body = mock.lastCreate();
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.deepEqual(body.generation_config, { thinking_level: 'high' });
    assert.deepEqual(body.tools, [{ type: 'url_context' }]);
    assert.deepEqual(body.input[1], { type: 'video', uri: 'https://www.youtube.com/watch?v=abcdefghijk' });
    assert.match(body.system_instruction, /Do not add outside facts/);
  });

  test('gemini_second_opinion wraps the work and enables search by default', async () => {
    const result = await client.callTool({
      name: 'gemini_second_opinion',
      arguments: { task: 'Plan my marathon taper', work: 'Run 30 km two days before the race.', focus: 'injury risk' },
    });
    assert.ok(!result.isError);
    const body = mock.lastCreate();
    assert.match(body.input, /<work>\nRun 30 km two days before the race\.\n<\/work>/);
    assert.match(body.input, /## Review focus\ninjury risk/);
    assert.deepEqual(body.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
  });

  test('input validation errors are reported, not thrown', async () => {
    const bad = await client.callTool({ name: 'gemini_analyze_urls', arguments: { urls: ['nope'], task: 'Summarize' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /No valid http\(s\) URLs/);
  });

  test('deep research: start, poll, then collect the cited report', async () => {
    const started = textOf(await client.callTool({ name: 'gemini_deep_research_start', arguments: { query: 'State of EV battery recycling in 2026' } }));
    const id = /\*\*research_id:\*\* `([^`]+)`/.exec(started)?.[1];
    assert.ok(id, started);
    const startBody = mock.lastCreate();
    assert.equal(startBody.agent, 'deep-research-preview-04-2026');
    assert.equal(startBody.background, true);
    assert.equal(startBody.store, true);

    const running = textOf(await client.callTool({ name: 'gemini_deep_research_result', arguments: { research_id: id, wait_seconds: 0 } }));
    assert.match(running, /still running/);
    assert.match(running, /Reading 14 sources/);

    const done = textOf(await client.callTool({ name: 'gemini_deep_research_result', arguments: { research_id: id, wait_seconds: 0 } }));
    assert.match(done, /Gemini Deep Research report/);
    assert.match(done, /Recycling rates rose sharply\. \[1\]/);
    assert.match(done, /thread_id/);

    const cancelled = textOf(await client.callTool({ name: 'gemini_deep_research_result', arguments: { research_id: id, cancel: true } }));
    assert.match(cancelled, /cancelled/);
  });

  test('refresh tokens rotate; bad refresh tokens get invalid_grant', async () => {
    const tokens = provider.tokenSet!;
    const clientId = (provider.info as { client_id: string }).client_id;
    const refresh = async (refreshToken: string) =>
      fetch(`${app.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      });
    const ok = await refresh(tokens.refresh_token!);
    assert.equal(ok.status, 200);
    const fresh: any = await ok.json();
    assert.ok(fresh.access_token.startsWith('gmat_'));
    assert.ok(fresh.refresh_token.startsWith('gmrt_'));
    assert.notEqual(fresh.refresh_token, tokens.refresh_token);
    assert.equal(fresh.token_type, 'Bearer');
    assert.equal(fresh.expires_in, 3600);

    const bad = await refresh(`${tokens.refresh_token!.slice(0, -3)}abc`);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).error, 'invalid_grant');

    // The new access token works on the MCP endpoint.
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fresh.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      }),
    });
    assert.equal(res.status, 200);
  });

  test('consent: wrong key is rejected, deny returns access_denied, codes are single-use', async () => {
    const reg = await fetch(`${app.baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(reg.status, 201);
    const registered: any = await reg.json();
    assert.ok(registered.client_id.startsWith('gmc_'));
    assert.equal(registered.client_secret, undefined);

    const verifier = 'v'.repeat(64);
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authUrl = new URL(`${app.baseUrl}/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${app.baseUrl}/mcp`,
    }).toString();

    const page = await (await fetch(authUrl)).text();
    assert.match(page, /<strong>Claude<\/strong> wants to use this Gemini server/);
    assert.match(page, /sent back to <strong>claude\.ai<\/strong>/);

    const wrong = await completeConsent(app.baseUrl, authUrl, 'definitely-not-the-key');
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /access key is not correct/);

    const denied = await completeConsent(app.baseUrl, authUrl, '', 'deny');
    assert.equal(denied.status, 302);
    const deniedLocation = new URL(denied.headers.get('location')!);
    assert.equal(deniedLocation.searchParams.get('error'), 'access_denied');
    assert.equal(deniedLocation.searchParams.get('state'), 'xyz');

    const approved = await completeConsent(app.baseUrl, authUrl, ACCESS_KEY);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const exchange = () =>
      fetch(`${app.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: registered.client_id,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          resource: `${app.baseUrl}/mcp`,
        }),
      });
    const first = await exchange();
    assert.equal(first.status, 200, await first.clone().text());
    const second = await exchange();
    assert.equal(second.status, 400);
    assert.equal(((await second.json()) as any).error, 'invalid_grant');
  });

  test('wrong PKCE verifier and foreign redirect URIs are refused', async () => {
    const evil = await fetch(`${app.baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }),
    });
    assert.equal(evil.status, 400);
    assert.equal(((await evil.json()) as any).error, 'invalid_client_metadata');

    // Confidential client using client_secret_basic.
    const reg: any = await (
      await fetch(`${app.baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Confidential', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'client_secret_basic' }),
      })
    ).json();
    assert.ok(reg.client_secret);
    const { createHash } = await import('node:crypto');
    const verifier = 'w'.repeat(64);
    const authUrl = new URL(`${app.baseUrl}/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1:5555/cb', // loopback: any port is accepted (RFC 8252)
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const approved = await completeConsent(app.baseUrl, authUrl, ACCESS_KEY);
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const basic = `Basic ${Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString('base64')}`;
    const tokenRequest = (codeVerifier: string) =>
      fetch(`${app.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier }),
      });
    const wrongVerifier = await tokenRequest('x'.repeat(64));
    assert.equal(wrongVerifier.status, 400);
    assert.equal(((await wrongVerifier.json()) as any).error, 'invalid_grant');
    const ok = await tokenRequest(verifier);
    assert.equal(ok.status, 200, await ok.clone().text());
  });

  test('static access key works as a bearer token; GET /mcp is 405', async () => {
    const keyClient = new Client({ name: 'key-client', version: '1.0.0' });
    await keyClient.connect(
      new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${ACCESS_KEY}` } },
      }),
    );
    const { tools } = await keyClient.listTools();
    assert.ok(tools.length >= 5);
    await keyClient.close();

    const get = await fetch(`${app.baseUrl}/mcp`, { headers: { Authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(get.status, 405);
    const home = await (await fetch(`${app.baseUrl}/`)).text();
    assert.match(home, new RegExp(`${app.baseUrl}/mcp`));
  });
});

describe('HTTP server, paid tier', () => {
  let mock: MockGemini;
  let app: RunningApp;
  let client: Client;

  before(async () => {
    mock = await startMockGemini({ transientFailures: 1 });
    app = await startApp({ GEMINI_API_BASE_URL: mock.url, GEMINI_TIER: 'paid', AUTH_MODE: 'bearer' });
    client = new Client({ name: 'paid-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${ACCESS_KEY}` } },
      }),
    );
  });

  after(async () => {
    await client?.close();
    await app?.close();
    await mock?.close();
  });

  test('bearer mode has no OAuth endpoints', async () => {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 404);
  });

  test('uses gemini-3.8-flash with search, retrying a transient 503', async () => {
    const result = await client.callTool({ name: 'gemini_web_search', arguments: { query: 'Who won Euro 2024?', depth: 'quick' } });
    assert.ok(!result.isError, textOf(result));
    assert.ok(!textOf(result).includes('Let me search'), 'narration before a search call is excluded');
    const creates = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1beta/interactions');
    assert.equal(creates.length, 2, 'one 503, then success');
    const body = mock.lastCreate();
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.deepEqual(body.generation_config, { thinking_level: 'low' });
    assert.ok(!textOf(result).includes('Free API tier'));
  });

  test('deep depth uses the Pro model', async () => {
    await client.callTool({ name: 'gemini_verify_claims', arguments: { claims: ['Water boils at 100 °C at sea level.'], depth: 'deep' } });
    const body = mock.lastCreate();
    assert.equal(body.model, 'gemini-3.1-pro-preview');
    assert.deepEqual(body.generation_config, { thinking_level: 'high' });
  });

  test('an unavailable deep model falls back to the standard model, keeping search on 3.x', async () => {
    mock.options.unavailableModels = ['gemini-3.1-pro-preview'];
    const result = await client.callTool({
      name: 'gemini_verify_claims',
      arguments: { claims: ['Mount Everest is 8,849 m tall.'], depth: 'deep' },
    });
    mock.options.unavailableModels = undefined;
    assert.ok(!result.isError, textOf(result));
    assert.match(textOf(result), /gemini-3\.1-pro-preview isn't available with this API key, so this ran on gemini-3\.8-flash/);
    const creates = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1beta/interactions');
    assert.deepEqual(
      creates.slice(-2).map((r) => r.body.model),
      ['gemini-3.1-pro-preview', 'gemini-3.8-flash'],
    );
    assert.deepEqual(creates.at(-1)!.body.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
    assert.ok(!textOf(result).includes('free tier'), 'a missing Pro model must not be mistaken for a free-tier key');
  });

  test('falls back to gemini-2.5-flash when the key turns out to be free tier', async () => {
    mock.options.freeTier = true;
    const result = await client.callTool({ name: 'gemini_verify_claims', arguments: { claims: ['The Eiffel Tower is 330 m tall.'] } });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.match(text, /Model: gemini-2\.5-flash/);
    assert.match(text, /couldn't use Google Search with this API key/);
    const creates = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1beta/interactions');
    assert.deepEqual(
      creates.slice(-2).map((r) => r.body.model),
      ['gemini-3.8-flash', 'gemini-2.5-flash'],
    );

    // Remembered for later calls: no wasted request on the 3.x model.
    const before = creates.length;
    await client.callTool({ name: 'gemini_web_search', arguments: { query: 'Eiffel Tower height?' } });
    const after = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1beta/interactions');
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1)!.body.model, 'gemini-2.5-flash');
  });

  test('an invalid Gemini API key produces a clear error', async () => {
    const badApp = await startApp({ GEMINI_API_BASE_URL: mock.url, GEMINI_API_KEY: 'wrong', AUTH_MODE: 'bearer' });
    const badClient = new Client({ name: 'bad', version: '1.0.0' });
    await badClient.connect(
      new StreamableHTTPClientTransport(new URL(`${badApp.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${ACCESS_KEY}` } },
      }),
    );
    const result = await badClient.callTool({ name: 'gemini_ask', arguments: { message: 'hi' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /API key configured on this server was rejected/);
    await badClient.close();
    await badApp.close();
  });
});
