import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HeadPack, compressHeadPack, isCompressedHeadPack, structureHeadPack } from '../src/head-pack.js';

/**
 * Fixture: the real L3 persona content of this machine (2026-10-31,
 * team-2k12lgb650/agt-2m7buribzz/usr-2m7b1144d9), trimmed for repo size —
 * narrative part byte-for-byte, the 14 Scene Index sections keep their real
 * path / 热度 / 更新 values while each Summary body is cut to its first clause.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/persona-sample.md', import.meta.url)), 'utf8');
/** Real narrative section of the fixture (everything before the Scene Index). */
const FIXTURE_NARRATIVE = FIXTURE.slice(0, FIXTURE.indexOf('## 🗺️ Scene Navigation (Scene Index)')).trimEnd();
const FIXTURE_PATHS = [...FIXTURE.matchAll(/^### Path: (.+)$/gm)].map((match) => match[1]);

function makePack(fetchHeadPack: () => Promise<string | undefined>, overrides?: { maxChars?: number; refreshMs?: number; fallbackText?: string }) {
  let clock = 0;
  const pack = new HeadPack({
    fetchHeadPack,
    maxChars: overrides?.maxChars ?? 1000,
    refreshMs: overrides?.refreshMs ?? 60_000,
    fallbackText: overrides?.fallbackText ?? '',
    now: () => clock,
  });
  return { pack, advance: (ms: number) => { clock += ms; } };
}

describe('head pack', () => {
  it('returns the fallback before the first fetch and never throws', () => {
    const { pack } = makePack(async () => 'HEAD', { fallbackText: 'fallback' });
    expect(pack.peek()).toBe('');
    expect(pack.current()).toBe('fallback');
  });

  it('serves the fetched text and freezes it until the refresh window passes', async () => {
    const fetchHeadPack = vi.fn(async () => 'HEAD-PACK');
    const { pack, advance } = makePack(fetchHeadPack, { refreshMs: 1000 });
    pack.current();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(pack.peek()).toBe('HEAD-PACK'));
    expect(pack.current()).toBe('HEAD-PACK');

    advance(500);
    pack.current();
    expect(fetchHeadPack).toHaveBeenCalledTimes(1);

    advance(600);
    pack.current();
    expect(fetchHeadPack).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent refreshes', async () => {
    let resolveFetch: (value: string) => void = () => {};
    const fetchHeadPack = vi.fn(() => new Promise<string | undefined>((resolve) => { resolveFetch = resolve; }));
    const { pack } = makePack(fetchHeadPack, { refreshMs: 1000 });
    const one = pack.refresh();
    const two = pack.refresh();
    expect(fetchHeadPack).toHaveBeenCalledTimes(1);
    resolveFetch('once');
    await Promise.all([one, two]);
    expect(pack.peek()).toBe('once');
  });

  it('keeps the previous text when a refresh fails', async () => {
    let fail = false;
    const fetchHeadPack = vi.fn(async () => {
      if (fail) throw new Error('core down');
      return 'stable';
    });
    const { pack } = makePack(fetchHeadPack, { refreshMs: 1000 });
    await pack.refresh();
    expect(pack.peek()).toBe('stable');
    fail = true;
    await pack.refresh();
    expect(pack.peek()).toBe('stable');
  });

  it('refetches after invalidate()', async () => {
    const fetchHeadPack = vi.fn(async () => 'v' + fetchHeadPack.mock.calls.length);
    const { pack } = makePack(fetchHeadPack, { refreshMs: 60_000 });
    await pack.refresh();
    expect(pack.peek()).toBe('v1');
    pack.invalidate();
    expect(pack.shouldRefresh()).toBe(true);
    await pack.refresh();
    expect(pack.peek()).toBe('v2');
  });

  it('clamps oversized text with a visible marker', async () => {
    const { pack } = makePack(async () => 'x'.repeat(50), { maxChars: 10 });
    await pack.refresh();
    expect(pack.current()).toContain('[agemem head pack truncated at 10 chars]');
  });
});

describe('head pack structuring (narrative verbatim + one line per L2 scene)', () => {
  /** Fetch the fixture through a pack with room to spare, so no clamp interferes. */
  async function loadFixture(maxChars = 20_000) {
    const { pack } = makePack(async () => FIXTURE, { maxChars });
    await pack.refresh();
    return pack;
  }

  it('keeps the narrative part verbatim and still names every chapter', async () => {
    const pack = await loadFixture();
    const text = pack.current();
    expect(text.startsWith(FIXTURE_NARRATIVE)).toBe(true);
    for (const heading of [
      '# User Narrative Profile',
      '## 📖 Chapter 1: Context & Current State (全景语境)',
      '## 🎨 Chapter 2: The Texture of Life (生活的肌理)',
      '## 🤖 Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)',
      '## 🧩 Chapter 4: Deep Insights & Evolution (深层洞察与演变)',
    ]) {
      expect(text).toContain(heading);
    }
    // The compressed tail is appended after the narrative, it never rewrites it.
    expect(text.slice(0, FIXTURE_NARRATIVE.length)).toBe(FIXTURE_NARRATIVE);
  });

  it('collapses the Scene Index to 14 lines with path + 热度 + 日期 and drops Summary bodies', async () => {
    const pack = await loadFixture();
    const text = pack.current();
    const sceneLines = text.split('\n').filter((line) => line.startsWith('- scene_blocks/'));
    expect(sceneLines).toHaveLength(14);
    expect(FIXTURE_PATHS).toHaveLength(14);
    for (const path of FIXTURE_PATHS) {
      const line = sceneLines.find((candidate) => candidate.includes(path));
      expect(line, 'scene line for ' + path).toBeDefined();
      expect(line).toMatch(/（热度 \d+，更新 \d{4}-\d{2}-\d{2}）$/);
    }
    // 14 real paths survive; the ~70% Summary bulk does not.
    expect(text).toContain('## 🗺️ Scene Navigation (Scene Index)');
    expect(text).not.toContain('Summary:');
    expect(text).not.toContain('[agemem head pack truncated');
    expect(text.length).toBeLessThan(FIXTURE.length);
    expect(text.length).toBeLessThan(5000);
  });

  it('reports the measured compression, and the documented 8000-char default holds it', async () => {
    const pack = await loadFixture(8000);
    const text = pack.current();
    expect(text.length).toBeLessThan(8000);
    expect(text.split('\n').filter((line) => line.startsWith('- scene_blocks/'))).toHaveLength(14);
  });

  it('fails open (bare truncation, no throw) when the structure is unknown', async () => {
    const { pack } = makePack(async () => FIXTURE_NARRATIVE, { maxChars: 20_000 });
    await pack.refresh();
    expect(pack.current()).toBe(FIXTURE_NARRATIVE);
    expect(structureHeadPack(FIXTURE_NARRATIVE)).toBeUndefined();

    // Heading missing ⇒ no structuring.
    expect(structureHeadPack('# User Narrative Profile\n\nno index here')).toBeUndefined();
    // Heading present but no scene lines.
    expect(structureHeadPack('# X\n\n## 🗺️ Scene Navigation (Scene Index)\n\n*(empty)*')).toBeUndefined();
    // One section lost its 热度 ⇒ refuse to publish a partial index.
    const damagedHeat = FIXTURE.replace('**热度**: 356', '**热度**: n/a');
    expect(structureHeadPack(damagedHeat)).toBeUndefined();
    const damagedDate = FIXTURE.replace(/\*\*更新\*\*: \d{4}-\d{2}-\d{2}/g, '**更新**: 昨天');
    expect(structureHeadPack(damagedDate)).toBeUndefined();
  });

  it('fails open when an earlier layer already truncated the pack', async () => {
    // composeHeadPack (index.ts) clamps the persona before HeadPack sees it; the
    // marker means the shape can no longer be trusted.
    const preTruncated = FIXTURE.slice(0, 4000) + '\n[agemem head pack truncated at 4000 chars]';
    const { pack } = makePack(async () => preTruncated, { maxChars: 20_000 });
    await pack.refresh();
    expect(pack.current()).toBe(preTruncated);
    expect(structureHeadPack(preTruncated)).toBeUndefined();
  });

  it('is idempotent: compressing an already-compressed pack changes nothing', async () => {
    const once = compressHeadPack(FIXTURE);
    expect(compressHeadPack(once)).toBe(once);
    expect(structureHeadPack(once)).toBeUndefined();
  });

  it('still emits a legal string plus the truncation marker when maxChars is tiny', async () => {
    for (const maxChars of [0, 1, 10, 1000, 4000]) {
      const pack = await loadFixture(maxChars);
      const text = pack.current();
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('[agemem head pack truncated at ' + maxChars + ' chars]');
      // The marker is the last line: never a half-written markdown tail without explanation.
      expect(text.endsWith(']')).toBe(true);
      if (maxChars > 0) expect(text.startsWith('[agemem head pack truncated')).toBe(false);
    }
  });

  it('keeps path/热度/日期 even when the narrative alone is under the cap', async () => {
    // 3766 narrative + 14 lines ≈ 4565; a 5000 cap must keep both, verbatim.
    const pack = await loadFixture(5000);
    const text = pack.current();
    expect(text).not.toContain('[agemem head pack truncated');
    expect(text.split('\n').filter((line) => line.startsWith('- scene_blocks/'))).toHaveLength(14);
  });

  it('treats an already compressed pack as the normal shape, not a parse failure', async () => {
    // Production feeds HeadPack the output of compressHeadPack (index.ts budgets
    // after compressing), so the second structure pass ALWAYS fails there. The
    // live e2e showed the old unconditional debug line on every mount, which read
    // as a real bug; the compressed shape must be recognised instead.
    const compressed = compressHeadPack(FIXTURE);
    expect(structureHeadPack(compressed)).toBeUndefined();
    expect(isCompressedHeadPack(compressed)).toBe(true);

    const warn = vi.fn();
    const pack = new HeadPack({
      // composeHeadPack appends its L2 section after the compressed persona; the
      // shape is still 'already compressed'.
      fetchHeadPack: async () => compressed + '\n\n## 长期记忆 · 场景索引（L2）\n- scenes/deploy.md',
      maxChars: 8000,
      refreshMs: 60_000,
      fallbackText: '',
      log: { warn, debug: vi.fn() },
      now: () => 0,
    });
    await pack.refresh();
    expect(warn).not.toHaveBeenCalled();
    expect(pack.current()).toContain('Scene Navigation');
  });

  it('warns once, with the raw shape, when the upstream structure really changed', async () => {
    // A damaged index (one section lost its 热度) is a GENUINE fail-open: the
    // operator has to see it, with enough context to tell what the core returned.
    const damaged = FIXTURE.replace('**热度**: 356', '**热度**: n/a');
    const warn = vi.fn();
    let clock = 0;
    let fetched = 0;
    const pack = new HeadPack({
      fetchHeadPack: async () => {
        fetched += 1;
        return damaged;
      },
      maxChars: 20_000,
      refreshMs: 1000,
      fallbackText: '',
      log: { warn, debug: vi.fn() },
      now: () => clock,
    });
    await pack.refresh();
    expect(pack.current()).toBe(damaged);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('no parseable scene index');
    expect(message).toContain('bare truncation');
    expect(context.rawChars).toBe(damaged.length);
    expect(String(context.firstLine)).toBe('# User Narrative Profile');
    expect(String(context.firstLine).length).toBeLessThanOrEqual(60);
    expect(context.hasHeading).toBe(true);

    // A second refresh keeps the log quiet: one diagnostic per mount.
    clock += 5000;
    await pack.refresh();
    expect(fetched).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
