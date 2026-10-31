import { composeHeadPack } from '../head-pack-compose.js';
import { stripSceneNavigation } from '../head-pack.js';
import { registerHeadPackSegment } from './registry.js';

/**
 * Persona (L3) — the operator's narrative, and nothing else.
 *
 * `cap: 'remainder'` because it is the text a human wrote: every structured
 * segment (core memory, L2 scene index, skills) declares a fixed cap first, and
 * the persona takes what is left.
 *
 * The L3 payload (`/v3/core/read` → `data.content`) ends with its own
 * `## 🗺️ Scene Navigation (Scene Index)` block — 14 `### Path:` sections with
 * heat/update/summary, ~6.2k of the measured 10k chars. That block is NOT the
 * prompt's scene index any more (task-103): `src/segments/l2.ts` renders the
 * index from `/v3/scenario/ls` with summaries under its own budget. Keeping
 * both would list every scene twice and spend the persona's remainder on a
 * duplicate, so the persona drops the trailing block verbatim and keeps the
 * narrative — `stripSceneNavigation` cuts from the heading to EOF and is a
 * no-op when the shape changes (fail open: never lose the narrative).
 */
registerHeadPackSegment({
  name: 'persona',
  order: 10,
  cap: 'remainder',
  enabled: (config) => config.headPack.enabled,
  fetch: async ({ client, config }) => {
    const core = await client.readCore(config.headPack.timeoutMs);
    const narrative = stripSceneNavigation(core?.content ?? '');
    const text = composeHeadPack(narrative, [], {
      // The assembler clamps to the real remainder; this is only the persona's
      // own inner budget (composeHeadPack also owns the truncation marker).
      maxChars: config.headPack.maxChars,
      includeScenarioIndex: false,
    });
    const trimmed = text.trim();
    return trimmed === '' ? null : { text: trimmed, chars: trimmed.length };
  },
});