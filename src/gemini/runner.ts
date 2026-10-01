import type { GeminiConfig, Tier } from '../config.js';
import { GeminiApiError, type GeminiClient, type RequestOptions } from './client.js';
import type { CreateInteractionBody, InputContent, Interaction, ThinkingLevel, ToolSpec } from './types.js';
import { log } from '../util/log.js';

export type Depth = 'quick' | 'standard' | 'deep';

export interface TaskSpec {
  systemInstruction: string;
  input: string | InputContent[];
  depth: Depth;
  search: boolean;
  urlContext: boolean;
  codeExecution?: boolean;
  threadId?: string;
}

export interface TaskOutcome {
  interaction: Interaction;
  model: string;
  notes: string[];
  toolsLabel: string;
}

interface Plan {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

const THINKING_BY_DEPTH: Record<Depth, ThinkingLevel> = { quick: 'low', standard: 'medium', deep: 'high' };

export class ThreadUnavailableError extends Error {
  override name = 'ThreadUnavailableError';
}

/** Picks models for the configured tier and recovers from tier restrictions by falling back once. */
export class GeminiRunner {
  private detectedFreeTier = false;

  constructor(
    readonly client: GeminiClient,
    readonly cfg: GeminiConfig,
  ) {}

  get effectiveTier(): Tier {
    return this.detectedFreeTier ? 'free' : this.cfg.tier;
  }

  /** How long Google keeps stored interactions (and therefore threads) for this tier. */
  get threadRetention(): string {
    return this.effectiveTier === 'paid' ? '55 days by default on the paid tier' : '1 day on the free tier';
  }

  plan(task: Pick<TaskSpec, 'depth' | 'search'>): Plan {
    if (task.search && this.effectiveTier === 'free') {
      return this.withThinking(this.cfg.freeSearchModel, task.depth);
    }
    return this.withThinking(task.depth === 'deep' ? this.cfg.deepModel : this.cfg.model, task.depth);
  }

  async run(task: TaskSpec, opts: RequestOptions): Promise<TaskOutcome> {
    if (task.threadId && !this.cfg.store) {
      throw new ThreadUnavailableError(
        'Threads are disabled on this server (GEMINI_STORE=false), so thread_id cannot be used. Start a new request with the needed context.',
      );
    }

    const notes: string[] = [];
    let plan = this.plan(task);
    if (task.search && plan.model === this.cfg.freeSearchModel && this.effectiveTier === 'free') {
      notes.push(freeSearchNote(this.cfg.freeSearchModel));
    }
    let thinkingDisabled = false;
    let usedModelFallback = false;
    let usedSearchFallback = false;

    // At most: one thinking retry, one deep-model fallback, one free-tier search fallback.
    for (;;) {
      const body = this.buildBody(task, plan, thinkingDisabled);
      try {
        const interaction = await this.client.createInteraction(body, opts);
        return { interaction, model: plan.model, notes, toolsLabel: toolsLabel(task) };
      } catch (err) {
        if (!(err instanceof GeminiApiError)) throw err;

        if (task.threadId && looksLikeMissingThread(err)) {
          throw new ThreadUnavailableError(
            `Gemini no longer has thread ${task.threadId} (threads are kept ${this.threadRetention}). ` +
              'Start a new request without thread_id and include the context Gemini needs.',
          );
        }

        if (!thinkingDisabled && plan.thinkingLevel && err.httpStatus === 400 && /thinking/i.test(err.message)) {
          log.warn('Model rejected thinking_level; retrying without it', { model: plan.model });
          thinkingDisabled = true;
          continue;
        }

        if (!err.looksLikeTierRestriction) throw err;

        // The deep model (e.g. a Pro preview) may simply not be available to this key: try the standard model first.
        if (!usedModelFallback && plan.model === this.cfg.deepModel && this.cfg.deepModel !== this.cfg.model) {
          usedModelFallback = true;
          notes.push(`${plan.model} isn't available with this API key, so this ran on ${this.cfg.model}.`);
          plan = this.withThinking(this.cfg.model, task.depth);
          continue;
        }

        if (!usedSearchFallback && task.search && plan.model !== this.cfg.freeSearchModel) {
          usedSearchFallback = true;
          if (!this.detectedFreeTier && this.cfg.tier === 'paid') {
            log.warn('Search grounding refused for the configured model; treating API key as free tier', {
              model: plan.model,
              error: err.message,
            });
          }
          this.detectedFreeTier = true;
          notes.push(
            `${plan.model} couldn't use Google Search with this API key (${err.message.slice(0, 160)}), so this ran on ${this.cfg.freeSearchModel}. ` +
              'This usually means the key is on the free tier — enable billing in Google AI Studio for the newest models with search.',
          );
          plan = this.withThinking(this.cfg.freeSearchModel, task.depth);
          continue;
        }

        throw err;
      }
    }
  }

  private withThinking(model: string, depth: Depth): Plan {
    return supportsThinkingLevel(model) ? { model, thinkingLevel: THINKING_BY_DEPTH[depth] } : { model };
  }

  private buildBody(task: TaskSpec, plan: Plan, thinkingDisabled: boolean): CreateInteractionBody {
    const tools: ToolSpec[] = [];
    if (task.search) tools.push({ type: 'google_search' });
    if (task.urlContext) tools.push({ type: 'url_context' });
    if (task.codeExecution) tools.push({ type: 'code_execution' });

    const body: CreateInteractionBody = {
      model: plan.model,
      input: task.input,
      system_instruction: task.systemInstruction,
      store: this.cfg.store,
    };
    if (tools.length > 0) body.tools = tools;
    if (plan.thinkingLevel && !thinkingDisabled) body.generation_config = { thinking_level: plan.thinkingLevel };
    if (task.threadId) body.previous_interaction_id = task.threadId;
    return body;
  }
}

export function supportsThinkingLevel(model: string): boolean {
  return /^gemini-3(\.|-)/.test(model);
}

function freeSearchNote(model: string): string {
  return `Free API tier: Google Search ran on ${model} because Gemini 3.x models can't use search grounding on the free tier.`;
}

function toolsLabel(task: Pick<TaskSpec, 'search' | 'urlContext' | 'codeExecution'>): string {
  const parts: string[] = [];
  if (task.search) parts.push('Google Search');
  if (task.urlContext) parts.push('URL reading');
  if (task.codeExecution) parts.push('code execution');
  return parts.length > 0 ? `Tools: ${parts.join(' + ')}` : 'Tools: none (model knowledge only)';
}

function looksLikeMissingThread(err: GeminiApiError): boolean {
  if (err.httpStatus === 404) return true;
  return err.httpStatus === 400 && /previous_interaction|interaction.{0,40}(not found|does not exist|expired)/i.test(err.message);
}
