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
  /**
   * The host calls a function section as `text({ agent, scope, signal })`
   * (dsh-agent: `assembleContextFor`), and `agent.id === agent.session.id` is
   * enforced by `AgentRegistry.enter()` — that throw is the reason a section can
   * resolve its own session (task-32).
   */
  text: string | ((context?: unknown) => string);
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

export interface WebServerRoute {
  kind?: string;
  path: string;
  handler: (req: any, res: any) => unknown;
}

export interface WebServerService {
  register(route: WebServerRoute): () => void;
}

/**
 * `inject` is the host's own sub-context form used by every bundle that touches
 * a service that may not be mounted yet (`ctx.inject(['webServer'], sub => …)`).
 * Optional: a host build without it simply has no same-origin route surface, and
 * the loopback control server is the fallback.
 */
export interface InjectScope {
  webServer?: WebServerService;
  effect?: (factory: () => unknown, label?: string) => unknown;
  [key: string]: unknown;
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
  inject?: (deps: string[] | string, callback: (sub: InjectScope) => unknown) => unknown;
}
