/**
 * A1（pending-backlog）· layered-metrics 归档旁挂纯函数单测（TDD，先于实现）。
 *
 * 覆盖：
 *   [H] isLayeredCopyPath / deriveLayeredCopyPath：派生副本命名口径（<原名>.layered.json）
 *   [I] parseAnchorTimestampKey / pickPreviousAnchorRun："上一份已归档锚"选取
 *       （排除 .layered.json 派生副本；按文件名前导时间戳排序；无时间戳视为最早；
 *         严格取早于当前锚的最大者）
 *   [J] CC_COLLAPSE_THRESHOLD / detectCcCollapse / extractAnchorCc：塌方侦测线
 *       （相对降幅 > 50% → 触发；阈值口径：3 锚带宽 0（0.40/0.40/0.40）校准，
 *         2026-09-12 裁定）
 *
 * 纯函数零 IO；eval 脚本层接线（含红牌 stderr）见 eval-layered-recall.a1.test.ts。
 */
import { describe, it, expect } from "vitest";
import {
  CC_COLLAPSE_THRESHOLD,
  isLayeredCopyPath,
  deriveLayeredCopyPath,
  parseAnchorTimestampKey,
  pickPreviousAnchorRun,
  detectCcCollapse,
  extractAnchorCc,
} from "../layered-metrics.js";

describe("[H] 派生副本命名（A1 写副本 Minor ②）", () => {
  it("H1 <原名>.json → <原名>.layered.json（同目录旁挂）", () => {
    expect(deriveLayeredCopyPath("runs/2026-09-12T13-33-14.json")).toBe("runs/2026-09-12T13-33-14.layered.json");
  });

  it("H2 非 .json 后缀路径 → 直接追加 .layered.json", () => {
    expect(deriveLayeredCopyPath("runs/custom-anchor")).toBe("runs/custom-anchor.layered.json");
  });

  it("H3 派生副本路径自身可被 isLayeredCopyPath 识别", () => {
    expect(isLayeredCopyPath("2026-09-12T13-33-14.layered.json")).toBe(true);
  });

  it("H4 原档名不是派生副本", () => {
    expect(isLayeredCopyPath("2026-09-12T13-33-14.json")).toBe(false);
  });

  it("H5 名称含 .layered 但非 .layered.json 结尾 → 不是派生副本", () => {
    expect(isLayeredCopyPath("x.layered.json.bak")).toBe(false);
  });
});

describe("[I] 上一份已归档锚选取（塌方侦测基线口径）", () => {
  // 真实 runs/ 命名形态采样（含同时间戳变体与合成 00-00-00 前缀）
  const RUNS = [
    "2026-09-11T23-05-24.json",
    "2026-09-12T00-00-00-c1-truncation-replay-on-pre-anchor.json",
    "2026-09-12T02-36-59.json",
    "2026-09-12T02-39-39.json",
    "2026-09-12T02-42-13-gov4-postrepair-replay.json",
    "2026-09-12T02-42-13.json",
    "2026-09-12T12-11-49.json",
    "2026-09-12T13-33-14.json",
  ];

  it("I1 parseAnchorTimestampKey：前导时间戳提取", () => {
    expect(parseAnchorTimestampKey("2026-09-12T13-33-14.json")).toBe("2026-09-12T13-33-14");
    expect(parseAnchorTimestampKey("2026-09-12T02-42-13-gov4-postrepair-replay.json")).toBe("2026-09-12T02-42-13");
    expect(parseAnchorTimestampKey("custom-anchor.json")).toBeNull();
  });

  it("I2 最新锚的上一份 = 按归档时间严格早于当前的最大者", () => {
    expect(pickPreviousAnchorRun(RUNS, "2026-09-12T13-33-14.json")).toBe("2026-09-12T12-11-49.json");
  });

  it("I3 排除派生副本（.layered.json）", () => {
    const files = [...RUNS, "2026-09-12T13-33-14.layered.json", "2026-09-12T14-00-00.layered.json"];
    expect(pickPreviousAnchorRun(files, "2026-09-12T15-00-00.json")).toBe("2026-09-12T13-33-14.json");
  });

  it("I4 排除当前锚自身（同时间戳变体按码点序取最大者：'-gov4…' < '.json'）", () => {
    expect(pickPreviousAnchorRun(RUNS, "2026-09-12T12-11-49.json")).toBe("2026-09-12T02-42-13.json");
  });

  it("I5 重放旧锚：只取早于它的（晚于它的归档不参与）", () => {
    expect(pickPreviousAnchorRun(RUNS, "2026-09-12T02-39-39.json")).toBe("2026-09-12T02-36-59.json");
  });

  it("I6 无时间戳文件视为最早（排序垫底）", () => {
    const files = ["custom-anchor.json", "2026-09-12T02-36-59.json"];
    expect(pickPreviousAnchorRun(files, "2026-09-12T02-39-39.json")).toBe("2026-09-12T02-36-59.json");
    expect(pickPreviousAnchorRun(files, "2026-09-12T02-36-59.json")).toBe("custom-anchor.json");
  });

  it("I7 无早于当前锚的候选 → null（无基线，跳过侦测）", () => {
    expect(pickPreviousAnchorRun(["2026-09-12T14-00-00.json"], "2026-09-12T13-33-14.json")).toBeNull();
    expect(pickPreviousAnchorRun([], "2026-09-12T13-33-14.json")).toBeNull();
    expect(pickPreviousAnchorRun(["2026-09-12T13-33-14.json"], "2026-09-12T13-33-14.json")).toBeNull();
  });
});

describe("[J] CC 塌方侦测线（阈值 50%，3 锚带宽 0 校准 2026-09-12 裁定）", () => {
  it("J1 阈值常量 = 0.5", () => {
    expect(CC_COLLAPSE_THRESHOLD).toBe(0.5);
  });

  it("J2 相对降幅 > 50% → 触发并携带 previous/current/ratio", () => {
    const t = detectCcCollapse(0.4, 0.1);
    expect(t).not.toBeNull();
    expect(t!.previous).toBe(0.4);
    expect(t!.current).toBe(0.1);
    expect(t!.ratio).toBeCloseTo(0.75, 12);
  });

  it("J3 相对降幅恰 = 50% → 不触发（严格大于口径）", () => {
    expect(detectCcCollapse(0.4, 0.2)).toBeNull();
  });

  it("J4 持平/上升 → 不触发", () => {
    expect(detectCcCollapse(0.4, 0.4)).toBeNull();
    expect(detectCcCollapse(0.4, 1)).toBeNull();
  });

  it("J5 无基线（previous 为 null/undefined/0）→ 不侦测不伪造", () => {
    expect(detectCcCollapse(null, 0.1)).toBeNull();
    expect(detectCcCollapse(undefined, 0.1)).toBeNull();
    expect(detectCcCollapse(0, 0.1)).toBeNull();
  });

  it("J6 当前 CC 为 null（空 golden）→ 不侦测", () => {
    expect(detectCcCollapse(0.4, null)).toBeNull();
  });

  it("J7 自定义阈值可注入", () => {
    const t = detectCcCollapse(0.4, 0.3, 0.2);
    expect(t).not.toBeNull();
    expect(t!.previous).toBe(0.4);
    expect(t!.current).toBe(0.3);
    expect(t!.ratio).toBeCloseTo(0.25, 12);
  });

  it("J8 extractAnchorCc：从归档 JSON 取 layeredMetrics.metrics.cc（缺/非法 → null）", () => {
    expect(extractAnchorCc({ layeredMetrics: { metrics: { cc: 0.4 } } })).toBe(0.4);
    expect(extractAnchorCc({})).toBeNull();
    expect(extractAnchorCc({ layeredMetrics: { metrics: { cc: "0.4" } } })).toBeNull();
    expect(extractAnchorCc(null)).toBeNull();
  });
});
