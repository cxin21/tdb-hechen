/**
 * 缺口 B · 注入侧：场景块触发词命中即条件必注入（RED）。
 *
 * 合同：
 *  - 命中触发词 ⇒ 越过纯语义命中门槛（sceneHit/textHit）与低密度门，并在预算内优先占位；
 *  - 未命中 ⇒ 行为与旧路径逐位一致（同一输入两次跑结果相同、结果对象不多字段）；
 *  - 可观测：命中时 result.keywordTriggered = { blocks, keywords }；pool 条目带 triggered。
 */
import { describe, expect, it } from "vitest";
import { selectL2Conclusions, selectL2ConclusionsDetailed, type L2ConclusionCandidate } from "../recall-layered.js";

const Q = "缓存对账怎么做";
const OFF = { ftsTokens: [] as string[] };

function cand(over: Partial<L2ConclusionCandidate> & { content: string }): L2ConclusionCandidate {
  return { sceneName: "", source: "scene_block", ...over };
}

describe("B · 触发词通道", () => {
  it("命中触发词 ⇒ 纯语义不命中也被选中", () => {
    const c = cand({ sceneName: "kv-cache", content: "与查询毫无交集的摘要文本", keywords: ["缓存对账", "召回"] });
    expect(selectL2Conclusions(Q, [c], OFF, 3)).toHaveLength(1);
    expect(selectL2Conclusions(Q, [c], OFF, 3)[0]!.sceneName).toBe("kv-cache");
  });

  it("同一候选去掉触发词 ⇒ 回到旧行为（不选中）", () => {
    const c = cand({ sceneName: "kv-cache", content: "与查询毫无交集的摘要文本" });
    expect(selectL2Conclusions(Q, [c], OFF, 3)).toEqual([]);
  });

  it("逐位一致：未命中触发的路径同一输入两次跑结果相同且不带 keywordTriggered", () => {
    const cs = [
      cand({ sceneName: "a", content: Q }),
      cand({ sceneName: "b", content: "另一个缓存对账相关的摘要", keywords: ["对账"] }),
    ];
    const r1 = selectL2ConclusionsDetailed(Q, cs, OFF, 2);
    const r2 = selectL2ConclusionsDetailed(Q, cs, OFF, 2);
    expect(r1).toEqual(r2);
    // b 的触发词「对账」被 query 包含 ⇒ 算命中，可观测字段存在；a 未带触发词不受影响
    expect(r1.keywordTriggered).toEqual({ blocks: 1, keywords: [["对账"]] });
  });

  it("无触发词命中 ⇒ 结果对象与旧形状逐位相同（无 keywordTriggered 字段）", () => {
    const cs = [cand({ sceneName: "a", content: Q, keywords: ["无关触发词"] })];
    const r = selectL2ConclusionsDetailed(Q, cs, { ftsTokens: [Q] }, 2);
    expect(r.selected).toHaveLength(1);
    expect("keywordTriggered" in r).toBe(false);
    expect(r.pool[0]!.triggered).toBeUndefined();
  });

  it("预算优先：触发块挤掉按旧序本该入选的强命中块", () => {
    const strong = cand({ sceneName: "strong", content: Q });
    const triggered = cand({ sceneName: "triggered", content: "完全无关", keywords: ["缓存对账"] });
    const r = selectL2ConclusionsDetailed(Q, [strong, triggered], OFF, 1);
    expect(r.selected.map((c) => c.sceneName)).toEqual(["triggered"]);
    expect(r.pool.find((e) => e.order === 1)?.triggered).toEqual(["缓存对账"]);
  });

  it("低密度门被触发通道越过（自指回放块也能按触发词注入）", () => {
    const loop = "同源再交付无新增仅维护热度。".repeat(20);
    const c = cand({ sceneName: "loop", content: loop, keywords: ["缓存对账"] });
    expect(selectL2ConclusionsDetailed(Q, [c], { ...OFF, minUniqRatio: 0.6 }, 2).selected).toHaveLength(1);
  });

  it("空 query / limit=0 时仍是旧早退形状", () => {
    const c = cand({ content: "x", keywords: ["缓存对账"] });
    expect(selectL2ConclusionsDetailed("", [c], OFF, 3)).toEqual({ selected: [], pool: [] });
    expect(selectL2ConclusionsDetailed(Q, [c], OFF, 0)).toEqual({ selected: [], pool: [] });
  });
});
