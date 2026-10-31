/**
 * Minimal structural types for the DeepSeek Harness (dsh) host surface this
 * plugin touches. Deliberately local: the plugin must load even when the host
 * peer packages are not importable, and these shapes were verified against the
 * live host in docs/ops/dsh-plugin-probe-report.md.
 */

export interface HostMessageSource {
  kind?: string;
  [key: string]: unknown;
}

export interface HostMessage {
  id?: string;
  role?: string;
  source?: HostMessageSource;
  content?: unknown;
  [key: string]: unknown;
}

export interface PromptSectionOptions {
  name: string;
  order: number;
  text: string | (() => string);
  interpolate?: boolean;
  complete?: boolean;
}

export interface SystemPromptService {
  section(options: PromptSectionOptions): () => void;
  getSectionOrder?(name: string): number;
  context?(options: { name: string; order: number; text: string }): () => void;
}

export interface ToolResultBlock {
  type: 'text';
  text: string;
}

export interface ToolDefinitionShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: unknown;
    render(args: Record<string, unknown>, value: unknown): ToolResultBlock[];
  };
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
}


export interface ToolsService {
  register(definition: unknown): () => void;
}

export interface LoggerLike {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

export interface PreStepDecision {
  kind?: string;
  messages?: HostMessage[];
  [key: string]: unknown;
}

export interface SessionLike {
  id?: string;
  [key: string]: unknown;
}

export interface AgentLike {
  session?: SessionLike;
  [key: string]: unknown;
}

export interface SessionEventLike {
  type?: string;
  seq?: number;
  data?: Record<string, any>;
}

export interface AgememContext {
  systemPrompt: SystemPromptService;
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): () => void;
  logger?: LoggerLike;
  reflect?: { get(name: string, strict?: boolean): unknown };
}
