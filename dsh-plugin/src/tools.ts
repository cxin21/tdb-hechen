import type { MemoryClient, RecallHit } from './memory-client.js';
import type { LoggerLike, ToolDefinitionShape } from './types.js';

/**
 * Recall tool registration.
 *
 * Why `parameters` is raw JSON Schema and not a host field map:
 * `tools.register()` snapshots `definition.parameters` for the model AS IS — it
 * never compiles the DSL field map. Only `defineTool()` compiles it (dsh-tools
 * lib/index.js: `parameterSchemaSpecToJsonSchema`), and defineTool lives in
 * `@deepseek-ai/dsh-tools`, which is NOT resolvable from an installed profile
 * (measured from ~/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh:
 * ERR_MODULE_NOT_FOUND). The old code fell back to an identity wrapper and
 * registered `{query:{type:'string',required:true}}` as if it were JSON Schema —
 * a root without `type:'object'` and a `required` that is not an array, i.e. a
 * definition the model can neither validate nor call. register() never looks at
 * parameters at all, so nothing complained and memory_recall simply never
 * appeared. Emitting a correct schema ourselves removes that peer from the path.
 */

export function formatHits(hits: RecallHit[]): string {
  if (hits.length === 0) return 'no memory hits';
  return hits
    .map((hit) => {
      const label = hit.layer ? `[${hit.layer}] ` : '';
      return `- ${label}${hit.text.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');
}

export interface RecallToolDeps {
  client: MemoryClient;
  defaultLimit: number;
  timeoutMs: number;
  log?: LoggerLike;
}

export function createRecallTool(deps: RecallToolDeps): ToolDefinitionShape {
  return {
    name: 'memory_recall',
    description:
      'Search the user\'s long-term memory (TDB Agemem) for relevant notes, decisions, preferences and prior context. '
      + 'Use it when an answer may depend on something learned in earlier sessions.',
    // A whole JSON Schema object, required by the model-side contract and
    // accepted verbatim by tools.register (see the header note).
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of what to look up.',
        },
        // Optional: it is simply absent from `required` below. Never add a
        // `required: false` beside it — the host's parameter validator rejects
        // that outright ("…required must be true when present").
        limit: {
          type: 'number',
          description: `Maximum number of hits to return (default ${deps.defaultLimit}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') return 'memory unavailable: empty query';
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : deps.defaultLimit;
      const limit = Math.min(50, Math.max(1, Math.floor(requested)));
      try {
        const hits = await deps.client.recall(query, limit, deps.timeoutMs);
        return formatHits(hits);
      } catch (error) {
        deps.log?.warn?.('agemem: recall tool failed', error);
        return 'memory unavailable: recall request failed';
      }
    },
  };
}
