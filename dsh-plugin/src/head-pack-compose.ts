/**
 * Rendering of the low-frequency memory layers into ONE stable prompt section:
 * L3 persona first (`/v3/core/read`), then the L2 scene index
 * (`/v3/scenario/ls`) when enabled.
 *
 * Why this is its own module: the head pack is assembled from registered
 * segments (src/segments/*), and the persona+scene pair is just one of them.
 * Keeping the composition here lets every other segment live in its own file
 * without an import cycle through index.ts.
 */

const SCENARIO_HEADER = '## 长期记忆 · 场景索引（L2）';

/**
 * True when the persona already lists this scene path on its own index line.
 * The live `/v3/core/read` persona ends with the same scene index, one
 * `- <path>（热度 N，更新 YYYY-MM-DD）` line per scene; appending our own bare
 * `- <path>` list beside it repeated every path (334 chars / 6.8% of the head
 * pack on the measured profile, 14 of 14 scenes duplicated).
 *
 * The match is anchored on a leading `- ` and requires a non-path character
 * after the path, so `- scenes/deploy.md` does not swallow `scenes/deploy.md.bak`.
 */
export function personaListsPath(personaText: string, path: string): boolean {
  if (personaText === '') return false;
  const lines = personaText.split(String.fromCharCode(10));
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const at = trimmed.indexOf(path);
    if (at < 0) continue;
    const after = trimmed.slice(at + path.length, at + path.length + 1);
    if (after === '' || !/[A-Za-z0-9_./-]/.test(after)) return true;
  }
  return false;
}

export interface ComposeHeadPackOptions {
  maxChars: number;
  includeScenarioIndex?: boolean;
  maxScenarioEntries?: number;
}

/**
 * Render the two low-frequency memory layers into one stable prompt section.
 * The scenario index is budgeted first so a long persona can never push it out
 * of the section, and the whole result is clamped to `maxChars`.
 */
export function composeHeadPack(
  persona: string | undefined,
  scenarios: string[],
  options: ComposeHeadPackOptions,
): string {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  if (maxChars === 0) return '';
  const personaText = typeof persona === 'string' ? persona.trim() : '';
  const limit = Math.max(1, Math.floor(options.maxScenarioEntries ?? 20));
  const paths = (Array.isArray(scenarios) ? scenarios : [])
    .map((path) => (typeof path === 'string' ? path.trim() : ''))
    .filter((path) => path !== '')
    .slice(0, limit)
    // One index, not two: a path the persona already lists (with its heat and
    // update date) is not repeated as a bare path here.
    .filter((path) => !personaListsPath(personaText, path));

  const scenarioSection = options.includeScenarioIndex === true && paths.length > 0
    ? SCENARIO_HEADER + String.fromCharCode(10) + paths.map((path) => '- ' + path).join(String.fromCharCode(10))
    : '';

  const separator = personaText !== '' && scenarioSection !== '' ? String.fromCharCode(10, 10) : '';
  const personaBudget = Math.max(0, maxChars - scenarioSection.length - separator.length);
  let renderedPersona = personaText;
  if (renderedPersona.length > personaBudget) {
    const marker = '[agemem head pack truncated at ' + personaBudget + ' chars]';
    const keep = Math.max(0, personaBudget - marker.length - 1);
    renderedPersona = (personaText.slice(0, keep) + String.fromCharCode(10) + marker).slice(0, personaBudget);
  }
  const joined = [renderedPersona, scenarioSection].filter((part) => part !== '').join(separator);
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
}
