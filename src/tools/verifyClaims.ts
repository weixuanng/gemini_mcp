import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { systemInstruction } from '../prompts.js';
import {
  MAX_VIDEOS,
  READ_ONLY_WEB_TOOL,
  buildInput,
  contextField,
  depthField,
  errorResult,
  joinSections,
  numbered,
  runGeminiTool,
  section,
  splitUrls,
  threadIdField,
  type ToolDeps,
} from './common.js';

export function registerVerifyClaims(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'gemini_verify_claims',
    {
      title: 'Fact-check claims with Gemini',
      description:
        "Independently fact-check specific factual claims with Google's Gemini, which searches the web with Google Search " +
        'and reads sources. Use it before presenting important facts (statistics, dates, prices, quotes, health, legal or ' +
        "financial statements, recent events, anything you're unsure of), and to check that sources you cited really say " +
        'what you claim. Gemini cannot see this conversation: make each claim self-contained (who/what/when/where) and put ' +
        'the user\'s goal plus what you already found in `context`. Returns a verdict per claim (supported, partly supported, ' +
        'contradicted, disputed, unverified) with evidence, corrections and source links. It is a second opinion: weigh its ' +
        'evidence rather than deferring automatically, and tell the user where you and Gemini disagree.',
      inputSchema: {
        claims: z
          .array(z.string().trim().min(3).max(4_000))
          .min(1)
          .max(30)
          .describe('The factual claims to check, one per item, each understandable on its own.'),
        cited_sources: z
          .array(z.string().max(2_048))
          .max(20)
          .optional()
          .describe('URLs you relied on for these claims. Gemini opens them and checks whether they actually support the claims.'),
        context: contextField,
        depth: depthField,
        thread_id: threadIdField,
      },
      annotations: { title: 'Fact-check claims with Gemini', ...READ_ONLY_WEB_TOOL },
    },
    async ({ claims, cited_sources, context, depth, thread_id }, extra) => {
      const urls = splitUrls(cited_sources ?? []);
      const sources = [...urls.web, ...urls.youtube];
      if (urls.invalid.length > 0 && sources.length === 0) {
        return errorResult(`None of the cited_sources are valid http(s) URLs: ${urls.invalid.join(', ')}`);
      }
      if (urls.youtube.length > MAX_VIDEOS) {
        return errorResult(`At most ${MAX_VIDEOS} YouTube videos per call (got ${urls.youtube.length}).`);
      }

      const text = joinSections(
        section("Context from Claude (the user's situation and what Claude already knows)", context),
        section('Claims to verify', numbered(claims)),
        section(
          'Sources Claude cited for these claims',
          [
            ...urls.web.map((u) => `- ${u}`),
            ...urls.youtube.map((u) => `- ${u} (YouTube video, attached to this request)`),
          ].join('\n'),
        ),
      );

      return runGeminiTool(deps, extra, {
        toolName: 'gemini_verify_claims',
        heading: `Gemini fact-check (${claims.length} claim${claims.length === 1 ? '' : 's'})`,
        spec: {
          systemInstruction: systemInstruction('verify', {
            userContext: deps.cfg.gemini.userContext,
            search: true,
            urls: sources.length > 0,
          }),
          input: buildInput(text, urls.youtube),
          depth,
          search: true,
          urlContext: true,
          threadId: thread_id,
        },
        extraNotes: urls.invalid.length > 0 ? [`Ignored invalid URLs: ${urls.invalid.join(', ')}`] : undefined,
      });
    },
  );
}
