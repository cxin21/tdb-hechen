/**
 * #179 S2 · selectL2Conclusions 接同一个层尺（layerRulerSelect）——纯接线合同。
 *
 * 契约（issue #179 S2 + 拍板 D1/D4）：
 *   1. 不传 layerRuler（mode:off）= 今天行为逐位一致（先取前 limit 名存活候选，再按
 *      层→idf→调用方序稳定排序）；
 *   2. 传 layerRuler（mode:shadow|enforce）= 存活候选喂 layerRulerSelect 同一份实现：
 *      layer=candidate.source、score=idf 分（off 时全 0）、order=候选序、budget=limit，
 *      层内按名次切 keepRatio、每层至少 minPerLayer 条、层间不竞争；
 *   3. 详细版额外返回候选池级明细（kept/droppedBy）供 journal 观测面使用；mode:off
 *      的明细不带 droppedBy（观测面记 0，不把历史行为伪装成尺子裁掉）。
 */
import { describe, expect, it } from "vitest";
import {
  selectL2Conclusions,
  selectL2ConclusionsDetailed,
  type L2ConclusionCandidate,
  type L2MatchInputs,
} from "../recall-layered.js";

function cand(over: Partial<L2ConclusionCandidate> & { content: string }): L2ConclusionCandidate {
  return { sceneName: "", source: "work_fact", ...over };
}

const Q = "缓存对账";
const TOKENS = ["缓存", "对账"];
const OFF: L2MatchInputs = { ftsTokens: TOKENS };
const RULER_ON: L2MatchInputs = { ftsTokens: TOKENS, layerRuler: { keepRatio: 0.67, minPerLayer: 1 } };

describe("#179 S2 selectL2Conclusions 缺省（mode:off）逐位一致", () => {
  it("selected 与旧签名输出逐位相同，池明细无 droppedBy", () => {
    const cands = [
      cand({ content: "缓存对账结论一" }),
      cand({ content: "缓存对账结论二" }),
      cand({ content: "无关内容" }),
      cand({ content: "对账缓存结论三", source: "scene_block" }),
    ];
    const legacy = selectL2Conclusions(Q, cands, OFF, 2);
    const detailed = selectL2ConclusionsDetailed(Q, cands, OFF, 2);
    expect(detailed.selected).toEqual(legacy);
    expect(detailed.selected).toHaveLength(2);
    // 池 = 存活候选（命中且非重复），共 3 条；kept 恰好等于被选中的 2 条
    expect(detailed.pool).toHaveLength(3);
    expect(detailed.pool.filter((e) => e.kept)).toHaveLength(2);
    // 观测面：off 下不允许出现任何 droppedBy 归因（口径：off 记 0）
    expect(detailed.pool.every((e) => e.reason === undefined)).toBe(true);
  });

  it("空 query / 空候选 / limit<=0 的早返行为不变", () => {
    const c = [cand({ content: "缓存对账" })];
    expect(selectL2ConclusionsDetailed("", c, OFF, 3)).toEqual({ selected: [], pool: [] });
    expect(selectL2ConclusionsDetailed(Q, [], OFF, 3)).toEqual({ selected: [], pool: [] });
    expect(selectL2ConclusionsDetailed(Q, c, OFF, 0)).toEqual({ selected: [], pool: [] });
  });
});

describe("#179 S2 selectL2Conclusions 接尺（layerRuler 提供时）", () => {
  it("层内按名次切 keepRatio：4 条同层命中留 2 条，其余归因 rank", () => {
    const cands = ["结论一", "结论二", "结论三", "结论四"].map((t) => cand({ content: `缓存对账${t}` }));
    const { selected, pool } = selectL2ConclusionsDetailed(
      Q,
      cands,
      { ...RULER_ON, layerRuler: { keepRatio: 0.5, minPerLayer: 1 } },
      8,
    );
    expect(selected.map((c) => c.content)).toEqual(["缓存对账结论一", "缓存对账结论二"]);
    expect(pool).toHaveLength(4);
    expect(pool.filter((e) => e.kept)).toHaveLength(2);
    expect(pool.filter((e) => e.reason === "rank")).toHaveLength(2);
  });

  it("层间不竞争：work_fact 与 scene_block 各按自己层内比例切，不互抢", () => {
    const cands = [
      cand({ content: "缓存对账A1" }),
      cand({ content: "缓存对账A2" }),
      cand({ content: "缓存对账A3" }),
      cand({ content: "缓存对账A4" }),
      cand({ content: "缓存对账B1", source: "scene_block" }),
      cand({ content: "缓存对账B2", source: "scene_block" }),
      cand({ content: "缓存对账B3", source: "scene_block" }),
      cand({ content: "缓存对账B4", source: "scene_block" }),
    ];
    const { selected, pool } = selectL2ConclusionsDetailed(
      Q,
      cands,
      { ...RULER_ON, layerRuler: { keepRatio: 0.5, minPerLayer: 1 } },
      8,
    );
    expect(selected.map((c) => c.content)).toEqual(["缓存对账A1", "缓存对账A2", "缓存对账B1", "缓存对账B2"]);
    expect(pool.filter((e) => e.reason === "rank")).toHaveLength(4);
  });

  it("limit 作为总预算：ratio=1 全留但超预算，按分数低者裁掉并归因 budget", () => {
    const cands = ["结论一", "结论二", "结论三", "结论四"].map((t) => cand({ content: `缓存对账${t}` }));
    const { selected, pool } = selectL2ConclusionsDetailed(
      Q,
      cands,
      { ...RULER_ON, layerRuler: { keepRatio: 1, minPerLayer: 1 } },
      3,
    );
    expect(selected).toHaveLength(3);
    expect(pool.filter((e) => e.reason === "budget")).toHaveLength(1);
    // 全 0 分时预算按 order 降序裁尾 ⇒ 被裁的是最后一条
    expect(pool.find((e) => e.reason === "budget")?.text).toBe("缓存对账结论四");
  });

  it("命中/去重/密度门与 off 路径共用同一份存活判定（尺子只在存活池上工作）", () => {
    const cands = [
      cand({ content: "缓存对账结论一" }),
      cand({ content: "无关内容" }),
      cand({ content: "缓存对账结论一" }),
      cand({ content: "缓存对账结论二" }),
    ];
    const { pool } = selectL2ConclusionsDetailed(Q, cands, RULER_ON, 8);
    expect(pool.map((e) => e.text)).toEqual(["缓存对账结论一", "缓存对账结论二"]);
  });

  it("minPerLayer 保底：ratio 0 时每层仍留 1 条，层全空不补位", () => {
    const cands = [cand({ content: "缓存对账A" }), cand({ content: "缓存对账B", source: "scene_block" })];
    const { selected } = selectL2ConclusionsDetailed(
      Q,
      cands,
      { ...RULER_ON, layerRuler: { keepRatio: 0, minPerLayer: 1 } },
      8,
    );
    expect(selected.map((c) => c.content)).toEqual(["缓存对账A", "缓存对账B"]);
  });

  it("池明细带 layer/hash 无关的最小面：text/layer/score/order/kept", () => {
    const cands = [cand({ content: "缓存对账A" })];
    const { pool } = selectL2ConclusionsDetailed(Q, cands, RULER_ON, 8);
    expect(pool[0]).toEqual({ text: "缓存对账A", layer: "work_fact", score: 0, order: 0, kept: true });
  });
});
