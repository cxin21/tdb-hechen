import { describe, expect, it } from "vitest";
import {
  AXIS_ANCHORS,
  AXIS_LABELS,
  AXIS_VERSION,
  CARD_READER_NOTE,
  CARD_READER_NOTE_VERSION,
  SEED_LABELS,
  SOUL_AXES,
  TRAIT_LABEL_MERGE_SIM,
  TRAIT_LABEL_SHOW,
  TRAIT_L1_MAX,
  TRAIT_PROTOCOL_VERSION,
  TRAIT_TOP_N,
  activationOf,
  axisVectorToArray,
  clamp,
  cosine,
  emptyAxisVector,
  l1Norm,
  normalizeDirection,
  normalizeTraitL1,
  projectLabels,
  seedStateFromSeeds,
  toAxisVector,
  type AxisVector,
} from "../traits.js";
import { seedLabelRows } from "../trait-drift.js";

/** 判据 8 的副词集合（spec 正文列举 + 实际文案覆盖到的近义程度副词）。 */
const ADVERBS = /(总是|总|常常|常|几乎|很少|不太|不|没|宁可|容易|偏|先|越|只|快|往往|多半|极|太|更)/;
/** 判据 8 的禁词：工具/流程、祈使、评价。 */
const BANNED = ["重跑", "报数", "门禁", "SOP", "TDD", "测试", "提交", "PR", "接口", "字段", "配置", "请", "务必", "记得", "优秀", "靠谱", "专业"];
/** 元词：轴名、特质/权重/设定/算法（判据 8、12）。 */
const META_WORDS = [...SOUL_AXES, ...Object.values(AXIS_LABELS), "特质", "权重", "设定", "算法"];

describe("特质种子：卡里写性格，判侧写行为", () => {
  it("18 条种子、标签唯一、方向拦在六轴内", () => {
    expect(SEED_LABELS).toHaveLength(18);
    expect(new Set(SEED_LABELS.map((s) => s.label)).size).toBe(18);
    for (const seed of SEED_LABELS) {
      expect(Object.keys(seed.direction).sort()).toEqual([...SOUL_AXES].sort());
      const norm = Math.sqrt(SOUL_AXES.reduce((s, a) => s + seed.direction[a] ** 2, 0));
      expect(norm).toBeGreaterThan(0);
    }
  });

  it("gloss ≤40 字、含程度副词、0 禁词、0 轴名、0 元词", () => {
    for (const seed of SEED_LABELS) {
      expect(seed.gloss.length, `${seed.label} gloss 长度`).toBeLessThanOrEqual(40);
      expect(ADVERBS.test(seed.gloss), `${seed.label} gloss 缺副词：${seed.gloss}`).toBe(true);
      for (const word of BANNED) expect(seed.gloss, `${seed.label} 含禁词 ${word}`).not.toContain(word);
      for (const word of META_WORDS) expect(seed.gloss, `${seed.label} 含元词 ${word}`).not.toContain(word);
    }
  });

  it("anchor（判侧行为锚）绝不进 gloss（判据 8：卡里不出现行为清单语汇）", () => {
    for (const seed of SEED_LABELS) {
      // anchor 用「高：…；低：…」句式，gloss 不该复用其中任何一条行为动词短语
      expect(seed.anchor.length).toBeGreaterThan(0);
      expect(seed.gloss).not.toMatch(/^高：|；低：/);
    }
  });

  it("六轴各至少 3 条标签载荷 >0.6（判据 11，装饰轴必须可测出来）", () => {
    for (const axis of SOUL_AXES) {
      const loaded = SEED_LABELS.map((s) => normalizeDirection(s.direction))
        .filter((d) => Math.abs(d[axis]) > 0.6);
      expect(loaded.length, `轴 ${axis} 载荷 >0.6 的标签数`).toBeGreaterThanOrEqual(3);
    }
  });

  // S10 修订（2026-11-07）：出厂词表不是证据。没设过特质的租户不该在卡里宣告性格。
  // 生产实测：空 persona 仍渲染「倔 0.5 · 冷淡 0.5 · 体贴 0.5 · 务实 0.5 · 严谨 0.5」。
  it("seedLabelRows：只有表单选中的种子拿 evidence=3，其余为 0（空 persona 的底色为空）", () => {
    const zero = { warmth: 0, agency: 0, rigor: 0, openness: 0, stability: 0, boundary: 0 };
    const none = seedLabelRows(SEED_LABELS, "2026-11-07T06:36:03.350Z", { declared: [] });
    expect(none.every((r) => r.evidence === 0)).toBe(true);
    expect(projectLabels(zero, none.map((r) => ({ ...r, act: 0 })))).toHaveLength(0);

    const picked = seedLabelRows(SEED_LABELS, "2026-11-07T06:36:03.350Z", { declared: ["严谨", "好奇"] }).map((r) => ({ ...r, act: 0 }));
    expect(picked.filter((r) => r.evidence === 3).map((r) => r.label).sort()).toEqual(["严谨", "好奇"].sort());
    const shown = projectLabels(zero, picked).map((l) => l.label).sort();
    expect(shown).toEqual(["严谨", "好奇"].sort());
  });

  it("种子之间不存在余弦 > 0.85 的对（否则合并门会先把种子并掉）", () => {
    const dirs = SEED_LABELS.map((s) => normalizeDirection(s.direction));
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        expect(cosine(dirs[i], dirs[j]), `${SEED_LABELS[i].label}/${SEED_LABELS[j].label}`).toBeLessThanOrEqual(
          TRAIT_LABEL_MERGE_SIM,
        );
      }
    }
  });

  it("版本常量各自独立且为 v1", () => {
    expect(AXIS_VERSION).toBe("v1");
    expect(TRAIT_PROTOCOL_VERSION).toBe("v1");
    expect(CARD_READER_NOTE_VERSION).toBe("v1");
  });
});

describe("读侧常量与投影（判据 12：0 轴名、0 权重/算法/α/tanh）", () => {
  it("卡头读法不含轴名、不含权重/算法/tanh", () => {
    for (const word of [...SOUL_AXES, ...Object.values(AXIS_LABELS)]) {
      expect(CARD_READER_NOTE).not.toContain(word);
    }
    expect(CARD_READER_NOTE).not.toMatch(/权重|算法|α|tanh/);
  });

  it("卡内只看 top-5，激活度在 [0,1] 且有 1 位小数语义（四舍五入后稳定）", () => {
    const state = { warmth: 0.4, agency: -0.2, rigor: 0.8, openness: 0.1, stability: 0, boundary: -0.5 };
    for (const seed of SEED_LABELS) {
      const act = activationOf(state, normalizeDirection(seed.direction));
      expect(act).toBeGreaterThanOrEqual(0);
      expect(act).toBeLessThanOrEqual(1);
      expect(Number(act.toFixed(1))).toBeGreaterThanOrEqual(0);
    }
    expect(TRAIT_TOP_N).toBe(5);
  });

  it("projectLabels：evidence<3 与 act<0.5 不出，dormant 不出，按 act 降序", () => {
    const state = { warmth: 0.9, agency: 0, rigor: -0.9, openness: 0, stability: 0, boundary: 0 };
    const labels = [
      { label: "温和", direction: normalizeDirection({ warmth: 1 }), act: 1, evidence: 5, status: "active" },
      { label: "冷淡", direction: normalizeDirection({ warmth: -1 }), act: 0, evidence: 5, status: "active" },
      { label: "证据不足", direction: normalizeDirection({ warmth: 1 }), act: 1, evidence: 2, status: "active" },
      { label: "已休眠", direction: normalizeDirection({ warmth: 1 }), act: 1, evidence: 9, status: "dormant" },
      { label: "弱激活", direction: normalizeDirection({ warmth: -1 }), act: 0.05, evidence: 9, status: "active" },
    ];
    const shown = projectLabels(state, labels);
    expect(shown.map((l) => l.label)).toEqual(["温和"]);
    expect(shown[0].act).toBeGreaterThanOrEqual(TRAIT_LABEL_SHOW);
    expect(projectLabels(state, labels, { includeDormant: true }).some((l) => l.label === "已休眠")).toBe(true);
  });
});

describe("向量工具：定长、可夹、可测", () => {
  it("toAxisVector 兼容数组、对象、JSON 字符串，缺列补 0", () => {
    expect(axisVectorToArray(toAxisVector([1, 2, 3, 4, 5, 6]))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(axisVectorToArray(toAxisVector({ warmth: 0.5 }))).toEqual([0.5, 0, 0, 0, 0, 0]);
    expect(axisVectorToArray(toAxisVector('{"rigor":-0.7}'))).toEqual([0, 0, -0.7, 0, 0, 0]);
  });

  it("normalizeDirection 给单位向量；零向量保持零（不伪造方向）", () => {
    const d = normalizeDirection({ warmth: 3, rigor: 4 });
    expect(Math.sqrt(SOUL_AXES.reduce((s, a) => s + d[a] ** 2, 0))).toBeCloseTo(1, 6);
    expect(axisVectorToArray(normalizeDirection(emptyAxisVector()))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("seedStateFromSeeds = L1 归一的 clamp(Σ w·d)，未知标签忽略，权重 0 不参与（B2）", () => {
    const state = seedStateFromSeeds([
      { label: "严谨", weight: 1 },
      { label: "迷糊", weight: 0 },
      { label: "不存在的标签", weight: 1 },
    ]);
    const raw = normalizeDirection(SEED_LABELS[0].direction);
    expect(axisVectorToArray(state)).toEqual(axisVectorToArray(normalizeTraitL1(raw)));
    expect(l1Norm(state)).toBeLessThanOrEqual(TRAIT_L1_MAX);
    expect(clamp(9, -1, 1)).toBe(1);
  });

  it("normalizeTraitL1：超限等比缩到 0.5 保方向；零向量保持零；合规输入不动", () => {
    const over = { warmth: 0.5, agency: 0.3, rigor: 0.6, openness: 0.2, stability: 0.1, boundary: 0.4 };
    expect(l1Norm(over)).toBeCloseTo(2.1, 6);
    const fit = normalizeTraitL1(over);
    expect(l1Norm(fit)).toBeLessThanOrEqual(TRAIT_L1_MAX);
    expect(cosine(fit, over)).toBeCloseTo(1, 6);
    // 每轴同比例（不是截断），最小轴也不会被清零
    expect(fit.warmth / over.warmth).toBeCloseTo(TRAIT_L1_MAX / 2.1, 2);
    expect(fit.stability).toBeGreaterThan(0);
    // 幂等
    expect(axisVectorToArray(normalizeTraitL1(fit))).toEqual(axisVectorToArray(fit));
    // 零向量保持零（不伪造方向）
    expect(axisVectorToArray(normalizeTraitL1(emptyAxisVector()))).toEqual([0, 0, 0, 0, 0, 0]);
    // 合规输入原样返回
    const ok = { warmth: 0.1, rigor: 0.2 };
    expect(axisVectorToArray(normalizeTraitL1(ok))).toEqual([0.1, 0, 0.2, 0, 0, 0]);
  });

  it("多个重种子叠加也不越 L1（B2：种子不能绕过预算），方向保留", () => {
    const seeds = [
      { label: "严谨", weight: 1 },
      { label: "直接", weight: 1 },
      { label: "坦率", weight: 1 },
      { label: "果断", weight: 1 },
      { label: "务实", weight: 1 },
    ];
    const state = seedStateFromSeeds(seeds);
    expect(l1Norm(state)).toBeLessThanOrEqual(TRAIT_L1_MAX);
    const raw = emptyAxisVector();
    for (const seed of seeds) {
      const def = SEED_LABELS.find((s) => s.label === seed.label)!;
      const d = normalizeDirection(def.direction);
      for (const axis of SOUL_AXES) raw[axis] += d[axis];
    }
    // 旧实现直接 clamp 单轴；现在等价于 normalizeTraitL1(clamp(Σ))
    const expected = normalizeTraitL1(
      Object.fromEntries(SOUL_AXES.map((axis) => [axis, Math.max(-1, Math.min(1, raw[axis]))])) as AxisVector,
    );
    expect(axisVectorToArray(state)).toEqual(axisVectorToArray(expected));
    // 归一保方向：与「缩之前的合规向量」余弦 ≈ 1
    const clampedRaw = Object.fromEntries(
      SOUL_AXES.map((axis) => [axis, Math.max(-1, Math.min(1, raw[axis]))]),
    ) as AxisVector;
    expect(cosine(state, clampedRaw)).toBeCloseTo(1, 4);
  });

  it("AXIS_ANCHORS 六轴齐全（判侧用，读侧永不进卡）", () => {
    for (const axis of SOUL_AXES) {
      expect(AXIS_ANCHORS[axis].high.length).toBeGreaterThan(0);
      expect(AXIS_ANCHORS[axis].low.length).toBeGreaterThan(0);
    }
  });
});
