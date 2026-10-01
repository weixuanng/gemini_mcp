import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { systemInstruction } from '../prompts.js';
import {
  READ_ONLY_WEB_TOOL,
  contextField,
  depthField,
  joinSections,
  runGeminiTool,
  section,
  threadIdField,
  type ToolDeps,
} from './common.js';

export function registerWebSearch(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'gemini_web_search',
    {
      title: 'Research with Gemini + Google Search',
      description:
        'Ask Gemini to research a question independently with Google Search and return a sourced answer: inline ' +
        'citations, source links, and the exact searches it ran. Use it to cross-check your own web search results ' +
        "against Google's index, to find sources you may have missed, or for fast-moving topics. Write `query` as a " +
        'complete question; put background (location, timeframe, what you already found) in `context`.',
      inputSchema: {
        query: z.string().trim().min(3).max(8_000).describe('The research question, phrased as a complete question.'),
        context: contextField,
        depth: depthField,
        thread_id: threadIdField,
      },
      annotations: { title: 'Research with Gemini + Google Search', ...READ_ONLY_WEB_TOOL },
    },
    async ({ query, context, depth, thread_id }, extra) => {
      const input = joinSections(
        section("Context from Claude (the user's situation and what Claude already knows)", context),
        section('Question', query),
      );
      return runGeminiTool(deps, extra, {
        toolName: 'gemini_web_search',
        heading: 'Gemini research',
        spec: {
          systemInstruction: systemInstruction('search', {
            userContext: deps.cfg.gemini.userContext,
            search: true,
            urls: false,
          }),
          input,
          depth,
          search: true,
          urlContext: true,
          threadId: thread_id,
        },
      });
    },
  );
}
