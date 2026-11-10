/**
 * 人格设定表单纯逻辑测试（web 侧可测部分，spec §1/§5）。
 *
 * 覆盖：
 *   ① 归一预览：按比例缩到 Σ=1、全 0 退均分、空数组；
 *   ② 红线即时提示：行数 / 单行字数 / 总字数三条上限；
 *   ③ 提交前校验：名称空 / 名称超 20 / 形象超 200 / 特质超 5 / 值越界 / 红线提示透传；
 *   ④ 提交体：空项转 undefined（不写空串）、红线按行拆成 active 项；
 *   ⑤ 读回解析：traits_json / redlines_json 为 JSON 字符串也能吃、未设定返回 null；
 *   ⑥ 空表单判定（创建时未填任何一项 → 不生成人设行）。
 *
 * 口径来源：MemoryCore/src/core/soul/traits.ts 与 agent-profile.ts:109-148（本文件只做镜像）。
 */
import { describe, it, expect } from 'vitest';
import {
  PERSONA_LIMITS,
  SEED_TRAIT_LABELS,
  buildPersonaSaveBody,
  draftFromPersona,
  emptyPersonaDraft,
  isPersonaDraftEmpty,
  parseAgentPersona,
  previewSeedWeights,
  redlineHints,
  retiredRedlinesOf,
  splitRedlineLines,
  validatePersonaDraft,
  type AgentPersonaDraft,
} from '@/lib/agent-persona-form';

function draft(patch: Partial<AgentPersonaDraft> = {}): AgentPersonaDraft {
  return { ...emptyPersonaDraft(), ...patch };
}

describe('previewSeedWeights', () => {
  it('按比例缩到 Σ=1（两位小数）', () => {
    const out = previewSeedWeights([
      { label: '严谨', weight: 0.6 },
      { label: '迷糊', weight: 0.2 },
      { label: '好奇', weight: 0.2 },
    ]);
    expect(out.map((o) => o.label)).toEqual(['严谨', '迷糊', '好奇']);
    expect(out.map((o) => o.weight)).toEqual([0.6, 0.2, 0.2]);
    expect(out.reduce((s, o) => s + o.weight, 0)).toBeCloseTo(1, 5);
  });

  it('全 0 时退均分（与内核同口径）', () => {
    const out = previewSeedWeights([
      { label: '严谨', weight: 0 },
      { label: '迷糊', weight: 0 },
    ]);
    expect(out.map((o) => o.weight)).toEqual([0.5, 0.5]);
  });

  it('空数组 → 空（不凭空造标签）', () => {
    expect(previewSeedWeights([])).toEqual([]);
  });
});

describe('红线即时提示', () => {
  it('三条上限各自触发，且文案是中文', () => {
    const tooManyRows = Array.from({ length: PERSONA_LIMITS.redlineMaxRows + 1 }, () => '一条').join('\n');
    expect(redlineHints(tooManyRows)).toEqual(['红线最多 30 行（当前 31 行）']);

    const longLine = '字'.repeat(PERSONA_LIMITS.redlineLineMaxChars + 1);
    expect(redlineHints(longLine)).toEqual(['第 1 行超过 120 字（当前 121 字）']);
  });

  it('总字数超上限单独报（不误报成行数）', () => {
    const line = '字'.repeat(PERSONA_LIMITS.redlineLineMaxChars);
    const rows = Array.from({ length: PERSONA_LIMITS.redlineMaxRows }, () => line);
    const hints = redlineHints(rows.join('\n'));
    expect(hints.some((h) => h.includes('红线总字数超过 2600'))).toBe(true);
    expect(hints.some((h) => h.includes('红线最多 30 行'))).toBe(false);
  });

  it('空行不计入行数与总字数', () => {
    expect(redlineHints('\n\n一条\n\n')).toEqual([]);
    expect(splitRedlineLines('\n 一条 \n\n 两条\n')).toEqual(['一条', '两条']);
  });
});

describe('validatePersonaDraft', () => {
  it('空表单（有名称）不报错', () => {
    expect(validatePersonaDraft('小艾', emptyPersonaDraft())).toEqual([]);
  });

  it('名称空 / 超 20 字各报一条中文', () => {
    expect(validatePersonaDraft('   ', emptyPersonaDraft())).toContain('名称不能为空');
    expect(validatePersonaDraft('名'.repeat(21), emptyPersonaDraft())).toContain(
      '名称超过 20 字（当前 21 字）',
    );
  });

  it('形象 / 说话方式 / 使命各自上限', () => {
    expect(validatePersonaDraft('小艾', draft({ selfImage: '字'.repeat(201) }))).toContain(
      '形象超过 200 字（当前 201 字）',
    );
    expect(validatePersonaDraft('小艾', draft({ voice: '字'.repeat(401) }))).toContain(
      '说话方式超过 400 字（当前 401 字）',
    );
    expect(validatePersonaDraft('小艾', draft({ purpose: '字'.repeat(61) }))).toContain(
      '使命超过 60 字（当前 61 字）',
    );
  });

  it('特质最多 5 个；值必须在 0 到 1 之间', () => {
    const six = SEED_TRAIT_LABELS.slice(0, 6).map((label) => ({ label, weight: 0.5 }));
    expect(validatePersonaDraft('小艾', draft({ traits: six }))).toContain(
      '特质最多 5 个（当前 6 个）',
    );
    expect(
      validatePersonaDraft('小艾', draft({ traits: [{ label: '严谨', weight: 1.4 }] })),
    ).toContain('特质「严谨」的值必须在 0 到 1 之间');
  });

  it('红线提示会透传进错误列表', () => {
    const longLine = '字'.repeat(121);
    expect(validatePersonaDraft('小艾', draft({ redlinesText: longLine }))).toContain(
      '第 1 行超过 120 字（当前 121 字）',
    );
  });
});

describe('buildPersonaSaveBody', () => {
  it('空项转 undefined（不写空串），红线按行拆成 active 项', () => {
    const body = buildPersonaSaveBody('agt-1', ' 小艾 ', {
      selfImage: '  一个把话说明白的人。 ',
      voice: '   ',
      purpose: '',
      traits: [{ label: '严谨', weight: 0.7 }],
      redlinesText: '不替用户做决定\n\n不编造没验过的结论\n',
    });
    expect(body).toEqual({
      agent_id: 'agt-1',
      name: '小艾',
      self_image: '一个把话说明白的人。',
      voice: undefined,
      purpose: undefined,
      traits: [{ label: '严谨', weight: 0.7 }],
      redlines: [
        { text: '不替用户做决定', active: true },
        { text: '不编造没验过的结论', active: true },
      ],
    });
  });
});

describe('读回解析与空表单判定', () => {
  it('traits_json / redlines_json 是 JSON 字符串也能吃', () => {
    const record = parseAgentPersona({
      agent_id: 'agt-1',
      name: '小艾',
      self_image: '把话说明白。',
      traits_json: JSON.stringify([{ label: '严谨', weight: 0.7 }]),
      redlines_json: JSON.stringify([
        { text: '不替用户做决定', active: true, createdAt: '2026-11-01T00:00:00.000Z' },
        { text: '旧红线', active: false },
      ]),
      updated_at: '2026-11-07T00:00:00.000Z',
    });
    expect(record?.traits).toEqual([{ label: '严谨', weight: 0.7 }]);
    expect(record?.redlines.filter((r) => r.active).map((r) => r.text)).toEqual([
      '不替用户做决定',
    ]);
    expect(retiredRedlinesOf(record).map((r) => r.text)).toEqual(['旧红线']);
    expect(draftFromPersona(record).redlinesText).toBe('不替用户做决定');
  });

  it('未设定（null）→ 空表单起步，不预填名字/形象', () => {
    expect(parseAgentPersona(null)).toBeNull();
    const start = draftFromPersona(null);
    expect(start).toEqual(emptyPersonaDraft());
    expect(retiredRedlinesOf(null)).toEqual([]);
  });

  it('空表单判定：未填任何一项才算空', () => {
    expect(isPersonaDraftEmpty(emptyPersonaDraft())).toBe(true);
    expect(isPersonaDraftEmpty(draft({ voice: '说话短。' }))).toBe(false);
    expect(isPersonaDraftEmpty(draft({ traits: [{ label: '严谨', weight: 0.5 }] }))).toBe(false);
    expect(isPersonaDraftEmpty(draft({ redlinesText: '\n\n' }))).toBe(true);
  });
});
