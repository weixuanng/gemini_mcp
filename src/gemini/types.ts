// Minimal wire types for the Gemini Interactions API (POST /v1beta/interactions).
// Field names are snake_case exactly as sent over the wire. Only what this server uses is modelled.

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type InputContent =
  | { type: 'text'; text: string }
  | { type: 'video'; uri: string; mime_type?: string }
  | { type: 'image'; uri: string; mime_type?: string }
  | { type: 'document'; uri: string; mime_type?: string };

export type ToolSpec = { type: 'google_search' } | { type: 'url_context' } | { type: 'code_execution' };

export interface GenerationConfig {
  thinking_level?: ThinkingLevel;
  thinking_summaries?: 'auto' | 'none';
  max_output_tokens?: number;
}

export interface DeepResearchAgentConfig {
  type: 'deep-research';
  thinking_summaries?: 'auto' | 'none';
  collaborative_planning?: boolean;
}

export interface CreateInteractionBody {
  model?: string;
  agent?: string;
  input: string | InputContent[];
  system_instruction?: string;
  tools?: ToolSpec[];
  generation_config?: GenerationConfig;
  agent_config?: DeepResearchAgentConfig;
  previous_interaction_id?: string;
  store?: boolean;
  background?: boolean;
}

export interface Annotation {
  type: string;
  url?: string;
  title?: string;
  /** Byte offsets (UTF-8) into the text block. */
  start_index?: number;
  end_index?: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  annotations?: Annotation[];
  uri?: string;
}

export interface Step {
  type: string;
  id?: string;
  call_id?: string;
  arguments?: { queries?: string[]; urls?: string[]; code?: string; language?: string };
  result?: unknown;
  is_error?: boolean;
  content?: ContentBlock[];
  summary?: ContentBlock[];
  error?: { code?: number; message?: string };
}

export interface Usage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
  total_cached_tokens?: number;
  total_tokens?: number;
  grounding_tool_count?: Array<{ type?: string; count?: number }>;
}

export type InteractionStatus =
  | 'in_progress'
  | 'requires_action'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'incomplete'
  | 'budget_exceeded'
  | 'queued'
  | (string & {});

export interface Interaction {
  id: string;
  status: InteractionStatus;
  model?: string;
  agent?: string;
  created?: string;
  updated?: string;
  previous_interaction_id?: string;
  steps?: Step[];
  usage?: Usage;
  errors?: Array<{ code?: string; message?: string }>;
}
