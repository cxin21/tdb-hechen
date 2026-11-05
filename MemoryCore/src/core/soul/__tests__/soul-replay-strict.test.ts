/**
 * 严格回放校准单测：锁住「内容失败」与「仅缺出处」的分离口径。
 *
 * 生产 405 条 rejected 的实测结果见 .scratch/soul-replay-v2-report.md：
 * 内容层 catchRate 98.8%、falseAdmit 0%、仅缺出处 5 条。这里用构造样例锁语义，
 * 防止以后有人把 episode_missing 算进 catchRate 得出「100% 达标」的循环结论。
 */
import { describe, expect, it } from "vitest";

import { replayStrictCalibration, type ReplayCase } from "../replay.js";

const CASES: ReplayCase[] = [
  // 内容不合格：任务相关（换项目不成立）。
  { id: "c1", text: "这次把 soul_episodes 表加三个索引，按 tenant 和 at 查", state: "rejected", slot: "self_identity" },
  // 内容不合格：事件句。
  { id: "c2", text: "2026-11-05 他要求先跑全量再回话", state: "rejected", slot: "self_identity" },
  // 内容合格但无出处：有立场、有代价，缺 episode。
  { id: "c3", text: "我宁可慢一点也要一手证据，放弃一部分速度", state: "rejected", slot: "core_value" },
];

describe("严格回放：内容门与出处门分开统计", () => {
  const rep = replayStrictCalibration(CASES);

  it("任务锚/事件句算内容失败，catchRate 只统计内容失败", () => {
    const c1 = rep.cases.find((c) => c.id === "c1")!;
    const c2 = rep.cases.find((c) => c.id === "c2")!;
    expect(c1.contentPersona).toBe(false);
    expect(c2.contentPersona).toBe(false);
    // 任务句即使侥幸过了换项目测试，也会因「没立场」被判死：内容门不是单一正则。
    expect(c1.contentCodes).toContain("stance_missing");
    expect(c2.contentCodes).toContain("event_sentence");
    expect(rep.contentNonPersona).toBe(2);
    expect(rep.catchRate).toBeCloseTo(2 / 3, 5);
  });

  it("有立场有代价、只缺 episode → 记 provenanceOnly，不算漏网也不算内容失败", () => {
    const c3 = rep.cases.find((c) => c.id === "c3")!;
    expect(c3.contentPersona).toBe(true);
    expect(c3.contentCodes).not.toContain("episode_missing");
    expect(c3.provenanceCodes).toContain("episode_missing");
    expect(rep.provenanceOnly).toBe(1);
    expect(rep.contentAdmits).toBe(0);
    expect(rep.falseAdmitRate).toBe(0);
  });

  it("只统计 rejected 的达标率（adopted/pending 不混入分母）", () => {
    const mixed = replayStrictCalibration([...CASES, { id: "a1", text: "我宁可慢一点也要一手证据，放弃一部分速度", state: "adopted" }]);
    expect(mixed.rejected).toBe(3);
    expect(mixed.total).toBe(4);
    expect(mixed.catchRate).toBeCloseTo(2 / 3, 5);
  });
});
