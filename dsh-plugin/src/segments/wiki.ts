/**
 * `<team-wiki>` volatile segment (task-74 wiring).
 *
 * The search + rendering logic lives in `src/wiki-segment.ts` (owned by the
 * module that measured it); this file only adapts it to the volatile seam:
 * turn text in, characters out, zero characters on every failure.
 *
 * Default is OFF (`config.volatile.wiki.enabled = false`): `/v3/wiki/search`
 * has never answered on the 8420 build, so an enabled-by-default segment would
 * buy one 404 per turn. Fail-open is total — see `fail=http_404` in the debug
 * line when an operator flips it on before the core ships the route.
 */
import { registerVolatileSegment, type SegmentDeps, type SegmentResult } from './registry.js';
import { createSegmentHealth } from '../segment-health.js';
import { registerVolatileWikiSegment, type WikiSegmentHandle } from '../wiki-segment.js';

let cached: { key: string; handle: WikiSegmentHandle } | undefined;

/**
 * One handle per (config, identity) pair: the handle owns the breaker state
 * (task-98), which is worthless if it is rebuilt every turn.
 */
function handleFor(deps: SegmentDeps): WikiSegmentHandle {
  const key = JSON.stringify([
    deps.config.volatile.wiki,
    deps.config.server.teamId,
    deps.config.server.userId,
  ]);
  if (cached !== undefined && cached.key === key) return cached.handle;
  const handle = registerVolatileWikiSegment({
    call: (path, body, options) => deps.client.v3(path, body, options),
    identity: () => ({ teamId: deps.config.server.teamId, userId: deps.config.server.userId }),
    config: deps.config.volatile.wiki,
    ...(deps.log !== undefined ? { logger: deps.log } : {}),
    // Breaker belongs to the handle, so it must live as long as the memoized
    // handle: rebuilding it every turn would reset the failure count to zero.
    health: createSegmentHealth({
      name: 'wiki',
      ...(deps.log !== undefined ? { logger: deps.log } : {}),
    }),
  });
  cached = { key, handle };
  return handle;
}

/** Test hook: drop the memoized handle so a test's config/identity takes effect. */
export function resetWikiSegmentForTests(): void {
  cached = undefined;
}

registerVolatileSegment({
  name: 'wiki',
  // After the memory block, before knowledge (task-97 declares order 60).
  order: 50,
  cap: 800,
  enabled: (config) => config.volatile.enabled && config.volatile.wiki.enabled,
  fetch: async (deps): Promise<SegmentResult | null> => {
    const query = (deps.query ?? '').trim();
    if (query === '') return null;
    const wiki = handleFor(deps);
    const result = await wiki.retrieve(query, { maxChars: wiki.config.maxChars });
    // One diagnostic line per turn, same shape the module uses everywhere:
    // `wiki=on entries=3 chars=412 ms=37 fail=-`.
    deps.log?.debug?.('agemem: ' + wiki.describe(result));
    const text = result.text.trim();
    if (text === '') {
      const reason = result.diagnostic.reason;
      // `no_hits` / `empty_query` are normal answers, not capability failures:
      // they must not be reported as `failed` (different operator action).
      const normal = reason === undefined || reason === 'no_hits' || reason === 'empty_query';
      return { text: '', chars: 0, failed: result.diagnostic.ok !== true && !normal };
    }
    return {
      text,
      chars: text.length,
      truncated: result.diagnostic.deadlineHit === true,
    };
  },
});
