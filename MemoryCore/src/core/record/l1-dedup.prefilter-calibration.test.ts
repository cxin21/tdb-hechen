/**
 * F4（2026-11-02）：dedup 前置门槛 minCos 的实测校准（本域分布，只读样本复测）。
 *
 * 病根：`DEFAULT_PREFILTER_MIN_COS = 0.9` 与本域 embedding 分布不符。2026-11-02 用生产
 * D:/TDB/data/vectors.db（3913 条 L1 向量，2048 维）只读复测：
 *   - 应合并对（10 组：取真实记录 + LLM 等义改写，topScore = 排除本批后的 top-1 cosine）
 *       min 0.8587 / max 0.9918 —— 0.9 门槛会把**最弱的那条真重复**拦在外面（9/10 放行）；
 *   - 无关对（10 组：域外生活文本 vs 全库）
 *       max 0.3630 —— 与真重复之间隔了 0.49；
 *   - 域内模板克隆硬负例（9 组合法样本）：0.5670 ~ 0.8568。
 *
 * 结论：绝对口径在本域有 0.36 ~ 0.86 的干净空窗，取 **0.82**（= lifecycle.consolidation
 * .attributeGrouping.minCos 同值）：真重复 10/10 全放行（下沿留 0.039 余量），无关对 10/10
 * 全拦下（上沿留 0.457 余量），域内硬负例 8/9 拦下。不采用 0.86+：那会开始丢掉真重复
 * （0.8587 那条），代价是把重复记忆重新入库。
 */
import { describe, expect, it } from "vitest";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { DEFAULT_PREFILTER_MIN_COS, prefilterCandidateMatches, resolvePrefilterMinCos } from "./l1-dedup.js";

/** 2026-11-02 只读复测：应合并对的 topScore（真实 cosine）。 */
const SHOULD_MERGE_TOP_SCORES = [0.8587, 0.9017, 0.9368, 0.9393, 0.9399, 0.9419, 0.9543, 0.9559, 0.9589, 0.9918];
/** 2026-11-02 只读复测：域外无关对的 topScore。 */
const UNRELATED_TOP_SCORES = [0.1938, 0.2392, 0.2429, 0.2582, 0.2607, 0.2754, 0.2924, 0.3006, 0.316, 0.363];
/** 2026-11-02 只读复测：域内模板克隆（同模板换实体）硬负例，最硬一条 0.8568。 */
const HARD_NEGATIVE_TOP_SCORES = [0.567, 0.5848, 0.6326, 0.6559, 0.6752, 0.682, 0.7307, 0.7978, 0.8568];

const match = (id: string, topScore: number) =>
  ({
    newMemory: { record_id: id },
    candidates: [{ id: `old-${id}` }],
    topScore,
  }) as unknown as CandidateMatch;

const classify = (scores: number[], minCos?: number) =>
  prefilterCandidateMatches(
    scores.map((s, i) => match(`n${i}`, s)),
    {
      enabled: true,
      ...(minCos === undefined ? {} : { minCos }),
    } as never,
  );

describe("F4 门槛缺省值 = 实测校准（0.82）", () => {
  it("DEFAULT_PREFILTER_MIN_COS = 0.82，且绝不退化成 0（禁止把门槛关掉）", () => {
    expect(DEFAULT_PREFILTER_MIN_COS).toBe(0.82);
    expect(DEFAULT_PREFILTER_MIN_COS).toBeGreaterThan(0);
    expect(resolvePrefilterMinCos(undefined)).toBe(0.82);
  });

  it("应合并对 10/10 全部放行进 LLM（0.9 时代最弱的 0.8587 会被误拦）", () => {
    const { kept, skipped } = classify(SHOULD_MERGE_TOP_SCORES);
    expect(kept).toHaveLength(10);
    expect(skipped).toHaveLength(0);

    // 反证：旧缺省 0.9 会拦掉真实重复（这条断言固定住"0.9 是错的"）
    const atOld = classify(SHOULD_MERGE_TOP_SCORES, 0.9);
    expect(atOld.skipped).toHaveLength(1);
    expect(atOld.skipped[0].topScore).toBe(0.8587);
  });

  it("无关对 10/10 全部拦下（不进 LLM）", () => {
    const { kept, skipped } = classify(UNRELATED_TOP_SCORES);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(10);
  });

  it("域内模板克隆硬负例：8/9 拦下；最硬一条 0.8568 放行（拦它要 ≥0.86 → 会丢真重复）", () => {
    const { kept, skipped } = classify(HARD_NEGATIVE_TOP_SCORES);
    expect(skipped).toHaveLength(8);
    expect(kept.map((m) => m.topScore)).toEqual([0.8568]);
  });

  it("门槛落在实测空窗内：高于最硬无关对、低于最弱真重复，两侧留足余量", () => {
    const maxUnrelated = Math.max(...UNRELATED_TOP_SCORES);
    const minPositive = Math.min(...SHOULD_MERGE_TOP_SCORES);
    expect(DEFAULT_PREFILTER_MIN_COS).toBeGreaterThan(maxUnrelated);
    expect(maxUnrelated).toBeLessThanOrEqual(0.363);
    expect(minPositive).toBeGreaterThanOrEqual(0.8587);
    // 真实 cosine 会随 provider/样本抖动，余量太小等于把判据压在噪声上
    expect(minPositive - DEFAULT_PREFILTER_MIN_COS).toBeGreaterThan(0.03);
    expect(DEFAULT_PREFILTER_MIN_COS - maxUnrelated).toBeGreaterThan(0.4);
  });
});
