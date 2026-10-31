/**
 * Segment-level circuit breaker (task-98).
 *
 * Why a separate breaker from the recall one: \`/v3/recall\` fails with 422 when
 * the CONFIG is wrong, so src/index.ts opens a permanent circuit (retrying a
 * misconfiguration forever is pointless). The volatile segments fail for a
 * different reason — the endpoint may simply not be deployed yet (\`/v3/wiki/*\`
 * 404s until the core is restarted with task-73) or the core may be restarting.
 * So a segment breaker is TEMPORARY: after \`cooldownMs\` it lets exactly one
 * probe through, and one success closes it again.
 *
 * Why it matters at all: \`volatile.wiki.enabled\` and \`volatile.knowledge.enabled\`
 * default to true, so without this every turn fires a request that cannot
 * succeed, adds an RTT and prints a warn — the user's first impression of the
 * plugin is a wall of failures.
 *
 * Contract for callers: after \`shouldAttempt()\` returns true you MUST call
 * \`recordSuccess()\` or \`recordFailure(reason)\`. The half-open lease expires
 * after \`cooldownMs\` so a caller that forgets cannot wedge the segment shut.
 */
import type { LoggerLike } from './types.js';

export const SEGMENT_HEALTH_DEFAULT_THRESHOLD = 3;
export const SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS = 10 * 60_000;

export interface SegmentHealthOptions {
  /** Segment name used in every log line and in describe(). */
  name: string;
  /** Consecutive failures that open the circuit (default 3). */
  threshold?: number;
  /** How long the circuit stays open before one probe is allowed (default 10min). */
  cooldownMs?: number;
  logger?: LoggerLike;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

export interface SegmentHealthSnapshot {
  state: 'closed' | 'open';
  failures: number;
  reason?: string;
  /** Milliseconds until the next probe is allowed (0 when a probe is due). */
  retryInMs: number;
  probing: boolean;
}

export interface SegmentHealth {
  readonly name: string;
  /** True when a request may be issued (closed, or the single half-open probe). */
  shouldAttempt(): boolean;
  recordSuccess(): void;
  recordFailure(reason?: string): void;
  /** \`closed\` | \`open(http_404, 3, retryIn=540s)\` | \`open(transport, 3, probing)\`. */
  describe(): string;
  snapshot(): SegmentHealthSnapshot;
  /** Manual reset (the wiring doc documents this as the operator escape hatch). */
  reset(): void;
}

function clampPositive(value: unknown, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return num > 0 ? num : fallback;
}

/**
 * Create one breaker per failure domain. Wiki, the knowledge core leg and the
 * knowledge tools leg each get their own instance: one dead endpoint must not
 * silence a healthy sibling.
 */
export function createSegmentHealth(options: SegmentHealthOptions): SegmentHealth {
  const name = typeof options?.name === 'string' && options.name !== '' ? options.name : 'segment';
  const threshold = clampPositive(options?.threshold, SEGMENT_HEALTH_DEFAULT_THRESHOLD);
  const cooldownMs = clampPositive(options?.cooldownMs, SEGMENT_HEALTH_DEFAULT_COOLDOWN_MS);
  const clock = typeof options?.now === 'function' ? options.now : () => Date.now();
  const logger = options?.logger;

  let state: 'closed' | 'open' = 'closed';
  let failures = 0;
  let reason: string | undefined;
  let openedAt = 0;
  let probing = false;
  let probeStartedAt = 0;
  /** One warn per open episode; a failed probe re-opens silently (debug only). */
  let warned = false;

  const retryInMs = (): number => {
    if (state !== 'open') return 0;
    return Math.max(0, cooldownMs - (clock() - openedAt));
  };

  return {
    name,

    shouldAttempt(): boolean {
      if (state === 'closed') return true;
      if (retryInMs() > 0) return false;
      if (probing) {
        // A probe that never reported back must not wedge the segment shut.
        if (clock() - probeStartedAt < cooldownMs) return false;
        probing = false;
      }
      probing = true;
      probeStartedAt = clock();
      return true;
    },

    recordSuccess(): void {
      const wasOpen = state === 'open';
      probing = false;
      state = 'closed';
      failures = 0;
      reason = undefined;
      openedAt = 0;
      warned = false;
      if (wasOpen) logger?.info?.('agemem: ' + name + ' segment health=closed (recovered)');
    },

    recordFailure(failureReason?: string): void {
      const why = typeof failureReason === 'string' && failureReason !== '' ? failureReason : 'unknown';
      probing = false;
      failures += 1;
      if (state === 'open') {
        // Failed probe: restart the cooldown, stay open, no second warn.
        openedAt = clock();
        reason = why;
        logger?.debug?.('agemem: ' + name + ' segment health=open reason=' + why + ' (probe failed)');
        return;
      }
      if (failures < threshold) return;
      state = 'open';
      openedAt = clock();
      reason = why;
      if (!warned) {
        warned = true;
        logger?.warn?.(
          'agemem: ' + name + ' segment open reason=' + why +
          ' threshold=' + threshold + ' cooldown=' + Math.round(cooldownMs / 1000) + 's' +
          ' (injection stays fail-open; one probe after cooldown)',
        );
      }
    },

    describe(): string {
      if (state === 'closed') return 'closed';
      if (probing) return 'open(' + (reason ?? 'unknown') + ', ' + threshold + ', probing)';
      return 'open(' + (reason ?? 'unknown') + ', ' + threshold + ', retryIn=' +
        Math.ceil(retryInMs() / 1000) + 's)';
    },

    snapshot(): SegmentHealthSnapshot {
      return {
        state,
        failures,
        ...(reason !== undefined ? { reason } : {}),
        retryInMs: retryInMs(),
        probing,
      };
    },

    reset(): void {
      state = 'closed';
      failures = 0;
      reason = undefined;
      openedAt = 0;
      probing = false;
      warned = false;
      logger?.info?.('agemem: ' + name + ' segment health=closed (reset)');
    },
  };
}

/**
 * Map a fetch-level failure reason onto "does this count as a segment failure".
 *
 * Only transport / HTTP / envelope / payload / size problems mean "the segment
 * is unhealthy". A healthy endpoint that simply had nothing to return
 * (no_hits, empty list, zero budget) must NOT open the circuit. `too_large` is a
 * failure: a peer that answers with a body we refuse to hold is broken, and
 * retrying it every turn only burns RTT (task-101).
 */
export function isSegmentFailure(reason: string | undefined): boolean {
  if (typeof reason !== 'string' || reason === '') return false;
  return reason === 'transport' || reason === 'bad_envelope' || reason === 'bad_payload' ||
    reason === 'too_large' || reason.startsWith('http_');
}
