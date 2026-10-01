import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GeminiApiError } from '../gemini/client.js';
import { parseInteraction, renderParsed } from '../gemini/result.js';
import type { Interaction } from '../gemini/types.js';
import { deepResearchPrompt } from '../prompts.js';
import { errorMessage, log } from '../util/log.js';
import { sleep } from '../util/sleep.js';
import {
  READ_ONLY_WEB_TOOL,
  contextField,
  describeError,
  errorResult,
  startProgress,
  type ToolDeps,
  type ToolExtra,
} from './common.js';

const RUNNING = new Set(['in_progress', 'queued']);
const POLL_INTERVAL_MS = 10_000;

export function registerDeepResearch(server: McpServer, deps: ToolDeps): void {
  const { agent, maxAgent } = deps.cfg.gemini.deepResearch;

  server.registerTool(
    'gemini_deep_research_start',
    {
      title: 'Start a Gemini Deep Research report',
      description:
        "Start Gemini Deep Research: Google's autonomous research agent runs many Google searches, reads dozens of " +
        'sources over roughly 5-20 minutes, and writes a long, cited report. It COSTS MONEY on the Gemini API key ' +
        '(about US$1-3 per run, US$3-7 with max=true), so only use it when the user explicitly asks for deep research ' +
        'or a thorough independent report. Returns a research_id; collect the report with gemini_deep_research_result.',
      inputSchema: {
        query: z.string().trim().min(10).max(20_000).describe('The research question or brief, as specific as possible.'),
        context: contextField,
        max: z
          .boolean()
          .default(false)
          .describe('Use Deep Research Max (more exhaustive, slower, roughly 2-3x the cost). Default false.'),
      },
      annotations: { title: 'Start a Gemini Deep Research report', ...READ_ONLY_WEB_TOOL },
    },
    async ({ query, context, max }, extra): Promise<CallToolResult> => {
      const quota = deps.limiter.tryConsume();
      if (!quota.ok) return errorResult(`Daily safety limit of ${quota.limit} Gemini calls reached (DAILY_CALL_LIMIT).`);
      const agentId = max ? maxAgent : agent;
      try {
        const interaction = await deps.runner.client.createInteraction(
          {
            agent: agentId,
            input: deepResearchPrompt(query, context),
            background: true,
            store: true, // required for background execution
            agent_config: { type: 'deep-research', thinking_summaries: 'auto' },
          },
          { signal: extra.signal, deadline: Date.now() + 60_000 },
        );
        log.info('deep research started', { id: interaction.id, agent: agentId, status: interaction.status });
        return {
          content: [
            {
              type: 'text',
              text:
                `Gemini Deep Research started (${agentId}).\n\n` +
                `**research_id:** \`${interaction.id}\`\nStatus: ${interaction.status}\n\n` +
                'It usually takes 5-20 minutes (hard limit 60). Call `gemini_deep_research_result` with this research_id ' +
                'to collect the report; each call waits up to ~2 minutes. You can keep helping the user in the meantime.',
            },
          ],
        };
      } catch (err) {
        log.warn('deep research start failed', { error: errorMessage(err) });
        const hint =
          err instanceof GeminiApiError && (err.looksLikeTierRestriction || err.httpStatus === 403)
            ? '\nDeep Research needs a Gemini API key on the paid tier (billing enabled).'
            : '';
        return errorResult(describeError(err, deps) + hint);
      }
    },
  );

  server.registerTool(
    'gemini_deep_research_result',
    {
      title: 'Get a Gemini Deep Research report',
      description:
        'Check on, collect, or cancel a Gemini Deep Research run started with gemini_deep_research_start. Waits up to ' +
        'wait_seconds for it to finish; if it is still running, call again later. The finished report includes ' +
        'citations, and its research_id also works as a thread_id for follow-up questions with gemini_ask.',
      inputSchema: {
        research_id: z.string().trim().min(1).max(512).describe('The research_id returned by gemini_deep_research_start.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(120)
          .describe('How long to wait for completion before returning the current status (0-200, default 120).'),
        cancel: z.boolean().default(false).describe('Cancel the run instead of waiting (stops further cost).'),
      },
      annotations: { title: 'Get a Gemini Deep Research report', ...READ_ONLY_WEB_TOOL, idempotentHint: true },
    },
    async ({ research_id, wait_seconds, cancel }, extra): Promise<CallToolResult> => {
      try {
        if (cancel) {
          const cancelled = await deps.runner.client.cancelInteraction(research_id, {
            signal: extra.signal,
            deadline: Date.now() + 30_000,
          });
          return { content: [{ type: 'text', text: `Deep Research ${research_id}: status ${cancelled.status}.` }] };
        }
        const interaction = await waitForCompletion(deps, extra, research_id, wait_seconds * 1000);
        return { content: [{ type: 'text', text: renderDeepResearch(deps, interaction) }] };
      } catch (err) {
        if (err instanceof GeminiApiError && err.httpStatus === 404) {
          return errorResult(
            `No Deep Research run found for ${research_id}. It may have expired (stored ${deps.runner.threadRetention}).`,
          );
        }
        return errorResult(describeError(err, deps));
      }
    },
  );
}

async function waitForCompletion(deps: ToolDeps, extra: ToolExtra, id: string, waitMs: number): Promise<Interaction> {
  const deadline = Date.now() + waitMs;
  const stopProgress = startProgress(extra, 'Waiting for Gemini Deep Research');
  try {
    for (;;) {
      const interaction = await deps.runner.client.getInteraction(id, {
        signal: extra.signal,
        deadline: Date.now() + 30_000,
      });
      if (!RUNNING.has(interaction.status) || Date.now() + POLL_INTERVAL_MS > deadline) return interaction;
      await sleep(POLL_INTERVAL_MS, extra.signal);
    }
  } finally {
    stopProgress();
  }
}

function renderDeepResearch(deps: ToolDeps, interaction: Interaction): string {
  const parsed = parseInteraction(interaction);
  if (RUNNING.has(interaction.status)) {
    const elapsed = interaction.created ? Math.round((Date.now() - Date.parse(interaction.created)) / 60_000) : undefined;
    const activity = parsed.thoughtSummary ? `\n\nLatest activity: ${parsed.thoughtSummary.slice(0, 600)}` : '';
    return (
      `Deep Research ${interaction.id} is still running (status: ${interaction.status}` +
      `${elapsed !== undefined && Number.isFinite(elapsed) ? `, ~${elapsed} min since start` : ''}).${activity}\n\n` +
      'Call gemini_deep_research_result again to keep waiting.'
    );
  }
  return renderParsed(parsed, {
    heading: 'Gemini Deep Research report',
    model: interaction.agent ?? 'deep-research',
    toolsLabel: 'Tools: Google Search + URL reading + code execution',
    notes: [],
    threadId: interaction.id,
    threadHint: `pass this as \`thread_id\` to gemini_ask for follow-up questions about the report (kept ${deps.runner.threadRetention}).`,
    maxChars: deps.cfg.maxOutputChars,
  });
}
