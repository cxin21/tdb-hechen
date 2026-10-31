import type { AgememContext, PromptSectionOptions } from '../../src/types.js';

/**
 * Minimal fake host context: captures listeners and section registrations, and
 * exposes `emit` so tests can drive the plugin the way the host does.
 */
export interface FakeContext {
  ctx: AgememContext;
  listeners: Map<string, Array<(...args: any[]) => unknown>>;
  sections: PromptSectionOptions[];
  logs: string[];
  /** Structured log calls: `logs` renders parts with String(), so a debug
   * payload (an object) shows as [object Object]; assert fields here instead. */
  rawLogs: Array<{ level: string; parts: unknown[] }>;
  services: Record<string, unknown>;
  emit(event: string, ...args: any[]): unknown;
  listenerCount(event: string): number;
  firstListener(event: string): ((...args: any[]) => unknown) | undefined;
  sectionText(): string;
  dispose(): void;
}

export function createFakeContext(options?: {
  services?: Record<string, unknown>;
  sectionOrder?: number;
  withLogger?: boolean;
}): FakeContext {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const sections: PromptSectionOptions[] = [];
  const logs: string[] = [];
  const rawLogs: Array<{ level: string; parts: unknown[] }> = [];
  const services = options?.services ?? {};

  const record = (level: string, parts: unknown[]): number => {
    rawLogs.push({ level, parts });
    return logs.push(level + ' ' + parts.map(String).join(' '));
  };

  const logger = options?.withLogger === false
    ? undefined
    : {
        debug: (...parts: unknown[]) => record('debug', parts),
        info: (...parts: unknown[]) => record('info', parts),
        warn: (...parts: unknown[]) => record('warn', parts),
      };

  const ctx: AgememContext = {
    systemPrompt: {
      section(sectionOptions: PromptSectionOptions) {
        sections.push(sectionOptions);
        return () => {
          const index = sections.indexOf(sectionOptions);
          if (index >= 0) sections.splice(index, 1);
        };
      },
      getSectionOrder(name: string) {
        return name === 'DEPLOYMENT_PERSONA_SUFFIX' ? (options?.sectionOrder ?? 10200) : 0;
      },
    },
    on(event: string, listener: (...args: any[]) => unknown) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    logger,
    reflect: {
      get(serviceName: string) {
        return services[serviceName];
      },
    },
  };

  return {
    ctx,
    listeners,
    sections,
    logs,
    rawLogs,
    services,
    emit(event: string, ...args: any[]) {
      let result: unknown;
      for (const listener of listeners.get(event) ?? []) result = listener(...args);
      return result;
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
    firstListener(event: string) {
      return (listeners.get(event) ?? [])[0];
    },
    sectionText() {
      const last = sections[sections.length - 1];
      if (!last) return '';
      return typeof last.text === 'function' ? last.text() : last.text;
    },
    dispose() {
      listeners.clear();
      sections.length = 0;
    },
  };
}

/** Run an agent/pre-step waterfall listener with a canned `next()`. */
export async function runPreStep(
  listener: (...args: any[]) => unknown,
  payload: Record<string, unknown>,
  nextResult: unknown,
): Promise<any> {
  return await listener(payload, async () => nextResult);
}
