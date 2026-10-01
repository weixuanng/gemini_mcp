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
  runGeminiTool,
  section,
  splitUrls,
  threadIdField,
  type ToolDeps,
} from './common.js';

export function registerAsk(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'gemini_ask',
    {
      title: 'Ask Gemini (with thread memory)',
      description:
        'Talk to Gemini directly: ask a question, brainstorm, debate, or follow up on an earlier Gemini result by passing ' +
        'its thread_id, so Gemini remembers that whole exchange (e.g. "Source X contradicts your verdict on claim 2 — ' +
        'reconsider."). Optionally give urls for it to read (including YouTube) and set use_web_search=true when the ' +
        'answer depends on current facts.',
      inputSchema: {
        message: z.string().trim().min(1).max(100_000).describe('Your message to Gemini.'),
        use_web_search: z.boolean().default(false).describe('Allow Google Search (default false).'),
        urls: z
          .array(z.string().max(2_048))
          .max(20)
          .optional()
          .describe(`Optional URLs for Gemini to read (at most ${MAX_VIDEOS} YouTube videos).`),
        context: contextField,
        depth: depthField,
        thread_id: threadIdField,
      },
      annotations: { title: 'Ask Gemini (with thread memory)', ...READ_ONLY_WEB_TOOL },
    },
    async ({ message, use_web_search, urls, context, depth, thread_id }, extra) => {
      const split = splitUrls(urls ?? []);
      if (split.youtube.length > MAX_VIDEOS) {
        return errorResult(`At most ${MAX_VIDEOS} YouTube videos per call (got ${split.youtube.length}).`);
      }
      const sourceList = [
        ...split.web.map((u) => `- ${u}`),
        ...split.youtube.map((u) => `- ${u} (YouTube video, attached to this request)`),
      ].join('\n');

      const text = joinSections(
        section("Context from Claude (the user's situation and what Claude already knows)", context),
        section('Sources to read', sourceList),
        section("Claude's message", message),
      );

      return runGeminiTool(deps, extra, {
        toolName: 'gemini_ask',
        heading: 'Gemini',
        spec: {
          systemInstruction: systemInstruction('ask', {
            userContext: deps.cfg.gemini.userContext,
            search: use_web_search,
            urls: split.web.length + split.youtube.length > 0,
          }),
          input: buildInput(text, split.youtube),
          depth,
          search: use_web_search,
          urlContext: split.web.length > 0 || use_web_search,
          threadId: thread_id,
        },
        extraNotes: split.invalid.length > 0 ? [`Ignored invalid URLs: ${split.invalid.join(', ')}`] : undefined,
      });
    },
  );
}
