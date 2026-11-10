/**
 * P0-1（2026-11-08）：kind 与「对哪一层有信息量」显式绑定。
 *
 * 背景（v4 §2.2 D1）：水位之后 soul_episodes 只有 work——不是门太严，而是**输入为空**：
 * 一条消息只保留一个 kind，同句里的纠正/抱怨/认可/决策被 first-hit-wins 丢掉，
 * 落表侧再按 kind ≠ work 过滤，于是人格层每轮空跑。
 *
 * 本测试钉死四件事（对应任务书①②③④）：
 *   1) 「带纠正语气的任务指令」主 kind 仍是 work，但 identity/boundary 信号不丢；
 *   2) kind→layer 映射表逐项可断言（判据是表，不是渲染配置）；
 *   3) 纯任务指令不产生 layers（work 本身不构成人格证据）；
 *   4) 问句不误判（沿用 isUtteranceLike 语义：问是在问，不是派活，也不是裁决）。
 *
 * 另外断言挖掘侧读数：candidates / byKind / personaCandidates / contextOnly——
 * 「没挖到」与「挖到了没落表」必须能在返回结构上分辨。
 */
import { describe, expect, it } from "vitest";
import {
  EPISODE_KIND_LAYERS,
  mineEpisodes,
  type EpisodeMineStats,
  type EpisodeSourceRow,
} from "../episode.js";
import { resolveSoulConfig, SOUL_EPISODE_KINDS, type SoulLayer } from "../types.js";

const CFG = resolveSoulConfig({});
const LAYERS: SoulLayer[] = ["identity", "values", "boundary", "relationship"];

function rows(texts: string[], session = "s-layers"): EpisodeSourceRow[] {
  return texts.map((message_text, i) => ({
    record_id: `r${i + 1}`,
    session_id: session,
    role: "user",
    message_text,
    recorded_at: `2026-11-08T02:0${i}:00.000Z`,
  }));
}

function mine(texts: string[]) {
  return mineEpisodes(rows(texts), CFG, { windowDays: 30 });
}

describe("P0-1 kind→layer 映射表", () => {
  it("十个 kind 逐项断言：哪些层有信息量是判据，不是渲染配置", () => {
    // 一次写全表，任何一项漂移都直接红：漏改、手滑、加 kind 忘登记都会在这里暴露。
    expect(EPISODE_KIND_LAYERS).toEqual({
      correction: ["identity"],
      praise: ["identity"],
      decision: ["values"],
      value_conflict: ["values"],
      divergence: ["values", "boundary"],
      complaint: ["boundary", "relationship"],
      pressure: ["relationship"],
      affect: ["relationship"],
      resignation: ["boundary", "relationship"],
      work: [],
    });
  });

  it("表必须覆盖 SOUL_EPISODE_KINDS 全集，且只使用四层（事件层不得越权推断 self/voice/human/narrative）", () => {
    expect(Object.keys(EPISODE_KIND_LAYERS).sort()).toEqual([...SOUL_EPISODE_KINDS].sort());
    for (const kind of SOUL_EPISODE_KINDS) {
      for (const layer of EPISODE_KIND_LAYERS[kind]) expect(LAYERS).toContain(layer);
    }
  });

  it("work 的层恒为空：派活永远不是人格证据", () => {
    expect(EPISODE_KIND_LAYERS.work).toEqual([]);
  });
});

describe("P0-1 work 不再遮蔽同句信号", () => {
  it("带纠正语气的任务指令：主 kind=work，但 identity/boundary 信号挂在 layers 上", () => {
    const { episodes, stats } = mine(["先把全量测试跑完再改代码，跟你说过多少次了。"]);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0]!;
    // 身份不变：这是一条派活，work 仍然是 work。
    expect(ep.kind).toBe("work");
    expect(ep.signals).toContain("task_instruction");
    // 但「说过多少次」不能被丢掉：它说的是我该守住的行为准则（identity）与红线（boundary）。
    expect(ep.layers).toContain("identity");
    expect(ep.layers).toContain("boundary");
    // work 恒不进人格候选：只作为上下文出现，并计入 contextOnly。
    expect(stats.contextOnly).toBe(1);
    expect(stats.personaCandidates).toBe(0);
  });

  it("同一句里既有认可又有纠正：主 kind 一个，layers 两层都在", () => {
    // 「不错」= 认可（identity），「别再只贴总结」= 红线（boundary）；主分类器只取一个 kind，
    // P0-1 之前第二层信息就没了。
    const { episodes } = mine(["不错，照上次那样做，但别再只贴总结。"]);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0]!;
    expect(ep.kind).toBe("praise");
    expect(ep.layers).toContain("identity");
    expect(ep.layers).toContain("boundary");
  });
});

describe("P0-1 纯任务指令不产生 layers", () => {
  it("没有任何情绪/纠正/认可信号：layers 缺省 undefined（未标注，不是空数组）", () => {
    const { episodes } = mine(["把 docs 里的旧方案删掉，然后重新生成索引。"]);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0]!;
    expect(ep.kind).toBe("work");
    expect(ep.layers).toBeUndefined();
    expect("layers" in ep).toBe(false);
  });
});

describe("P0-1 问句不误判（isUtteranceLike 语义）", () => {
  it("问句即使带「照上次」这类语气词也不产事件：问是在问，不是派活/裁决", () => {
    const { episodes, stats } = mine([
      "你把全量测试跑完了吗？",
      "照上次那样改，行吗？",
      "这个导出功能要怎么改呢",
    ]);
    expect(episodes).toHaveLength(0);
    expect(stats.candidates).toBe(0);
    expect(stats.personaCandidates).toBe(0);
  });
});

describe("P0-1 挖掘侧读数（判据可观测）", () => {
  it("stats 给出候选数、按 kind 计数、人格候选与仅上下文的条数", () => {
    const result = mine([
      "先把全量测试跑完再改代码，跟你说过多少次了。",
      "把 docs 里的旧方案删掉，然后重新生成索引。",
      "改完的这些东西全都不对，我要的是先取证再改。",
    ]);
    const stats: EpisodeMineStats = result.stats;
    expect(stats.candidates).toBe(3);
    expect(stats.byKind).toEqual({ work: 2, correction: 1 });
    // 只有 correction 既非 work 又对 identity 有信息量 → 人格候选 1 条。
    expect(stats.personaCandidates).toBe(1);
    // work 且带 layers 的只有第一条 → 上下文 1 条。
    expect(stats.contextOnly).toBe(1);
    // 上下文一路只放 work，且恒不与人格候选重叠。
    expect(result.contextEpisodes.map((e) => e.kind)).toEqual(["work"]);
    expect(result.contextEpisodes[0]!.layers).toEqual(["identity", "boundary"]);
  });

  it("layers 的次序固定为 identity→values→boundary→relationship（可回放）", () => {
    const { episodes } = mine(["算了随你，别再只贴总结了。"]);
    const ep = episodes[0]!;
    expect(ep.layers).toEqual(["boundary", "relationship"]);
  });
});
