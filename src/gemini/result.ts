import type { Annotation, ContentBlock, Interaction, Step, Usage } from './types.js';

export interface Source {
  n: number;
  url: string;
  title?: string;
}

export interface UrlResult {
  url: string;
  status: string;
}

export interface ParsedInteraction {
  id: string;
  status: string;
  /** Final answer text with inline citation markers like [1] or [1, 3]. */
  text: string;
  sources: Source[];
  searchQueries: string[];
  urlResults: UrlResult[];
  codeRuns: number;
  /** Latest thought summary, when the request asked for summaries (used for deep-research progress). */
  thoughtSummary: string;
  problems: string[];
  usage?: Usage;
}

export function parseInteraction(interaction: Interaction): ParsedInteraction {
  const steps = interaction.steps ?? [];
  const registry = new SourceRegistry();

  const text = finalTextBlocks(steps)
    .map((block) => insertCitations(block.text ?? '', block.annotations ?? [], registry))
    .join('');

  const searchQueries: string[] = [];
  const urlStatuses = new Map<string, string>();
  let codeRuns = 0;
  let thoughtSummary = '';
  const problems: string[] = [];

  for (const step of steps) {
    switch (step.type) {
      case 'google_search_call':
        for (const q of step.arguments?.queries ?? []) {
          const query = q.trim();
          if (query && !searchQueries.includes(query)) searchQueries.push(query);
        }
        break;
      case 'url_context_result':
        if (Array.isArray(step.result)) {
          for (const r of step.result as Array<{ url?: unknown; status?: unknown }>) {
            if (typeof r?.url === 'string') urlStatuses.set(r.url, typeof r.status === 'string' ? r.status : 'unknown');
          }
        }
        break;
      case 'code_execution_call':
        codeRuns++;
        break;
      case 'thought': {
        const summary = (step.summary ?? [])
          .map((s) => (s.type === 'text' ? (s.text ?? '') : ''))
          .join('')
          .trim();
        if (summary) thoughtSummary = summary;
        break;
      }
      case 'model_output':
        if (step.error?.message) problems.push(step.error.message);
        break;
    }
  }

  for (const e of interaction.errors ?? []) {
    if (e.message) problems.push(e.message);
  }
  const statusProblem = describeStatus(interaction.status);
  if (statusProblem) problems.push(statusProblem);

  return {
    id: interaction.id,
    status: interaction.status,
    text,
    sources: registry.list(),
    searchQueries,
    urlResults: [...urlStatuses].map(([url, status]) => ({ url, status })),
    codeRuns,
    thoughtSummary,
    problems,
    usage: interaction.usage,
  };
}

function describeStatus(status: string): string | undefined {
  switch (status) {
    case 'completed':
    case 'in_progress':
    case 'queued':
      return undefined;
    case 'incomplete':
      return 'Gemini stopped before finishing (status: incomplete) — the answer may be cut off.';
    case 'budget_exceeded':
      return 'Gemini hit its token budget before finishing (status: budget_exceeded) — the answer may be partial.';
    case 'failed':
      return 'The Gemini interaction failed.';
    case 'cancelled':
      return 'The Gemini interaction was cancelled.';
    default:
      return `Unexpected interaction status: ${status}.`;
  }
}

/**
 * The text of the final answer: the last contiguous run of text blocks produced by the model
 * (earlier model_output steps are usually "let me search…" narration between tool calls).
 */
function finalTextBlocks(steps: Step[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let collecting = false;
  outer: for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.type === 'user_input') break;
    if (step.type !== 'model_output' || !step.content) {
      if (collecting) break;
      continue;
    }
    for (let j = step.content.length - 1; j >= 0; j--) {
      const block = step.content[j]!;
      if (block.type === 'text') {
        collecting = true;
        blocks.push(block);
      } else if (collecting) {
        break outer;
      }
    }
  }
  return blocks.reverse();
}

export class SourceRegistry {
  private readonly byKey = new Map<string, Source>();

  register(url: string, title?: string): number {
    const key = normalizeUrl(url);
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return existing.n;
    }
    const source: Source = { n: this.byKey.size + 1, url, title: title?.trim() || undefined };
    this.byKey.set(key, source);
    return source.n;
  }

  list(): Source[] {
    return [...this.byKey.values()];
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return url.trim();
  }
}

/**
 * Inserts citation markers at the end of each cited segment. Annotation offsets are UTF-8 byte
 * offsets, so the text is handled as bytes and offsets are snapped to character boundaries.
 */
export function insertCitations(text: string, annotations: Annotation[], registry: SourceRegistry): string {
  const buf = Buffer.from(text, 'utf8');
  const inserts = new Map<number, Set<number>>();

  for (const a of annotations) {
    if (a.type !== 'url_citation' || !a.url) continue;
    const n = registry.register(a.url, a.title);
    let pos = Math.min(Math.max(a.end_index ?? buf.length, 0), buf.length);
    while (pos < buf.length && (buf[pos]! & 0xc0) === 0x80) pos++; // inside a multi-byte character
    while (pos > 0 && isWhitespaceByte(buf[pos - 1]!)) pos--; // keep markers on the cited line
    let set = inserts.get(pos);
    if (!set) inserts.set(pos, (set = new Set()));
    set.add(n);
  }
  if (inserts.size === 0) return text;

  let out = '';
  let prev = 0;
  for (const pos of [...inserts.keys()].sort((a, b) => a - b)) {
    out += buf.subarray(prev, pos).toString('utf8');
    out += ` [${[...inserts.get(pos)!].sort((a, b) => a - b).join(', ')}]`;
    prev = pos;
  }
  return out + buf.subarray(prev).toString('utf8');
}

function isWhitespaceByte(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
}

export interface RenderOptions {
  heading: string;
  model: string;
  toolsLabel?: string;
  notes: string[];
  threadId?: string;
  threadHint?: string;
  maxChars: number;
}

const URL_STATUS_LABEL: Record<string, string> = {
  success: '✅ read',
  error: '❌ could not be read',
  paywall: '🔒 paywalled — not read',
  unsafe: '⛔ blocked as unsafe — not read',
};

export function renderParsed(parsed: ParsedInteraction, o: RenderOptions): string {
  const meta = [`Model: ${o.model}`];
  if (o.toolsLabel) meta.push(o.toolsLabel);
  if (parsed.searchQueries.length > 0) meta.push(`${parsed.searchQueries.length} Google searches`);
  if (parsed.codeRuns > 0) meta.push(`${parsed.codeRuns} code runs`);
  const tokens = formatUsage(parsed.usage);
  if (tokens) meta.push(tokens);

  const tail: string[] = [];
  if (parsed.sources.length > 0) {
    tail.push(
      '### Sources cited by Gemini',
      ...parsed.sources.map((s) => `${s.n}. [${escapeLinkText(s.title || hostOf(s.url))}](${s.url})`),
      '',
    );
  }
  if (parsed.searchQueries.length > 0) {
    tail.push(
      '### Google Search suggestions (queries Gemini ran)',
      ...parsed.searchQueries.map(
        (q) => `- [${escapeLinkText(q)}](https://www.google.com/search?q=${encodeURIComponent(q)})`,
      ),
      '',
    );
  }
  if (parsed.urlResults.length > 0) {
    tail.push(
      '### URLs Gemini tried to read',
      ...parsed.urlResults.map((r) => `- ${URL_STATUS_LABEL[r.status] ?? `⚠️ ${r.status}`} — ${r.url}`),
      '',
    );
  }
  const notes = [...parsed.problems, ...o.notes];
  if (notes.length > 0) {
    tail.push('### Notes', ...notes.map((n) => `- ${n}`), '');
  }
  if (o.threadId) {
    tail.push('---', `**thread_id:** \`${o.threadId}\`${o.threadHint ? ` — ${o.threadHint}` : ''}`);
  }

  const head = `## ${o.heading}\n_${meta.join(' · ')}_\n\n`;
  const tailText = tail.length > 0 ? `\n\n${tail.join('\n')}` : '';
  let body = parsed.text.trim() || `_(Gemini returned no text; status: ${parsed.status}.)_`;

  const budget = o.maxChars - head.length - tailText.length;
  if (body.length > budget) {
    const keep = Math.max(500, budget - 120);
    body = `${body.slice(0, keep)}\n\n_[…truncated ${body.length - keep} characters to fit the tool-result size limit]_`;
  }
  return `${head}${body}${tailText}`;
}

function formatUsage(usage: Usage | undefined): string | undefined {
  if (!usage?.total_input_tokens && !usage?.total_output_tokens) return undefined;
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('en-US');
  const thought = usage.total_thought_tokens ? ` (+${fmt(usage.total_thought_tokens)} thinking)` : '';
  return `${fmt(usage.total_input_tokens)} in / ${fmt(usage.total_output_tokens)} out tokens${thought}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');
}

