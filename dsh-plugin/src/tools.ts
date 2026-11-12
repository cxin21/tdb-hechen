import type { MemoryClient, RecallHit, SoulPersonHit, SoulPersonProfile } from './memory-client.js';
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
  /**
   * The session this host is serving right now, when it knows one. The tool
   * call itself carries no session, so without this the search would use the
   * configured triple while the volatile block of the same turn used the
   * session's bound one — two identities in one turn (measured in the
   * task-117 e2e: recall hit agent A, memory_recall hit agent B).
   */
  sessionId?: () => string | undefined;
}


/**
 * 人物「按名字查」工具（2026-11-12）。
 *
 * 为什么值得单独一个工具：/v3/soul/person 要 person_key，而模型手里只有人说出口的
 * 名字。没有这一步，「查某人的档案」在真实对话里就只能靠记忆里碰巧带了 key。
 *
 * 契约与 memory_recall 一致：失败是可见的字符串，不抛；空结果与查不了分开。
 */
export interface PersonSearchToolDeps {
  client: MemoryClient;
  defaultLimit: number;
  timeoutMs: number;
  log?: LoggerLike;
  sessionId?: () => string | undefined;
}

const MATCH_LABEL: Record<SoulPersonHit['match'], string> = {
  key: 'key',
  exact: '精确',
  prefix: '前缀',
  contains: '包含',
};

const MATCHED_ON_LABEL: Record<SoulPersonHit['matchedOn'], string> = {
  key: 'key',
  display_name: '显示名',
  alias: '别名',
};

export function formatSoulPersons(hits: SoulPersonHit[]): string {
  if (hits.length === 0) return 'no person match';
  return hits
    .map((hit) => {
      const alias = hit.aliases.length > 0 ? ` · 别名: ${hit.aliases.join('/')}` : '';
      return `- ${hit.displayName} (${hit.key}) · 档案 ${hit.fieldCount} 项 · 关系 ${hit.relationCount} · ${MATCH_LABEL[hit.match]}/${MATCHED_ON_LABEL[hit.matchedOn]}${alias}`;
    })
    .join('\n');
}

export function createSoulPersonSearchTool(deps: PersonSearchToolDeps): ToolDefinitionShape {
  return {
    name: 'soul_person_search',
    description:
      'Resolve a person\'s NAME to their person_key in TDB Agemem (exact/prefix/contains over display name and aliases). '
      + 'Call it before memory_soul_person/memory_soul_persons work that needs a key; returns keys, profile field counts and relation counts.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name (or alias, or person_key) as the user said it.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of matches to return (default ${deps.defaultLimit}, max 20).`,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (name === '') return 'memory unavailable: empty person name';
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : deps.defaultLimit;
      const limit = Math.min(20, Math.max(1, Math.floor(requested)));
      try {
        const outcome = await deps.client.searchSoulPersons(name, limit, deps.timeoutMs, deps.sessionId?.());
        if (!outcome.ok) {
          deps.log?.warn?.('agemem: person search failed', outcome.reason);
          return `memory unavailable: person search failed (${outcome.reason})`;
        }
        return formatSoulPersons(outcome.hits);
      } catch (error) {
        deps.log?.warn?.('agemem: person search tool failed', error);
        return 'memory unavailable: person search request failed';
      }
    },
  };
}


/**
 * 人物档案（按名字）：名字 → person_key → 九字段 + 关系边。
 *
 * 这是 `soul_person_search` 的目的地。只给 search 等于让人拿到一串 key 却读不到
 * 任何内容；只给 key 读面又要求调用方先知道 key。合成一个工具，模型才能从
 * 「张三最近怎么样」直接走到「张三的档案写了什么」。
 */
export function formatSoulPersonProfile(profile: SoulPersonProfile): string {
  const head = `${profile.displayName} (${profile.key}) · 档案 ${profile.fields.length} 项 · 关系 ${profile.relations.length}`;
  const aliasLine = profile.aliases.length > 0 ? `别名: ${profile.aliases.join('/')}` : '';
  const fieldLines = profile.fields.length === 0
    ? ['- 还没有提炼出字段']
    : profile.fields.map((f) => `- ${f.label}: ${f.text}${f.stale ? '（可能已过时）' : ''}`);
  const relationLines = profile.relations.length === 0
    ? []
    : ['关系：', ...profile.relations.map((r) => {
      const arrow = r.direction === 'out' ? '→' : r.direction === 'in' ? '←' : '↔';
      const who = r.counterpartName ?? r.counterpartKey ?? '（未登记）';
      return `- ${r.pred} ${arrow} ${who}`;
    })];
  return [head, aliasLine, ...fieldLines, ...relationLines].filter((line) => line !== '').join('\n');
}

export function createSoulPersonProfileTool(deps: PersonSearchToolDeps): ToolDefinitionShape {
  return {
    name: 'soul_person_profile',
    description:
      'Read one person\'s soul profile from TDB Agemem by NAME (or person_key): nine distilled fields plus relation edges. '
      + 'When the name matches several people it lists the candidates instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name, alias or person_key as the user said it.' },
        limit: {
          type: 'number',
          description: `How many name candidates to consider before giving up (default ${deps.defaultLimit}, max 20).`,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (name === '') return 'memory unavailable: empty person name';
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : deps.defaultLimit;
      const limit = Math.min(20, Math.max(1, Math.floor(requested)));
      const sessionId = deps.sessionId?.();
      try {
        let key = name.startsWith('p_') ? name : '';
        if (key === '') {
          const found = await deps.client.searchSoulPersons(name, limit, deps.timeoutMs, sessionId);
          if (!found.ok) {
            deps.log?.warn?.('agemem: person profile search failed', found.reason);
            return `memory unavailable: person search failed (${found.reason})`;
          }
          // 「不猜」：同名多人且没有一条精确命中时，把候选交回去让人自己挑。
          const exact = found.hits.filter((hit) => hit.match === 'key' || hit.match === 'exact');
          if (found.hits.length === 0) return 'no person match';
          if (found.hits.length > 1 && exact.length !== 1) {
            return ['several people match; ask which one, or pass the person_key:', formatSoulPersons(found.hits)].join('\n');
          }
          key = (exact[0] ?? found.hits[0]).key;
        }
        const read = await deps.client.readSoulPerson(key, deps.timeoutMs, sessionId);
        if (!read.ok) {
          deps.log?.warn?.('agemem: person profile read failed', read.reason);
          return `memory unavailable: person profile failed (${read.reason})`;
        }
        return formatSoulPersonProfile(read.profile);
      } catch (error) {
        deps.log?.warn?.('agemem: person profile tool failed', error);
        return 'memory unavailable: person profile request failed';
      }
    },
  };
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
        const hits = await deps.client.recall(query, limit, deps.timeoutMs, deps.sessionId?.());
        return formatHits(hits);
      } catch (error) {
        deps.log?.warn?.('agemem: recall tool failed', error);
        return 'memory unavailable: recall request failed';
      }
    },
  };
}
