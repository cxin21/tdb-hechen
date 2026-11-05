/**
 * 事件层（soul_episodes）单测：确定性挖掘 / 幂等 id / kind 优先级 / 逐字原话 /
 * 代价不编造 / 情绪派生 / 检索匹配。
 *
 * 铁律与 persona 单测相同：纯函数、不联网、不碰生产库、不调 LLM。
 * 事件层的价值在于「事实可回查」，所以每条断言都钉在某个具体字段上，而不是「看起来像」。
 */
import { describe, expect, it } from "vitest";
import {
  cleanObjectPhrase,
  episodeAppraisal,
  emotionEventFromEpisode,
  episodeDigest,
  emotionObjectForEpisode,
  extractCost,
  isAssistantQuoteCandidate,
  matchEpisode,
  mineEpisodes,
  type EpisodeSourceRow,
} from "../episode.js";
import { resolveSoulConfig } from "../types.js";

const CFG = resolveSoulConfig({ enabled: true });

const ROWS: EpisodeSourceRow[] = [
  {
    record_id: "u1",
    session_id: "s1",
    role: "user",
    message_text: "不对，这不是我要的：先给我一手证据，不要听转述。",
    recorded_at: "2026-11-04T10:00:00.000Z",
  },
  {
    record_id: "a1",
    session_id: "s1",
    role: "assistant",
    message_text: "我直接去现场跑一遍，把真实错误贴回来。",
    recorded_at: "2026-11-04T10:01:00.000Z",
  },
  {
    record_id: "u2",
    session_id: "s1",
    role: "user",
    message_text: "我宁可少做一个功能，也不交付没验证过的结论，这个代价我认。",
    recorded_at: "2026-11-04T10:02:00.000Z",
  },
  {
    record_id: "a2",
    session_id: "s1",
    role: "assistant",
    message_text: "好，我按你说的先取证再动手。",
    recorded_at: "2026-11-04T10:03:00.000Z",
  },
  // 代码/路径句不能成为 few-shot：voice 层要的是「他怎么说话」，不是他粘贴了什么。
  {
    record_id: "u3",
    session_id: "s1",
    role: "user",
    message_text: "看 D:/TDB/td-agemem/MemoryCore/src/core/soul/worker.ts 第 42 行",
    recorded_at: "2026-11-04T10:04:00.000Z",
  },
];

describe("episode：L0 原始对话的确定性切片", () => {
  it("从真实对话挖出事件，id 由会话+记录决定（重跑逐字相同）", () => {
    const a = mineEpisodes(ROWS, CFG);
    const b = mineEpisodes(ROWS, CFG);
    expect(a.episodes.length).toBeGreaterThanOrEqual(2);
    expect(a.episodes.map((e) => e.episodeId)).toEqual(b.episodes.map((e) => e.episodeId));
    for (const ep of a.episodes) expect(ep.episodeId).toMatch(/^ep-[0-9a-z]+$/);
    // 同一会话内去重：同一句抱怨不会因为 tick 重跑而变成两条。
    const ids = a.episodes.map((e) => e.episodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("kind 优先级：取舍（value_conflict）压过纠正；普通纠正不会被漏掉", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const kinds = episodes.map((e) => e.kind).sort();
    expect(kinds).toContain("value_conflict");
    expect(kinds).toContain("correction");
  });

  it("逐字原话 + 双方立场 + 代价：每个字段都能回查到具体 record_id", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const value = episodes.find((e) => e.kind === "value_conflict")!;
    expect(value.quote?.text).toContain("宁可少做一个功能");
    expect(value.quote?.recordId).toBe("u2");
    expect(value.userStance).toContain("宁可");
    // 代价短语取「取舍词周围的原文字面」，不是模型概括：这里命中的是「宁可少做」。
    expect(value.cost).toContain("宁可少做");
    // 立场=他回应时我上一条的说法；结果=他之后我实际怎么收尾。两者分开存，才看得见「我改没改」。
    expect(value.agentStance).toBe("我直接去现场跑一遍，把真实错误贴回来");
    expect(value.outcome).toBe("好，我按你说的先取证再动手");
    expect(value.evidenceIds).toContain("u2");
    // 证据 id 全部来自真实输入，不允许合成。
    const real = new Set(ROWS.map((r) => r.record_id));
    for (const id of value.evidenceIds) expect(real.has(id)).toBe(true);
  });

  it("找不到代价就留空——不补写、不推断", () => {
    const { episodes } = mineEpisodes([ROWS[0], ROWS[1]], CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(corr.cost).toBe("");
  });

  it("voice 语料只收助手自己的干净短句（用户原话/路径/代码一律排除）", () => {
    const { voiceQuotes } = mineEpisodes(ROWS, CFG);
    // 2026-11-05 生产 review：voice 是「我的说话方式」，不能拿他的原话冒充；
    // 旧实现把 u2 收进来，生成结果是「他开口像下工单」却挂在「## 我的说话方式」下。
    expect(voiceQuotes.some((q) => q.recordId === "a1")).toBe(true);
    expect(voiceQuotes.some((q) => q.recordId === "a2")).toBe(true);
    expect(voiceQuotes.some((q) => q.recordId === "u2")).toBe(false);
    expect(voiceQuotes.some((q) => q.recordId === "u3")).toBe(false);
    expect(voiceQuotes.every((q) => q.role === "assistant")).toBe(true);
    expect(isAssistantQuoteCandidate("看 D:/TDB/x.worker.ts 第 42 行", 8)).toBe(false);
    expect(isAssistantQuoteCandidate("我直接去现场跑一遍，把真实错误贴回来。", 8)).toBe(true);
  });

  it("情绪由词面与标点决定：对象来自原话，强度有界且可复算", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(corr.valence).toBeLessThan(0);
    expect(corr.intensity).toBeGreaterThan(0);
    expect(corr.intensity).toBeLessThanOrEqual(1);
    const ev = emotionEventFromEpisode(corr, CFG);
    expect(ev.object.length).toBeGreaterThan(0);
    expect(ev.valence).toBe(corr.valence);
    expect(ev.at).toBe(corr.at);
  });

  it("appraisal 由事件结构与回应结果派生，不是常量：同类事件结局不同，控制感/归因不同", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    const withReply = episodeAppraisal({ ...corr, agentStance: "我直接去现场跑一遍", outcome: "已按你说的改完并重跑" });
    const noReply = episodeAppraisal({ ...corr, agentStance: "", outcome: "" });
    // 有回应 → 我还能控制；没有回应 → 控制感低（旧实现两者恒为 .5）。
    expect(withReply.control).toBeGreaterThan(noReply.control);
    expect(withReply.agency).toBe("self");
    expect(noReply.agency).toBe("other");
    // 纠正类事件的期望违背高于拍板类，不是同一个常量。
    const decision = episodeAppraisal({ ...corr, kind: "decision" });
    expect(withReply.expectationViolation).toBeGreaterThan(decision.expectationViolation);
    // 目标相关性与强度绑定，有界。
    const strong = episodeAppraisal({ ...corr, intensity: 1 });
    const weak = episodeAppraisal({ ...corr, intensity: 0 });
    expect(strong.goalRelevance).toBeGreaterThan(weak.goalRelevance);
    expect(strong.goalRelevance).toBeLessThanOrEqual(0.95);
  });
  it("情绪对象：任务标题不变成长期偏见，退回 kind 级对象仍说得出因为什么", () => {
    expect(emotionObjectForEpisode({ kind: "correction", object: "【任务】把 GitHub issue #179 的注入预算守卫改完并复测" })).toBe("被纠正");
    expect(emotionObjectForEpisode({ kind: "value_conflict", object: "假绿" })).toBe("假绿");
  });

  it("digest 只给事实行（id/kind/对象/原话/代价），可直接进 prompt", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const lines = episodeDigest(episodes, { max: 10 });
    expect(lines.length).toBe(episodes.length);
    expect(lines[0]).toMatch(/^ep-[0-9a-z]+ \| /);
    expect(lines.join("\n")).toContain("cost=");
  });

  it("检索：按对象/原话/立场可命中，空 query 返回全部", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(matchEpisode(corr, "一手证据")).toBe(true);
    expect(matchEpisode(corr, "完全不存在的词")).toBe(false);
    expect(matchEpisode(corr, "")).toBe(true);
  });

  it("对象短语去语气词：『不对，这不是我要的』不该把『不对』当对象", () => {
    expect(cleanObjectPhrase("不对，这不是我要的：先给我一手证据")).not.toContain("不对");
  });

  it("代价截取限定在原文范围内，不跨句编造", () => {
    const cost = extractCost("我宁可少做一个功能，也不交付没验证过的结论");
    expect(cost.length).toBeGreaterThan(0);
    expect("我宁可少做一个功能，也不交付没验证过的结论").toContain(cost.replace(/\s+/gu, " ").trim());
  });
});
