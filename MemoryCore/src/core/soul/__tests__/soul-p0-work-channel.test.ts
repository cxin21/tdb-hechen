/**
 * P0-B（2026-11-07）：最小任务通道（kind="work"）。
 *
 * 背景：生产 L0 水位之后 37 行全是「跑下全量测试」「把这个删掉」这类派活，
 * classifyUserMessage 只认八类情绪/裁决标记 → episodes=0 → 特质 0 票、人格永不长大。
 *
 * 这条通道的边界必须钉死：
 *   1) 任务陈述句产 work（固定 0/0.25/0.15，affectSource=lexicon）；
 *   2) 问句不产（问是在问，不是派活）；
 *   3) work 不参与情绪对象与心境（object 恒空 → 心境门拿不到对象，naturally 不开）；
 *   4) 有情绪标记的句子仍然走原分类，不会被 work 抢走。
 */
import { describe, expect, it } from "vitest";
import { emotionEventFromEpisode, emotionObjectForEpisode, mineEpisodes, type EpisodeSourceRow } from "../episode.js";
import { moodGrowthGate } from "../emotion.js";
import { resolveSoulConfig } from "../types.js";

const CFG = resolveSoulConfig({});

function rows(texts: string[], session = "s-work"): EpisodeSourceRow[] {
  return texts.map((message_text, i) => ({
    record_id: `u${i + 1}`,
    session_id: session,
    role: "user",
    message_text,
    recorded_at: `2026-11-07T10:0${i}:00.000Z`,
  }));
}

function mine(texts: string[]) {
  return mineEpisodes(rows(texts), CFG, { windowDays: 30 });
}

describe("P0-B 最小任务通道（work）", () => {
  it("任务陈述句产 work：signals=[task_instruction]、0/0.25/0.15、affectSource=lexicon", () => {
    const { episodes } = mine(["跑下全量测试，然后把失败清单贴回来。"]);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0]!;
    expect(ep.kind).toBe("work");
    expect(ep.signals).toContain("task_instruction");
    expect(ep.valence).toBe(0);
    expect(ep.arousal).toBe(0.25);
    expect(ep.intensity).toBe(0.15);
    expect(ep.affectSource).toBe("lexicon");
    expect(ep.title.startsWith("任务：")).toBe(true);
  });

  it("问句不产：以 ？ 结尾、或以 吗/呢 收尾的都在问，不是在派活", () => {
    const { episodes } = mine([
      "你把全量测试跑完了吗？",
      "这个导出功能要怎么改呢",
      "我该先看哪一块？",
    ]);
    expect(episodes).toHaveLength(0);
  });

  it("太短 / 没有动作词 / 注入体都不产（宁窄勿宽）", () => {
    const { episodes } = mine([
      "跑一下",
      "明天上午十点开个会，会议室在三层东侧。",
      "[Compressed conversation section] 请把测试跑一遍并贴回结果。",
    ]);
    expect(episodes).toHaveLength(0);
  });

  it("work 不参与情绪对象与心境：object 恒空，心境门因此拿不到对象", () => {
    const { episodes } = mine(["跑下全量测试，然后把失败清单贴回来。"]);
    const ep = episodes[0]!;
    expect(emotionObjectForEpisode(ep)).toBe("");
    const event = emotionEventFromEpisode(ep, CFG);
    expect(event.object).toBe("");
    // 门的输入就是 emotionObjectForEpisode 的产物：空对象 ⇒ 门不开（count 再高也不开）。
    expect(moodGrowthGate({ focus: "self", object: event.object, count: 3, repaired: false })).toBeNull();
  });

  it("有情绪标记的句子仍走原分类，不被 work 抢走", () => {
    const { episodes } = mine(["改完的这些东西全都不对，我要的是先取证再改。"]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).not.toBe("work");
  });

  it("work 仍受每会话 cap 约束（沿用同一个 cap，不新开通道）", () => {
    const texts = Array.from({ length: 8 }, (_, i) => `把第 ${i + 1} 个模块的测试跑一遍并贴回失败清单。`);
    // 判据是「work 走的是同一个 perSessionCap」，不是某个写死的数字：
    // 缺省 cap 由 EPISODE_SESSION_CANDIDATE_CEILING 统一给（200），这里显式压到 5 验证生效。
    const { episodes } = mineEpisodes(rows(texts), CFG, { windowDays: 30, perSessionCap: 5 });
    expect(episodes.length).toBeLessThanOrEqual(5);
    const loose = mineEpisodes(rows(texts), CFG, { windowDays: 30 });
    expect(loose.episodes.length).toBe(8);
  });
});