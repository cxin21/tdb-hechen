/**
 * L2 scene index as its own head-pack segment (task-103).
 *
 * Before this file the persona segment fetched `/v3/scenario/ls` and appended a
 * bare `- <path>` list, while the persona body itself carried a `### Path:`
 * block with heat/update/summary. Two indexes, neither with the fields the model
 * needs to decide what to read. Now:
 *
 *   persona (order 10)  narrative only, its trailing scene block stripped;
 *   l2      (order 20)  `- scene_blocks/<path>（更新 YYYY-MM-DD）— <summary>`
 *
 * The line shape and the renderer are the record pipeline's (`src/head-pack.ts`,
 * `renderL2Section` / `l2StatusLabel` / `parseL2Outcome` / `classifyL2Failure`).
 * This module only WIRES them: enabled gate, budget, one client call, and the
 * four-state status label the mount line and the compose debug line print.
 *
 * ## Why the status label exists
 *
 * `l2=empty` (the team has no scenes yet) and `l2=fail:http_404` (the endpoint
 * is gone) both render zero characters, and they call for opposite operator
 * actions. Flattening a failure into `[]` — what `listScenarios()` has to do for
 * its legacy callers — would hide that difference, so the segment uses
 * `listScenariosRich()` and keeps the reason.
 */
import type { AgememConfig } from '../config.js';
import {
  L2_MAX_CHARS,
  classifyL2Failure,
  l2StatusLabel,
  renderL2Section,
  type L2FetchOutcome,
} from '../head-pack.js';
import { registerHeadPackSegment } from './registry.js';

/** `l2=ok(14,2434)` — set by the segment's own fetch; undefined before it ran. */
let lastLabel: string | undefined;

/**
 * The status part after `l2=`: `ok(14,2434)` / `empty` / `truncated(0,14)` /
 * `fail:<reason>`. Undefined until the first fetch, so the mount line can print
 * `pending` instead of inventing a result.
 */
export function l2StatusSummary(): string | undefined {
  // l2StatusLabel already prefixes `l2=`; the mount line adds its own prefix.
  return lastLabel === undefined ? undefined : lastLabel.slice('l2='.length);
}

/** Full debug label for the compose log line; `l2=fail:no_data` before the fetch. */
export function l2StatusForDebug(): string {
  return lastLabel ?? 'l2=fail:no_data';
}

/** Test hook: segment status is process-global against a module-level client. */
export function resetL2StatusForTests(): void {
  lastLabel = undefined;
}

/** The L2 fetch never throws: a failure is an outcome with a reason. */
async function fetchOutcome(
  client: { listScenariosRich?: (timeoutMs?: number) => Promise<L2FetchOutcome> },
  timeoutMs: number,
): Promise<L2FetchOutcome> {
  // A test fake (or an older client) may not carry the rich method; the failure
  // is reported as such instead of throwing inside the assembler.
  if (typeof client.listScenariosRich !== 'function') return { ok: false, reason: 'no_client' };
  try {
    return await client.listScenariosRich(timeoutMs);
  } catch (error) {
    return { ok: false, reason: classifyL2Failure(error) };
  }
}

/**
 * Budget for this segment: the configured cap, never above the renderer's own
 * ceiling (a larger number would be cut by the registration `cap` anyway, and
 * two ceilings that disagree are worse than one).
 */
export function l2Budget(config: AgememConfig): number {
  const configured = Math.floor(Number(config.headPack.l2Chars));
  const safe = Number.isFinite(configured) ? configured : L2_MAX_CHARS;
  return Math.max(0, Math.min(safe, L2_MAX_CHARS));
}

registerHeadPackSegment({
  name: 'l2',
  order: 20,
  // Registration caps are static; `l2Budget()` applies the configured value
  // inside the fetch, so this is only the hard ceiling.
  cap: L2_MAX_CHARS,
  // `includeScenarioIndex` is the operator switch that has always meant 'show
  // the model which L2 scenes exist'; it now selects this segment instead of a
  // bare path list appended to the persona.
  enabled: (config) => config.headPack.enabled && config.headPack.includeScenarioIndex,
  fetch: async ({ client, config, log }) => {
    const budget = l2Budget(config);
    const outcome = await fetchOutcome(client, config.headPack.timeoutMs);
    const section = renderL2Section(outcome.ok ? outcome.entries : [], { budget });
    lastLabel = l2StatusLabel(outcome, section);
    if (!outcome.ok) {
      log?.debug?.('agemem: l2 segment failed', {
        l2: lastLabel,
        reason: outcome.reason,
        budget,
      });
    }
    if (section.text === '') {
      // `failed` keeps `l2=failed:0` distinguishable from `l2=empty:0` in the
      // segment summary; a truncation to zero lines is empty, not failed.
      return outcome.ok ? { text: '', chars: 0 } : { text: '', chars: 0, failed: true };
    }
    return { text: section.text, chars: section.chars };
  },
});