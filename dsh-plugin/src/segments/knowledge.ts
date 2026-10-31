/**
 * `<knowledge_tools>` volatile segment (task-97 wiring).
 *
 * `src/knowledge-segment.ts` (owned by the module that measured it) lists the
 * team's ready knowledge resources and renders the block; this file only
 * adapts it to the volatile seam. ON by default because `/v3/knowledge/list`
 * answers 200 in ~7ms on 8420 (measured 2026-11-01 02:05, one resource); the
 * block is budget-bound, so an empty team costs one cheap call per turn.
 */
import { registerVolatileSegment, type SegmentDeps, type SegmentResult } from './registry.js';
import { registerVolatileKnowledgeSegment, type KnowledgeSegmentHandle } from '../knowledge-segment.js';
import { createSegmentHealth } from '../segment-health.js';

let cached: { key: string; handle: KnowledgeSegmentHandle } | undefined;

function handleFor(deps: SegmentDeps): KnowledgeSegmentHandle {
  const key = JSON.stringify([
    deps.config.volatile.knowledge,
    deps.config.server.teamId,
    deps.config.server.userId,
    deps.config.server.serviceId,
  ]);
  if (cached !== undefined && cached.key === key) return cached.handle;
  const handle = registerVolatileKnowledgeSegment({
    call: (path, body, options) => deps.client.v3(path, body, options),
    identity: () => ({
      teamId: deps.config.server.teamId,
      userId: deps.config.server.userId,
      serviceId: deps.config.server.serviceId,
    }),
    config: deps.config.volatile.knowledge,
    ...(deps.log !== undefined ? { logger: deps.log } : {}),
    // One breaker per memoized handle (a per-turn instance would reset the
    // failure count before it could ever reach the threshold).
    health: createSegmentHealth({
      name: 'knowledge',
      ...(deps.log !== undefined ? { logger: deps.log } : {}),
    }),
  });
  cached = { key, handle };
  return handle;
}

/** Test hook: drop the memoized handle so a test's config/identity takes effect. */
export function resetKnowledgeSegmentForTests(): void {
  cached = undefined;
}

registerVolatileSegment({
  name: 'knowledge',
  // Last: it takes whatever the wiki segment left of the block budget.
  order: 60,
  cap: 3000,
  enabled: (config) => config.volatile.enabled && config.volatile.knowledge.enabled,
  fetch: async (deps): Promise<SegmentResult | null> => {
    const knowledge = handleFor(deps);
    const result = await knowledge.retrieve({ maxChars: knowledge.config.maxChars });
    // `knowledge=on resources=1 chars=270 ms=12 fail=-` (module's own renderer).
    deps.log?.debug?.('agemem: ' + knowledge.describe(result));
    const text = result.text.trim();
    if (text === '') {
      const reason = result.diagnostic.reason;
      const normal = reason === undefined || reason === 'empty_list';
      return { text: '', chars: 0, failed: result.diagnostic.ok !== true && !normal };
    }
    return { text, chars: text.length };
  },
});
