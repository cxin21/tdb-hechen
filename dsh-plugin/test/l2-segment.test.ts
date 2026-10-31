/**
 * Wire-level tests for the L2 scene-index segment (task-103).
 *
 * `renderL2Section` / `l2StatusLabel` / `parseL2Outcome` are tested where they
 * live (`test/head-pack.l2-segment.test.ts`). What is asserted here is only the
 * contract `src/index.ts` depends on: registration slot, the enable gate, the
 * configured budget, and that a failure costs zero characters plus a readable
 * four-state label — never a broken prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import { headPackSegmentSpecs, resetSegmentsForTests, runHeadPackSegments } from '../src/segments/index.js';
import {
  l2Budget,
  l2StatusForDebug,
  l2StatusSummary,
  resetL2StatusForTests,
} from '../src/segments/l2.js';

const config = (patch: Record<string, unknown> = {}) => normalizeConfig(patch).config;

const spec = () => headPackSegmentSpecs().find((row) => row.name === 'l2');

function deps(patch: Record<string, unknown> = {}, rich?: unknown) {
  const client = { listScenariosRich: rich ?? vi.fn(async () => ({ ok: true, entries: [] })) };
  return { client, config: config(patch), log: { debug: vi.fn(), warn: vi.fn() } } as any;
}

beforeEach(() => {
  resetSegmentsForTests();
  resetL2StatusForTests();
});

describe('the L2 segment slot', () => {
  it('registers after the persona with the renderer ceiling as its cap', () => {
    const l2 = spec();
    const persona = headPackSegmentSpecs().find((row) => row.name === 'persona');
    expect(l2).toBeDefined();
    expect(l2?.order).toBe(20);
    expect(persona?.order).toBe(10);
    expect(l2?.cap).toBe(3000);
    // The persona owns the remainder; a fixed cap on it would starve the L2 line.
    expect(persona?.cap).toBe('remainder');
  });

  it('is gated by both the head pack and the scene-index switch', () => {
    expect(spec()?.enabled?.(config())).toBe(true);
    expect(spec()?.enabled?.(config({ headPack: { includeScenarioIndex: false } }))).toBe(false);
    expect(spec()?.enabled?.(config({ headPack: { enabled: false } }))).toBe(false);
  });
});

describe('the L2 segment fetch', () => {
  it('renders one line per scene, anchored on - scene_blocks/', async () => {
    const rich = vi.fn(async () => ({
      ok: true,
      entries: [
        { path: 'deploy.md', summary: '部署流程', updated: '2026-10-29T08:00:00Z' },
        { path: 'review.md', summary: '评审偏好', updated: '2026-10-28T08:00:00Z' },
      ],
    }));
    const result = await spec()!.fetch(deps({}, rich) as any);

    expect(rich).toHaveBeenCalledTimes(1);
    expect(result?.chars).toBeGreaterThan(0);
    const lines = result!.text.split(String.fromCharCode(10));
    expect(lines[0]).toBe('## 长期记忆 · 场景索引（L2）');
    // scripts/verify-installed.mjs greps for this prefix: the anchor is a contract.
    expect(lines[1]).toBe('- scene_blocks/deploy.md（更新 2026-10-29）— 部署流程');
    expect(lines[2]).toBe('- scene_blocks/review.md（更新 2026-10-28）— 评审偏好');
    expect(result?.chars).toBe(result!.text.length);
    // The mount line and the compose debug line both read this label.
    expect(l2StatusForDebug()).toBe('l2=ok(2,' + result!.text.length + ')');
    expect(l2StatusSummary()).toBe('ok(2,' + result!.text.length + ')');
  });

  it('reports l2=empty without spending a character when the team has no scenes', async () => {
    const result = await spec()!.fetch(deps({}, vi.fn(async () => ({ ok: true, entries: [] }))) as any);

    expect(result).toMatchObject({ text: '', chars: 0 });
    expect(result?.failed).toBeFalsy();
    expect(l2StatusForDebug()).toBe('l2=empty');
  });

  it('fails open with the HTTP reason instead of an empty index', async () => {
    const d = deps({}, vi.fn(async () => ({ ok: false, reason: 'http_404' }) as any));
    const result = await spec()!.fetch(d as any);

    expect(result).toMatchObject({ text: '', chars: 0, failed: true });
    expect(l2StatusForDebug()).toBe('l2=fail:http_404');
    // The reason is logged once; the prompt only pays zero characters.
    expect(d.log.debug).toHaveBeenCalledWith(
      'agemem: l2 segment failed',
      expect.objectContaining({ l2: 'l2=fail:http_404', reason: 'http_404' }),
    );
  });

  it('classifies a thrown timeout and a missing client method', async () => {
    const thrown = await spec()!.fetch(deps({}, vi.fn(async () => { throw new Error('request timed out'); })) as any);
    expect(thrown).toMatchObject({ text: '', chars: 0, failed: true });
    expect(l2StatusForDebug()).toBe('l2=fail:timeout');

    // An older client (or a test fake) without the rich read is a failure, not a
    // silent 'no scenes'.
    const legacy = { client: {}, config: config(), log: { debug: vi.fn() } } as any;
    const missing = await spec()!.fetch(legacy);
    expect(missing).toMatchObject({ text: '', chars: 0, failed: true });
    expect(l2StatusForDebug()).toBe('l2=fail:no_client');
  });

  it('drops whole lines rather than slicing one when the budget is tight', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      path: 'scene-' + i + '.md',
      summary: '一句很长很长的场景摘要'.repeat(4),
      updated: '2026-10-2' + i + 'T00:00:00Z',
    }));
    const result = await spec()!.fetch(deps({ headPack: { l2Chars: 400 } }, vi.fn(async () => ({ ok: true, entries }))) as any);

    expect(result!.chars).toBeLessThanOrEqual(400);
    const lines = result!.text.split(String.fromCharCode(10));
    // Every kept line is a complete one — no half summary, no missing paren.
    for (const line of lines.slice(1)) expect(line).toMatch(/^- scene_blocks\/scene-\d+\.md（更新 \d{4}-\d{2}-\d{2}）— .+$/);
    expect(lines.length - 1).toBeLessThan(entries.length);
    expect(l2StatusSummary()).toMatch(/^ok\(\d+,\d+\) dropped=\d+$/);
  });
});

describe('the L2 budget', () => {
  it('defaults to 3000 and clamps to the renderer ceiling', () => {
    expect(l2Budget(config())).toBe(3000);
    expect(l2Budget(config({ headPack: { l2Chars: 1200 } }))).toBe(1200);
    // Normalisation already clips this to 3000; the segment clips again so a
    // hand-built config object cannot ask for more than the cap it registers.
    expect(l2Budget(config({ headPack: { l2Chars: 9000 } }))).toBe(3000);
    expect(l2Budget({ ...config(), headPack: { ...config().headPack, l2Chars: Number.NaN } })).toBe(3000);
  });

  it('renders nothing when the budget is zero, and says so', async () => {
    const entries = [{ path: 'deploy.md', summary: '部署流程', updated: '2026-10-29' }];
    const result = await spec()!.fetch(deps({ headPack: { l2Chars: 0 } }, vi.fn(async () => ({ ok: true, entries }))) as any);

    expect(result).toMatchObject({ text: '', chars: 0 });
    expect(result?.failed).toBeFalsy();
    expect(l2StatusForDebug()).toBe('l2=truncated(0,1)');
  });
});

describe('the L2 segment inside the head-pack runner', () => {
  it('contributes to the composed pack without stealing the persona remainder', async () => {
    const rich = vi.fn(async () => ({ ok: true, entries: [{ path: 'deploy.md', summary: '部署流程', updated: '2026-10-29' }] }));
    const d = deps({}, rich) as any;
    d.client.readCore = vi.fn(async () => ({ content: '# Persona' + String.fromCharCode(10) + '- 用户偏好简洁回答。' }));
    const { text, segments } = await runHeadPackSegments(d, 20000);

    expect(text).toContain('# Persona');
    expect(text).toContain('- scene_blocks/deploy.md（更新 2026-10-29）— 部署流程');
    const l2 = segments.find((row: any) => row.name === 'l2');
    expect(l2?.status).toBe('ok');
  });
});