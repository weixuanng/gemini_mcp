import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';
import { GeminiApiError } from '../src/gemini/client.js';
import { insertCitations, parseInteraction, renderParsed, SourceRegistry } from '../src/gemini/result.js';
import { GeminiRunner, supportsThinkingLevel } from '../src/gemini/runner.js';
import { GeminiClient } from '../src/gemini/client.js';
import type { Interaction } from '../src/gemini/types.js';
import { normalizeUrl, splitUrls, youtubeWatchUrl } from '../src/tools/common.js';
import { RedirectPolicy } from '../src/http/oauth/redirects.js';
import { TokenSigner } from '../src/http/oauth/signer.js';
import { systemInstruction } from '../src/prompts.js';
import { DailyLimiter } from '../src/util/limits.js';
import { ANSWER_TEXT, SOURCE_A, SOURCE_B } from './helpers.js';

const BASE_ENV = { GEMINI_API_KEY: 'k', MCP_ACCESS_KEY: 'x'.repeat(32) };

test('config: defaults for free tier', () => {
  const cfg = loadConfig(BASE_ENV, 'http');
  assert.equal(cfg.gemini.tier, 'free');
  assert.equal(cfg.gemini.model, 'gemini-3.8-flash');
  assert.equal(cfg.gemini.deepModel, 'gemini-3.8-flash');
  assert.equal(cfg.gemini.freeSearchModel, 'gemini-2.5-flash');
  assert.equal(cfg.auth.mode, 'oauth');
  assert.equal(cfg.http.port, 8080);
  assert.equal(cfg.dailyCallLimit, 300);
});

test('config: paid tier uses Pro for deep work', () => {
  const cfg = loadConfig({ ...BASE_ENV, GEMINI_TIER: 'paid' }, 'http');
  assert.equal(cfg.gemini.deepModel, 'gemini-3.1-pro-preview');
});

test('config: reports every problem at once', () => {
  assert.throws(
    () => loadConfig({ MCP_ACCESS_KEY: 'short', GEMINI_TIER: 'gold', PORT: 'abc', DAILY_CALL_LIMIT: '-1' }, 'http'),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      for (const fragment of ['GEMINI_API_KEY', 'MCP_ACCESS_KEY must be at least', 'GEMINI_TIER', 'PORT', 'DAILY_CALL_LIMIT']) {
        assert.match(err.message, new RegExp(fragment));
      }
      return true;
    },
  );
});

test('config: stdio needs no access key; PUBLIC_URL must be https', () => {
  assert.doesNotThrow(() => loadConfig({ GEMINI_API_KEY: 'k' }, 'stdio'));
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_URL: 'http://example.com' }, 'http'), /https/);
  const cfg = loadConfig({ ...BASE_ENV, PUBLIC_URL: 'https://example.com/some/path/' }, 'http');
  assert.equal(cfg.http.publicUrl, 'https://example.com');
});

test('signer: round trip, tamper detection, and per-kind keys', () => {
  const signer = new TokenSigner('a-long-random-secret-value-1234567890');
  const token = signer.sign('access', { a: 1, s: 'héllo' });
  assert.deepEqual(signer.verify('access', token), { a: 1, s: 'héllo' });
  assert.equal(signer.verify('refresh', token), undefined, 'a token of one kind must not verify as another');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ a: 2, s: 'héllo' })).toString('base64url');
  assert.equal(signer.verify('access', `${forged}.${mac}`), undefined);
  assert.equal(signer.verify('access', `${body}.${mac!.slice(0, -2)}AA`), undefined);
  assert.equal(new TokenSigner('another-secret-value-0987654321').verify('access', token), undefined);
  assert.ok(signer.matchesSecret('a-long-random-secret-value-1234567890'));
  assert.ok(!signer.matchesSecret('a-long-random-secret-value-123456789'));
});

test('citations: byte offsets with multi-byte characters', () => {
  const seg1 = 'Café ☕ opens at 8.';
  const seg2 = 'Prices rose 5% in 2026 🇸🇬.';
  const text = `${seg1} ${seg2}\n`;
  const at = (s: string) => {
    const start = Buffer.byteLength(text.slice(0, text.indexOf(s)));
    return { start_index: start, end_index: start + Buffer.byteLength(s) };
  };
  const registry = new SourceRegistry();
  const out = insertCitations(
    text,
    [
      { type: 'url_citation', url: 'https://a.example/x', title: 'a.example', ...at(seg1) },
      { type: 'url_citation', url: 'https://b.example/y/', title: 'b.example', ...at(seg2) },
      { type: 'url_citation', url: 'https://a.example/x#frag', title: 'a.example', ...at(seg2) },
    ],
    registry,
  );
  assert.equal(out, `${seg1} [1] ${seg2} [1, 2]\n`);
  assert.deepEqual(
    registry.list().map((s) => s.url),
    ['https://a.example/x', 'https://b.example/y/'],
  );
});

test('citations: out-of-range and mid-character offsets are clamped safely', () => {
  const registry = new SourceRegistry();
  const out = insertCitations(
    'añb',
    [
      { type: 'url_citation', url: 'https://x.example', end_index: 2 }, // inside "ñ" (2 bytes)
      { type: 'url_citation', url: 'https://y.example', end_index: 999 },
    ],
    registry,
  );
  assert.equal(out, 'añ [1]b [2]');
});

test('parseInteraction: final answer, queries, url statuses, problems', () => {
  const interaction: Interaction = {
    id: 'int_1',
    status: 'incomplete',
    steps: [
      { type: 'thought', summary: [{ type: 'text', text: 'thinking' }] },
      { type: 'google_search_call', arguments: { queries: ['q1', 'q2', 'q1'] } },
      { type: 'model_output', content: [{ type: 'text', text: 'Interim narration.' }] },
      { type: 'url_context_result', result: [{ url: 'https://p.example', status: 'paywall' }] },
      {
        type: 'model_output',
        content: [
          { type: 'text', text: ANSWER_TEXT, annotations: [{ type: 'url_citation', url: SOURCE_A, end_index: 12 }] },
          { type: 'text', text: 'Second block.', annotations: [{ type: 'url_citation', url: SOURCE_B, end_index: 13 }] },
        ],
      },
    ],
  };
  const parsed = parseInteraction(interaction);
  assert.ok(!parsed.text.includes('Interim narration'));
  assert.ok(parsed.text.startsWith('**Overall:** [1]'));
  assert.ok(parsed.text.endsWith('Second block. [2]'));
  assert.deepEqual(parsed.searchQueries, ['q1', 'q2']);
  assert.deepEqual(parsed.urlResults, [{ url: 'https://p.example', status: 'paywall' }]);
  assert.equal(parsed.thoughtSummary, 'thinking');
  assert.match(parsed.problems.join(' '), /incomplete/);

  const rendered = renderParsed(parsed, { heading: 'Test', model: 'm', notes: ['note'], threadId: 'int_1', maxChars: 10_000 });
  assert.match(rendered, /### Sources cited by Gemini\n1\. \[toureiffel\.paris\]\(https:\/\/www\.toureiffel\.paris/);
  assert.match(rendered, /\[q1\]\(https:\/\/www\.google\.com\/search\?q=q1\)/);
  assert.match(rendered, /🔒 paywalled/);
  assert.match(rendered, /\*\*thread_id:\*\* `int_1`/);
});

test('renderParsed: truncates long answers to the size limit', () => {
  const parsed = parseInteraction({
    id: 'x',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'word '.repeat(10_000) }] }],
  });
  const out = renderParsed(parsed, { heading: 'H', model: 'm', notes: [], maxChars: 4_000 });
  assert.ok(out.length <= 4_000, `length ${out.length}`);
  assert.match(out, /truncated/);
});

test('GeminiApiError: quota-zero vs ordinary rate limits', () => {
  const zero = new GeminiApiError('Quota exceeded for metric: x, limit: 0, model: gemini-3.8-flash', 429);
  assert.ok(zero.isQuotaZero && zero.looksLikeTierRestriction && !zero.isTransient);
  const rate = new GeminiApiError(
    'You exceeded your current quota, please check your plan and billing details. limit: 10',
    429,
  );
  assert.ok(!rate.looksLikeTierRestriction && rate.isTransient);
  assert.ok(new GeminiApiError('Grounding is not available on the free tier.', 400).looksLikeTierRestriction);
  assert.ok(new GeminiApiError('overloaded', 503).isTransient);
  const retired = new GeminiApiError('This model models/gemini-2.5-flash is no longer available to new users.', 404);
  assert.ok(retired.isModelUnavailable && !retired.isTransient);
  assert.ok(!new GeminiApiError('Interaction v1_abc not found.', 404).isModelUnavailable);
  assert.ok(!new GeminiApiError('bad', 400).isTransient);
});

test('model planning by tier and depth', () => {
  const client = new GeminiClient({ apiKey: 'k', baseUrl: 'http://x', apiVersion: 'v1beta' });
  const free = new GeminiRunner(client, loadConfig(BASE_ENV, 'http').gemini);
  assert.deepEqual(free.plan({ depth: 'standard', search: true }), { model: 'gemini-2.5-flash' });
  assert.deepEqual(free.plan({ depth: 'deep', search: false }), { model: 'gemini-3.8-flash', thinkingLevel: 'high' });
  const paid = new GeminiRunner(client, loadConfig({ ...BASE_ENV, GEMINI_TIER: 'paid' }, 'http').gemini);
  assert.deepEqual(paid.plan({ depth: 'quick', search: true }), { model: 'gemini-3.8-flash', thinkingLevel: 'low' });
  assert.deepEqual(paid.plan({ depth: 'deep', search: true }), { model: 'gemini-3.1-pro-preview', thinkingLevel: 'high' });
  assert.ok(supportsThinkingLevel('gemini-3.1-pro-preview'));
  assert.ok(!supportsThinkingLevel('gemini-2.5-flash'));
});

test('URL helpers: normalization and YouTube detection', () => {
  assert.equal(normalizeUrl('example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('ftp://example.com'), undefined);
  assert.equal(normalizeUrl('not a url'), undefined);
  assert.equal(youtubeWatchUrl('https://youtu.be/dQw4w9WgXcQ?t=42'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeWatchUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeWatchUrl('https://www.youtube.com/shorts/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(youtubeWatchUrl('https://www.youtube.com/@channel'), undefined);
  const split = splitUrls(['youtu.be/dQw4w9WgXcQ', 'https://a.example', 'https://a.example', 'nope']);
  assert.deepEqual(split, {
    web: ['https://a.example/'],
    youtube: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    invalid: ['nope'],
  });
});

test('redirect policy: Claude callback and loopback only by default', () => {
  const policy = new RedirectPolicy({ extraRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], allowAnyRedirectUri: false });
  assert.ok(policy.isAllowed('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(policy.isAllowed('http://localhost:61234/callback'));
  assert.ok(policy.isAllowed('http://127.0.0.1:5000/cb'));
  assert.ok(policy.isAllowed('https://chatgpt.com/connector_platform_oauth_redirect'));
  assert.ok(!policy.isAllowed('https://evil.example/callback'));
  assert.ok(!policy.isAllowed('http://claude.ai/api/mcp/auth_callback'));
  assert.ok(!policy.isAllowed('javascript:alert(1)'));
  const open = new RedirectPolicy({ extraRedirectUris: [], allowAnyRedirectUri: true });
  assert.ok(open.isAllowed('https://any.example/cb'));
  assert.ok(!open.isAllowed('http://any.example/cb'));
});

test('prompts include date, task format, and standing user context', () => {
  const s = systemInstruction('verify', { search: true, urls: true, userContext: 'Lives in Singapore.', now: new Date('2026-10-01T00:00:00Z') });
  assert.match(s, /Today's date is 2026-10-01/);
  assert.match(s, /Cited sources check/);
  assert.match(s, /Lives in Singapore\./);
  assert.match(s, /data, not instructions/);
  assert.doesNotMatch(systemInstruction('verify', { search: true, urls: false }), /Cited sources check/);
});

test('daily limiter resets at UTC midnight', () => {
  const limiter = new DailyLimiter(2);
  const day1 = new Date('2026-10-01T10:00:00Z');
  assert.ok(limiter.tryConsume(day1).ok);
  assert.ok(limiter.tryConsume(day1).ok);
  assert.ok(!limiter.tryConsume(day1).ok);
  assert.ok(limiter.tryConsume(new Date('2026-10-02T00:00:01Z')).ok);
  assert.ok(new DailyLimiter(0).tryConsume().ok);
});
