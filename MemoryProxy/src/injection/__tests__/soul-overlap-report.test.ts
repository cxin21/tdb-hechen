/**
 * #51（H26）：soul/core 重叠报告口径感知纯函数层单测。
 * 合同（父任务实现合同 + issue #51 验收锚）：
 *   - 三档判定规则只消费同口径（norm 相同）数据；
 *   - 窗口跨口径切换日（同口径数据不足 days 天）→ insufficient-window 诚实降级，不套用三档规则；
 *   - 报告口径切换日 = 首个 norm>=1 行的日期；旧行无 norm 字段 = 0 口径。
 * 混窗数据下报告不套用三档规则 = 本套件核心验收锚。
 */

import { describe, it, expect } from "vitest";
import { decideOverlapWindow, inferNormSwitchDay } from "../soul-overlap-report.js";

/** 决策固定 now（UTC），days=14 → cutoff=2026-10-03T12:00:00.000Z。 */
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const DAYS = 14;

interface Row {
  ts?: string;
  norm?: number;
  soul_line_hashes?: string[];
  core_line_hashes?: string[];
}

function row(ts: string, norm: number | undefined, soul: string[], core: string[]): Row {
  const r: Row = { ts, soul_line_hashes: soul, core_line_hashes: core };
  if (norm !== undefined) r.norm = norm;
  return r;
}

describe("inferNormSwitchDay（口径切换日 = 首个 norm>=1 行的日期）", () => {
  it("混窗：首个 norm>=1 行的日期（输入顺序 = journal 追加顺序）", () => {
    const entries: Row[] = [
      row("2026-10-05T01:00:00.000Z", undefined, ["a"], ["b"]),
      row("2026-10-16T09:00:00.000Z", 0, ["a"], ["b"]),
      row("2026-10-17T02:00:00.000Z", 1, ["a"], ["a"]),
      row("2026-10-18T02:00:00.000Z", 1, ["a"], ["a"]),
    ];
    expect(inferNormSwitchDay(entries)).toBe("2026-10-17");
  });

  it("全为旧行（无 norm>=1）→ null；全为新行 → 首行日期", () => {
    expect(inferNormSwitchDay([row("2026-10-05T01:00:00.000Z", undefined, ["a"], ["b"])])).toBeNull();
    expect(
      inferNormSwitchDay([
        row("2026-10-01T01:00:00.000Z", 1, ["a"], ["b"]),
        row("2026-10-02T01:00:00.000Z", 1, ["a"], ["b"]),
      ]),
    ).toBe("2026-10-01");
  });

  it("norm>=1 但 ts 缺失/非法的行被跳过，不误判切换日", () => {
    const entries: Row[] = [
      { norm: 1, soul_line_hashes: ["a"], core_line_hashes: ["b"] },
      row("unknown", 1, ["a"], ["b"]),
      row("2026-10-17T02:00:00.000Z", 1, ["a"], ["a"]),
    ];
    expect(inferNormSwitchDay(entries)).toBe("2026-10-17");
    expect(inferNormSwitchDay([row("unknown", 1, ["a"], ["a"])])).toBeNull();
  });
});

describe("decideOverlapWindow（三档判定只消费同口径数据；窗口不足 → insufficient-window）", () => {
  it("验收锚：混窗数据（切换日在窗口内）→ insufficient-window，不套用三档规则", () => {
    const entries: Row[] = [
      // 旧口径行（norm 缺省=0）：同文异装格式噪声下 Jaccard 恒 0% 的历史测量
      row("2026-10-05T01:00:00.000Z", undefined, ["a", "b"], ["c", "d"]),
      row("2026-10-16T09:00:00.000Z", 0, ["a", "b"], ["c", "d"]),
      // 归一口径行：今日切换后高重叠
      row("2026-10-17T02:00:00.000Z", 1, ["a", "b"], ["a", "b"]),
    ];
    const d = decideOverlapWindow(entries, DAYS, NOW);
    expect(d.status).toBe("insufficient-window");
    expect(d.reason).toBeTruthy();
    expect(d.tier).toBeUndefined();
  });

  it("journal 无归一口径行（全旧口径）→ insufficient-window", () => {
    const entries: Row[] = [
      row("2026-10-05T01:00:00.000Z", undefined, ["a"], ["b"]),
      row("2026-10-10T01:00:00.000Z", 0, ["a"], ["b"]),
    ];
    const d = decideOverlapWindow(entries, DAYS, NOW);
    expect(d.status).toBe("insufficient-window");
    expect(d.tier).toBeUndefined();
  });

  it("窗口全在归一 era：verdict 三档映射（>80 归一 / 60-80 分工 / <60 关票）", () => {
    // 切换日 2026-09-20（窗外），窗口内 norm=1 行 Jaccard=100% → >80 → 归一通道
    const normalize: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]),
      row("2026-10-10T01:00:00.000Z", 1, ["h1", "h2"], ["h1", "h2"]),
    ];
    const d1 = decideOverlapWindow(normalize, DAYS, NOW);
    expect(d1.status).toBe("verdict");
    expect(d1.tier).toBe("normalize");
    expect(d1.mean).toBe(1);

    // 0% → <60 → 维持双通道（窗外锚行立切换日 era；窗内只有决策行）
    const keep: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]), // 切换日（窗外），不计入决策均值
      row("2026-10-10T01:00:00.000Z", 1, ["a", "b"], ["p", "q"]),
    ];
    const dKeep = decideOverlapWindow(keep, DAYS, NOW);
    expect(dKeep.status).toBe("verdict");
    expect(dKeep.tier).toBe("keep-dual");

    // 75%（inter=6, union=8）→ 60-80 → 分工边界
    const boundary: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]),
      row("2026-10-10T01:00:00.000Z", 1, ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"], ["h1", "h2", "h3", "h4", "h5", "h6"]),
    ];
    expect(decideOverlapWindow(boundary, DAYS, NOW).tier).toBe("boundary");

    // 恰好 80%（inter=4, union=5）→ 非 >80 → 分工边界（60-80 档含 80）
    const exact80: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]),
      row("2026-10-10T01:00:00.000Z", 1, ["h1", "h2", "h3", "h4", "h5"], ["h1", "h2", "h3", "h4"]),
    ];
    expect(decideOverlapWindow(exact80, DAYS, NOW).tier).toBe("boundary");
  });

  it("同口径消费：窗口内 norm=0 旧行被排除，判定只统计 norm=1 行", () => {
    const entries: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]), // 切换日（窗外）
      row("2026-10-05T01:00:00.000Z", undefined, ["a", "b"], ["c", "d"]), // 窗内旧口径行 J=0%
      row("2026-10-10T01:00:00.000Z", 1, ["h1", "h2"], ["h1", "h2"]), // 窗内归一行 J=100%
    ];
    const d = decideOverlapWindow(entries, DAYS, NOW);
    expect(d.status).toBe("verdict");
    expect(d.mean).toBe(1); // 若误混窗口内旧 0% 行，均值会跌到 0.5
    expect(d.tier).toBe("normalize");
    expect(d.rows).toBe(1);
  });

  it("切换日早于窗口起点但窗口内无 norm=1 有效行 → insufficient-window", () => {
    const entries: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]), // 切换日（窗外），此后 journal 停写
      row("2026-10-10T01:00:00.000Z", 0, ["a"], ["b"]), // 窗内只有旧口径行
    ];
    const d = decideOverlapWindow(entries, DAYS, NOW);
    expect(d.status).toBe("insufficient-window");
    expect(d.tier).toBeUndefined();
  });

  it("窗口内 norm=1 行 ts 非法 → 不计入决策数据", () => {
    const entries: Row[] = [
      row("2026-09-20T01:00:00.000Z", 1, ["h1"], ["h1"]),
      { norm: 1, soul_line_hashes: ["a"], core_line_hashes: ["b"] }, // 无 ts
    ];
    const d = decideOverlapWindow(entries, DAYS, NOW);
    expect(d.status).toBe("insufficient-window");
  });
});
