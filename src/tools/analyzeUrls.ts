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

export function registerAnalyzeUrls(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'gemini_analyze_urls',
    {
      title: 'Have Gemini read URLs, PDFs or YouTube videos',
      description:
        'Give Gemini specific URLs (web pages, PDFs, images, or public YouTube videos) plus a task, for example ' +
        '"Does this study actually support claim X?", "What does this video say about Y? Give timestamps.", or ' +
        '"Compare these two articles." Gemini reads the real content (it can watch YouTube videos, which you cannot), ' +
        'quotes it, reports URLs it could not access (paywalls, errors), and assesses each source\'s credibility. ' +
        'Set allow_web_search=true to also let it check the sources against the wider web.',
      inputSchema: {
        urls: z
          .array(z.string().max(2_048))
          .min(1)
          .max(20)
          .describe(`Up to 20 http(s) URLs (at most ${MAX_VIDEOS} YouTube videos).`),
        task: z
          .string()
          .trim()
          .min(3)
          .max(20_000)
          .describe('What Gemini should do with the sources: a question to answer, claims to check, or what to extract/compare.'),
        allow_web_search: z
          .boolean()
          .default(false)
          .describe('Also allow Google Search (default false: stick to the given sources).'),
        context: contextField,
        depth: depthField,
        thread_id: threadIdField,
      },
      annotations: { title: 'Have Gemini read URLs, PDFs or YouTube videos', ...READ_ONLY_WEB_TOOL },
    },
    async ({ urls, task, allow_web_search, context, depth, thread_id }, extra) => {
      const split = splitUrls(urls);
      if (split.web.length + split.youtube.length === 0) {
        return errorResult(`No valid http(s) URLs were given: ${split.invalid.join(', ')}`);
      }
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
        section('Task', task),
      );

      return runGeminiTool(deps, extra, {
        toolName: 'gemini_analyze_urls',
        heading: `Gemini source analysis (${split.web.length + split.youtube.length} source${split.web.length + split.youtube.length === 1 ? '' : 's'})`,
        spec: {
          systemInstruction: systemInstruction('urls', {
            userContext: deps.cfg.gemini.userContext,
            search: allow_web_search,
            urls: true,
          }),
          input: buildInput(text, split.youtube),
          depth,
          search: allow_web_search,
          urlContext: split.web.length > 0,
          threadId: thread_id,
        },
        extraNotes: split.invalid.length > 0 ? [`Ignored invalid URLs: ${split.invalid.join(', ')}`] : undefined,
      });
    },
  );
}
