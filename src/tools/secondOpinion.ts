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

export function registerSecondOpinion(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'gemini_second_opinion',
    {
      title: "Get Gemini's review of a draft",
      description:
        'Ask Gemini to critically review work you produced (a draft answer, analysis, plan, calculation, recommendation, ' +
        'or code) before you give it to the user. Put the user\'s original request in `task` and your draft in `work`. ' +
        'Gemini checks facts (with Google Search unless use_web_search=false), logic, math, completeness and risks, and ' +
        'returns a verdict plus prioritized issues with concrete fixes. Use it for high-stakes or complex answers, or ' +
        'whenever the user asks for things to be double-checked.',
      inputSchema: {
        task: z
          .string()
          .trim()
          .min(3)
          .max(20_000)
          .describe("The user's original request or question that the work is meant to answer."),
        work: z.string().trim().min(10).max(300_000).describe('The draft answer, analysis, plan, or code to review.'),
        focus: z
          .string()
          .max(2_000)
          .optional()
          .describe('Optional emphasis, e.g. "numbers and units", "medical accuracy", "security of this code".'),
        use_web_search: z.boolean().default(true).describe('Let Gemini fact-check with Google Search (default true).'),
        context: contextField,
        depth: depthField,
        thread_id: threadIdField,
      },
      annotations: { title: "Get Gemini's review of a draft", ...READ_ONLY_WEB_TOOL },
    },
    async ({ task, work, focus, use_web_search, context, depth, thread_id }, extra) => {
      const input = joinSections(
        section("Context from Claude (the user's situation and what Claude already knows)", context),
        section("The user's request", task),
        section('Review focus', focus),
        `## Claude's work to review\n<work>\n${work}\n</work>`,
      );
      return runGeminiTool(deps, extra, {
        toolName: 'gemini_second_opinion',
        heading: 'Gemini review',
        spec: {
          systemInstruction: systemInstruction('review', {
            userContext: deps.cfg.gemini.userContext,
            search: use_web_search,
            urls: false,
          }),
          input,
          depth,
          search: use_web_search,
          urlContext: use_web_search,
          threadId: thread_id,
        },
      });
    },
  );
}
