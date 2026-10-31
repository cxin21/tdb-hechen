import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HeadPack,
  L2_MAX_CHARS,
  L2_SECTION_HEADER,
  classifyL2Failure,
  formatL2Line,
  formatL2Path,
  l2StatusLabel,
  parseL2Outcome,
  renderL2Section,
  stripSceneNavigation,
} from '../src/head-pack.js';
import type { L2FetchOutcome, L2SceneEntry } from '../src/head-pack.js';

/**
 * L2 scene-index segment, pure-function level.
 *
 * The rendered section is produced by `src/segments/l2.ts` (task-103), which
 * consumes ONLY these functions; `HeadPack` itself owns no L2 state any more
 * (task-104 removed the dead `deps.fetchScenarios` / `loadL2()` class path —
 * the production assembly point never passed it, so it was a second, silent
 * source of truth). The last block pins that removal.
 *
 * Fixture: the real L3 persona content of this machine (2026-10-31,
 * team-2k12lgb650/agt-2m7buribzz/usr-2m7b1144d9) with its real 14-section
 * Scene Navigation tail — exactly what `/v3/core/read` returns.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/persona-sample.md', import.meta.url)), 'utf8');
/** Real narrative section: everything before the Scene Index heading. */
const NARRATIVE = FIXTURE.slice(0, FIXTURE.indexOf('## 🗺️ Scene Navigation (Scene Index)')).trimEnd();
const FIXTURE_PATHS = [...FIXTURE.matchAll(/^### Path: (.+)$/gm)].map((match) => match[1]);

/** Real endpoint shape: bare filename + summary + updated_at (2026-10-29). */
function entriesFromFixture(): L2SceneEntry[] {
  return FIXTURE_PATHS.map((path, index) => ({
    path: path.replace(/^scene_blocks\//, ""),
    summary: "场景 " + String(index + 1) + " 的核心要点摘要",
    updated: "2026-10-2" + String(9 - (index % 2)) + "T0" + String(index % 9) + ":00:00.000Z",
  }));
}

function lines(text: string): string[] {
  return text.split(String.fromCharCode(10));
}
describe('stripSceneNavigation', () => {
  it('removes the trailing Scene Navigation tail and keeps the narrative byte-for-byte', () => {
    const stripped = stripSceneNavigation(FIXTURE);
    expect(stripped).toBe(NARRATIVE);
    expect(stripped).not.toContain('Scene Navigation');
    expect(stripped).not.toContain('### Path:');
    expect(FIXTURE.length - stripped.length).toBeGreaterThan(1000);
  });

  it('keeps text that has no scene heading untouched (fail open, not fail empty)', () => {
    const text = '# 人格\n\n叙事内容。\n';
    expect(stripSceneNavigation(text)).toBe(text.trimEnd());
    expect(stripSceneNavigation('')).toBe('');
  });

  it('drops everything when the heading is the first line', () => {
    expect(stripSceneNavigation('## 场景索引\n### Path: x.md\n')).toBe('');
  });

  it('recognises the Chinese heading variants as well', () => {
    const head = '叙事。';
    expect(stripSceneNavigation(head + '\n\n#### 场景导航\n- a')).toBe(head);
    expect(stripSceneNavigation(head + '\n\n## Scene Index\n- a')).toBe(head);
  });
});

describe('formatL2Line', () => {
  it('renders path, update day and summary on one line', () => {
    expect(
      formatL2Line({ path: 'TDB-wiki建库-SSH源支持.md', summary: '要点。', updated: '2026-10-29T08:55:19.282Z' }),
    ).toBe('- scene_blocks/TDB-wiki建库-SSH源支持.md（更新 2026-10-29）— 要点。');
  });

  it('accepts a path that already carries the scene_blocks/ prefix (never doubles it)', () => {
    expect(formatL2Path('scene_blocks/a.md')).toBe('scene_blocks/a.md');
    expect(formatL2Path('/scene_blocks/a.md')).toBe('scene_blocks/a.md');
    expect(formatL2Path('a.md')).toBe('scene_blocks/a.md');
    expect(formatL2Path('  ')).toBe('');
  });

  it('omits the day and the summary when the endpoint sends none', () => {
    expect(formatL2Line({ path: 'a.md' })).toBe('- scene_blocks/a.md');
    expect(formatL2Line({ path: 'a.md', updated: '2026-10-29' })).toBe('- scene_blocks/a.md（更新 2026-10-29）');
    expect(formatL2Line({ path: 'a.md', summary: '  ' })).toBe('- scene_blocks/a.md');
    expect(formatL2Line({ path: 'a.md', updated: 'not-a-date' })).toBe('- scene_blocks/a.md');
  });

  it('flattens newlines in the summary so one scene stays one line', () => {
    const line = formatL2Line({ path: 'a.md', summary: '第一句。\n第二句。\t第三句。' });
    expect(line).toBe('- scene_blocks/a.md — 第一句。 第二句。 第三句。');
  });

  it('caps a long summary at 120 chars with an ellipsis', () => {
    const line = formatL2Line({ path: 'a.md', summary: 'x'.repeat(400) });
    const summary = line.split('— ')[1];
    expect(summary.length).toBe(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});
describe('renderL2Section', () => {
  it('sorts newest first, undated lines last, then by path', () => {
    const section = renderL2Section([
      { path: 'old.md', updated: '2026-10-20T00:00:00Z' },
      { path: 'undated.md' },
      { path: 'new.md', updated: '2026-10-29T00:00:00Z' },
      { path: 'b.md', updated: '2026-10-29T00:00:00Z' },
    ]);
    expect(section.kept.map((entry) => entry.path)).toEqual(['b.md', 'new.md', 'old.md', 'undated.md']);
    expect(section.text.startsWith(L2_SECTION_HEADER)).toBe(true);
    expect(section.dropped).toBe(0);
  });

  it('drops whole lines when the budget runs out (never half a line)', () => {
    const entries = entriesFromFixture();
    const budget = L2_SECTION_HEADER.length + 3 * 60;
    const section = renderL2Section(entries, { budget });
    expect(section.chars).toBeLessThanOrEqual(budget);
    expect(section.kept.length).toBeGreaterThan(0);
    expect(section.kept.length + section.dropped).toBe(entries.length);
    const lines = section.text.split('\n');
    expect(lines[0]).toBe(L2_SECTION_HEADER);
    for (const line of lines.slice(1)) expect(line.startsWith('- scene_blocks/')).toBe(true);
  });

  it('returns an empty section when not even the header fits', () => {
    const section = renderL2Section(entriesFromFixture(), { budget: 5 });
    expect(section.text).toBe('');
    expect(section.chars).toBe(0);
    expect(section.dropped).toBe(entriesFromFixture().length);
  });

  it('renders all 14 real scenes inside the default 3000-char budget', () => {
    const entries = entriesFromFixture();
    const section = renderL2Section(entries);
    expect(entries.length).toBe(14);
    expect(section.kept.length).toBe(14);
    expect(section.chars).toBeLessThanOrEqual(L2_MAX_CHARS);
    expect(section.text).toContain('- scene_blocks/TDB-L1记忆管道排查.md');
  });

  it('tolerates undefined / junk input', () => {
    expect(renderL2Section(undefined).text).toBe('');
    expect(renderL2Section([{ path: '' }, {} as L2SceneEntry]).text).toBe('');
  });
});

describe('l2StatusLabel', () => {
  it('reports ok / empty / truncated / fail with the reason', () => {
    const section = renderL2Section(entriesFromFixture());
    expect(l2StatusLabel({ ok: true, entries: entriesFromFixture() }, section)).toBe('l2=ok(14,' + String(section.chars) + ')');
    expect(l2StatusLabel({ ok: true, entries: [] }, renderL2Section([]))).toBe('l2=empty');
    expect(
      l2StatusLabel({ ok: true, entries: entriesFromFixture() }, renderL2Section(entriesFromFixture(), { budget: 5 })),
    ).toBe('l2=truncated(0,14)');
    expect(l2StatusLabel({ ok: false, reason: 'http_404' }, renderL2Section([]))).toBe('l2=fail:http_404');
    expect(l2StatusLabel(undefined, renderL2Section([]))).toBe('l2=fail:no_data');
  });

  it('flags a partially budget-dropped section', () => {
    const entries = entriesFromFixture();
    const section = renderL2Section(entries, { budget: L2_SECTION_HEADER.length + 80 });
    expect(section.dropped).toBeGreaterThan(0);
    expect(l2StatusLabel({ ok: true, entries }, section)).toContain('dropped=' + String(section.dropped));
  });
});

describe('classifyL2Failure', () => {
  it('keeps HTTP statuses, timeouts and payload errors distinguishable', () => {
    expect(classifyL2Failure(new Error('HTTP 404 Not Found'))).toBe('http_404');
    expect(classifyL2Failure(new Error('HTTP 503 upstream'))).toBe('http_503');
    expect(classifyL2Failure(new Error('request timeout after 5000ms'))).toBe('timeout');
    expect(classifyL2Failure(new Error('Unexpected token < in JSON at position 0'))).toBe('bad_payload');
    expect(classifyL2Failure(new Error('socket hang up'))).toBe('error');
    expect(classifyL2Failure(undefined)).toBe('error');
  });
});
describe('parseL2Outcome', () => {
  it('reads the endpoint envelope and keeps bare paths', () => {
    const outcome = parseL2Outcome({
      code: 0,
      data: { entries: [{ path: 'a.md', summary: 's', updated_at: '2026-10-29T00:00:00Z' }] },
    });
    expect(outcome).toEqual({ ok: true, entries: [{ path: 'a.md', summary: 's', updated: '2026-10-29T00:00:00Z' }] });
  });

  it('treats a non-array payload as a FAILURE, not as an empty index', () => {
    expect(parseL2Outcome({ data: {} })).toEqual({ ok: false, reason: 'bad_payload' });
    expect(parseL2Outcome(undefined)).toEqual({ ok: false, reason: 'bad_payload' });
    expect(parseL2Outcome({ data: { entries: [] } })).toEqual({ ok: true, entries: [] });
  });

  it('skips entries without a usable path', () => {
    const outcome = parseL2Outcome({ entries: [{ summary: 'no path' }, { path: '  ' }, { path: 'b.md' }] });
    expect(outcome.ok && outcome.entries.map((entry) => entry.path)).toEqual(['b.md']);
  });
});


/**
 * Composition the segment performs: strip the persona tail, render the
 * endpoint entries, append. These four cases are the migrated replacements for
 * the deleted `HeadPack.deps.fetchScenarios` wiring cases (task-104).
 */
describe('L2 section assembly (consumed by segments/l2.ts)', () => {
  it('renders 14 real scenes from stripped narrative + endpoint entries', () => {
    const narrative = stripSceneNavigation(FIXTURE);
    const section = renderL2Section(entriesFromFixture());
    const combined = narrative + String.fromCharCode(10, 10) + section.text;
    expect(narrative).toBe(NARRATIVE);
    expect(combined).not.toContain('Scene Navigation');
    expect(lines(combined).filter((line) => line.startsWith('- scene_blocks/')).length).toBe(14);
    expect(combined).toContain(L2_SECTION_HEADER);
    expect(l2StatusLabel({ ok: true, entries: entriesFromFixture() }, section)).toBe('l2=ok(14,' + String(section.chars) + ')');
  });

  it('a thrown endpoint error becomes a label and zero section chars', () => {
    let outcome: L2FetchOutcome;
    try {
      throw new Error('HTTP 404 Not Found');
    } catch (error) {
      outcome = { ok: false, reason: classifyL2Failure(error) };
    }
    const section = renderL2Section(outcome.ok ? outcome.entries : []);
    expect(l2StatusLabel(outcome, section)).toBe('l2=fail:http_404');
    expect(section.text).toBe('');
    expect(section.chars).toBe(0);
  });

  it('an empty index is l2=empty, not a failure, and adds no characters', () => {
    const section = renderL2Section([]);
    expect(l2StatusLabel({ ok: true, entries: [] }, section)).toBe('l2=empty');
    expect(section.text).toBe('');
  });

  it('honours the segment cap by dropping whole lines only', () => {
    const budget = 400;
    const section = renderL2Section(entriesFromFixture(), { budget });
    expect(section.chars).toBeLessThanOrEqual(budget);
    expect(section.kept.length).toBeGreaterThan(0);
    for (const line of lines(section.text).slice(1)) expect(line.startsWith('- scene_blocks/')).toBe(true);
  });
});

/**
 * Regression guard for the removal itself: HeadPack must stay a dumb renderer of
 * whatever `fetchHeadPack` returned. If L2 state ever sneaks back into the class,
 * there are two sources of truth again (persona tail + endpoint).
 */
describe('HeadPack owns no L2 state', () => {
  it('keeps the persona tail verbatim instead of stripping it', async () => {
    const pack = new HeadPack({
      fetchHeadPack: async () => FIXTURE,
      maxChars: 100_000,
      refreshMs: 60_000,
      fallbackText: '',
      now: () => 0,
    });
    await pack.refresh();
    expect(pack.current()).toContain('Scene Navigation');
    expect(pack.current()).not.toBe(NARRATIVE);
    expect(pack.current()).not.toContain(L2_SECTION_HEADER);
  });

  it('exposes no lastL2Status / fetchScenarios hook', () => {
    const pack = new HeadPack({
      fetchHeadPack: async () => 'HEAD-PACK',
      maxChars: 1000,
      refreshMs: 60_000,
      fallbackText: '',
    });
    const surface = pack as unknown as Record<string, unknown>;
    expect(surface.lastL2Status).toBeUndefined();
    expect('fetchScenarios' in surface).toBe(false);
  });
});
