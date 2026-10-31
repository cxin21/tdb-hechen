import { registerHeadPackSegment } from './registry.js';
import { createSegmentHealth, type SegmentHealth } from '../segment-health.js';
import type { LoggerLike } from '../types.js';

/**
 * Breaker for the listing call (task-98). A dead `/v3/skill/listing` would
 * otherwise cost one failed request per head-pack refresh for the life of the
 * process: three consecutive failures open it for ten minutes, then one probe.
 * Lives outside the spec so a rebuild of the segment does not reset the count.
 */
let healthState: SegmentHealth | undefined;

function healthOf(log?: LoggerLike): SegmentHealth {
  healthState ??= createSegmentHealth({ name: 'skills', ...(log !== undefined ? { logger: log } : {}) });
  return healthState;
}

/** Test hook: start from a closed circuit. */
export function resetSkillsSegmentHealthForTests(): void {
  healthState = undefined;
}

/**
 * `<available_skills>` — the skill catalogue, verbatim from the core.
 *
 * Why not assemble it ourselves: `POST /v3/skill/listing` already returns the
 * exact block the core's own skill injector renders (`data.listing`, measured
 * 6004 chars at char_budget 6000 and 9680 at 64000, with `data.hits` always
 * holding 20 `{skill_id, version, name}` rows). Rebuilding the markdown would
 * drift from the core on the next format change and silently disagree with the
 * name/section hints the model is given there — this is a parity seam, not a
 * rendering job.
 *
 * Failure policy: zero characters + `skills=fail` in the debug line. A missing
 * catalogue degrades capability discovery; it must not break the prompt.
 */
registerHeadPackSegment({
  name: 'skills',
  // After the persona narrative, before knowledge/wiki.
  order: 40,
  cap: 8000,
  // A cut that leaves `<available_skills>` unclosed makes the model read the
  // rest of the prompt as skill text (see registry.cutTagSafe).
  truncate: 'tag-safe',
  enabled: (config) => config.skill.enabled,
  fetch: async ({ skillClient, config, log }) => {
    if (skillClient === undefined) return null;
    const health = healthOf(log);
    if (!health.shouldAttempt()) {
      // Reported as empty, not failed: the segment is being skipped on purpose
      // and the debug line carries `circuit=open(...)` so the log still says why.
      log?.debug?.('agemem: skills segment circuit open, request skipped', { circuit: health.describe() });
      return { text: '', chars: 0 };
    }
    const result = await skillClient.listing(config.skill.headPackChars);
    if (!result.ok) {
      // Classification follows segment-health: a real status code is http_<status>,
      // everything else (socket reset, timeout) is transport. Never http_0.
      const reason = typeof result.status === 'number' && result.status > 0 ? 'http_' + result.status : 'transport';
      health.recordFailure(reason);
      log?.debug?.('agemem: skills segment failed; continuing with zero characters', { error: result.error, code: result.code, circuit: health.describe() });
      // Zero characters, but reported as a FAILURE: '/v3/skill/listing' 5xx and
      // 'the team has no skills' both render nothing, and only this flag tells
      // an operator which one they are looking at (`skills=failed:0`).
      return { text: '', chars: 0, failed: true };
    }
    // The endpoint answered: an empty catalogue is a healthy empty, not a fault.
    health.recordSuccess();
    const listing = (result.data?.listing ?? '').trim();
    if (listing === '') return null;
    return { text: listing, chars: listing.length, truncated: result.data?.truncated === true };
  },
});
