import type { GeminiConfig, Tier } from '../config.js';
import { GeminiApiError, type GeminiClient, type RequestOptions } from './client.js';
import type { CreateInteractionBody, InputContent, Interaction, ThinkingLevel, ToolSpec } from './types.js';
import { log } from '../util/log.js';

export type Depth = 'quick' | 'standard' | 'deep';

export interface TaskSpec {
  /** Builds the system instruction for the tools actually available (search may be unavailable on free keys). */
  instruction: (caps: { search: boolean }) => string;
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

const NO_SEARCH_NOTE =
  "Google Search isn't available with this API key: on the free tier, Gemini 3.x can't use search and Gemini 2.5 " +
  "is closed to new users. Gemini answered from its own knowledge and any URLs given, so treat recent facts with caution. " +
  'Enable billing for the key in Google AI Studio (then set GEMINI_TIER=paid) to turn on live search.';

export class ThreadUnavailableError extends Error {
  override name = 'ThreadUnavailableError';
}

/** Picks models for the configured tier and recovers from tier restrictions by falling back once per kind. */
export class GeminiRunner {
  private detectedFreeTier = false;
  /** Set once no search-capable model works with this key (free tier, new users). */
  private searchUnavailable = false;

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

  /** Human-readable description of how web search is currently handled. */
  get searchStatus(): string {
    if (this.searchUnavailable) return 'unavailable with this API key (free tier), so search tools fall back to model knowledge plus URL reading';
    return `uses ${this.plan({ depth: 'standard', search: true }).model}`;
  }

  plan(task: Pick<TaskSpec, 'depth' | 'search'>): Plan {
    if (task.search && !this.searchUnavailable && this.effectiveTier === 'free') {
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
    let search = task.search && !this.searchUnavailable;
    if (task.search && !search) notes.push(NO_SEARCH_NOTE);
    let plan = this.plan({ depth: task.depth, search });
    if (search && plan.model === this.cfg.freeSearchModel && this.effectiveTier === 'free') {
      notes.push(freeSearchNote(this.cfg.freeSearchModel));
    }
    let thinkingDisabled = false;
    let usedModelFallback = false;
    let usedSearchFallback = false;
    let usedNoSearchFallback = false;
    const overloadFallbacks = this.cfg.fallbackModels.filter((m) => m !== plan.model);

    // Each fallback is used at most once: thinking level, deep model, free-tier search model, no search.
    for (;;) {
      const body = this.buildBody(task, plan, search, thinkingDisabled);
      try {
        const interaction = await this.client.createInteraction(body, opts);
        return { interaction, model: plan.model, notes, toolsLabel: toolsLabel({ ...task, search }) };
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

        // Overloaded ("high demand") after the client's own retries: try another model of the same family.
        if (err.isOverloaded && overloadFallbacks.length > 0 && plan.model !== this.cfg.freeSearchModel) {
          const next = overloadFallbacks.shift()!;
          log.warn('Model overloaded; trying a fallback model', { model: plan.model, fallback: next });
          notes.push(`${plan.model} was overloaded at Google, so this ran on ${next}.`);
          plan = this.withThinking(next, task.depth);
          continue;
        }

        if (!err.looksLikeTierRestriction && !err.isModelUnavailable) throw err;

        // The deep model (e.g. a Pro preview) may simply not be available to this key: try the standard model first.
        if (!usedModelFallback && plan.model === this.cfg.deepModel && this.cfg.deepModel !== this.cfg.model) {
          usedModelFallback = true;
          notes.push(`${plan.model} isn't available with this API key, so this ran on ${this.cfg.model}.`);
          plan = this.withThinking(this.cfg.model, task.depth);
          continue;
        }

        // Search refused for a 3.x model: the key is probably free tier, where only the older model may search.
        if (!usedSearchFallback && search && plan.model !== this.cfg.freeSearchModel && err.looksLikeTierRestriction) {
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

        // No search-capable model works with this key: answer without Google Search rather than failing.
        if (!usedNoSearchFallback && search) {
          usedNoSearchFallback = true;
          this.searchUnavailable = true;
          log.warn('No search-capable model available for this key; continuing without Google Search', {
            model: plan.model,
            error: err.message,
          });
          search = false;
          for (let i = notes.length - 1; i >= 0; i--) {
            if (notes[i]!.includes(this.cfg.freeSearchModel)) notes.splice(i, 1);
          }
          notes.push(NO_SEARCH_NOTE);
          plan = this.withThinking(task.depth === 'deep' ? this.cfg.deepModel : this.cfg.model, task.depth);
          continue;
        }

        throw err;
      }
    }
  }

  private withThinking(model: string, depth: Depth): Plan {
    return supportsThinkingLevel(model) ? { model, thinkingLevel: THINKING_BY_DEPTH[depth] } : { model };
  }

  private buildBody(task: TaskSpec, plan: Plan, search: boolean, thinkingDisabled: boolean): CreateInteractionBody {
    const tools: ToolSpec[] = [];
    if (search) tools.push({ type: 'google_search' });
    if (task.urlContext) tools.push({ type: 'url_context' });
    if (task.codeExecution) tools.push({ type: 'code_execution' });

    const body: CreateInteractionBody = {
      model: plan.model,
      input: task.input,
      system_instruction: task.instruction({ search }),
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
  if (err.isModelUnavailable) return false;
  if (err.httpStatus === 404) return true;
  return err.httpStatus === 400 && /previous_interaction|interaction.{0,40}(not found|does not exist|expired)/i.test(err.message);
}
