/**
 * 2026-11-18（A5 复核 P0）：soulMaintenance 白名单缺口回归。
 *
 * 现象：config.ts 只解析 25 个键，其余 7 个在 DEFAULT 与消费方都真实存在，
 * 却在 yaml 里写了也不生效（静默回落缺省）。这条用例锁住「写了就生效」。
 * 另锁不变式：driftFreeze 必须低于 driftDegrade（drift.ts 先判 freeze）。
 */
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";

const soulOf = (soulMaintenance: Record<string, unknown>) =>
  parseConfig({ coreMemory: { soulMaintenance } } as never).coreMemory.soulMaintenance;

describe("config：memory.coreMemory.soulMaintenance 全键可配", () => {
  it("7 个曾静默失效的键现在生效", () => {
    const s = soulOf({
      driftHistorySize: 3,
      episodeWindowDays: 45,
      maxEpisodeMessages: 500,
      maxEpisodesPerRun: 5,
      maxEpisodesForPrompt: 3,
      minEpisodeEvidence: 1,
      voiceFewShotPerItem: 1,
    });
    expect(s.driftHistorySize).toBe(3);
    expect(s.episodeWindowDays).toBe(45);
    expect(s.maxEpisodeMessages).toBe(500);
    expect(s.maxEpisodesPerRun).toBe(5);
    expect(s.maxEpisodesForPrompt).toBe(3);
    expect(s.minEpisodeEvidence).toBe(1);
    expect(s.voiceFewShotPerItem).toBe(1);
  });

  it("越界值夹到安全区（不是静默接受）", () => {
    const s = soulOf({ driftHistorySize: 999, episodeWindowDays: 9999, voiceFewShotPerItem: 0 });
    expect(s.driftHistorySize).toBe(50);
    expect(s.episodeWindowDays).toBe(365);
    expect(s.voiceFewShotPerItem).toBe(1);
  });

  it("driftFreeze 写反时夹到 driftDegrade 之下（否则 degrade 永远不可达）", () => {
    const s = soulOf({ driftDegrade: 0.5, driftFreeze: 0.9 });
    expect(s.driftFreeze).toBeLessThan(s.driftDegrade);
    expect(s.driftFreeze).toBe(0.49);
  });
});
