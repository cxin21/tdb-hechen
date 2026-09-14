/**
 * A1（pending-backlog）· eval-layered-recall 塌方侦测线接线 fixture 验证（TDD，先于实现）。
 *
 * fixture 验证（不碰 D:/tdai-data，零生产 DB）：临时 runs 目录构造
 * "上一锚 CC 高、当前 CC 低"场景，断言：
 *   1. 塌方触发并携带 previous/current/ratio；
 *   2. stderr loud 红牌（RED-CARD）发出；
 *   3. 无塌方 / 无基线时不发红牌；
 *   4. 上一锚 CC 读取兼容：原档 layeredMetrics 内嵌（旧锚）与旁挂 .layered.json 副本（新锚）双源；
 *   5. pickLatestAnchorRun 缺省目标选取排除派生副本。
 *
 * eval-layered-recall.ts 的 main() 已带直接调用守卫（import 不触发 DB 访问）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCcCollapseAgainstRuns, pickLatestAnchorRun } from "../../../../scripts/eval-layered-recall.js";

function makeTmpRuns(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eval-layered-a1-"));
}

function writeRun(dir: string, name: string, json: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(json, null, 2), "utf8");
  return p;
}

describe("[K] eval 塌方侦测线接线（fixture：上一锚 CC 高、当前 CC 低）", () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeTmpRuns();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("K1 触发红牌：prev 0.4 → current 0.1（相对降幅 75% > 50%）", async () => {
    const prev = writeRun(dir, "2026-09-12T12-00-00.json", { layeredMetrics: { metrics: { cc: 0.4 } } });
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", { note: "fresh anchor archive, no layeredMetrics yet" });

    const outcome = await checkCcCollapseAgainstRuns(cur, 0.1, dir);

    expect(outcome.previousRun).toBe("2026-09-12T12-00-00.json");
    expect(outcome.previousCc).toBe(0.4);
    expect(outcome.trigger).not.toBeNull();
    expect(outcome.trigger!.previous).toBe(0.4);
    expect(outcome.trigger!.current).toBe(0.1);
    expect(outcome.trigger!.ratio).toBeCloseTo(0.75, 12);
    const redCards = errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).filter((s: string) => s.includes("RED-CARD"));
    expect(redCards.length).toBeGreaterThan(0);
    expect(redCards[0]).toContain("0.4");
    expect(redCards[0]).toContain("0.1");
    expect(redCards[0]).toContain("75");
    expect(prev).toBeTruthy();
  });

  it("K2 无塌方（prev 0.4 → current 0.4）→ 不触发不发红牌", async () => {
    writeRun(dir, "2026-09-12T12-00-00.json", { layeredMetrics: { metrics: { cc: 0.4 } } });
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", {});

    const outcome = await checkCcCollapseAgainstRuns(cur, 0.4, dir);

    expect(outcome.trigger).toBeNull();
    expect(errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).some((s: string) => s.includes("RED-CARD"))).toBe(false);
  });

  it("K3 上一锚无 CC 基线 → 不侦测不红牌（如实跳过）", async () => {
    writeRun(dir, "2026-09-12T12-00-00.json", { note: "old archive without layeredMetrics" });
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", {});

    const outcome = await checkCcCollapseAgainstRuns(cur, 0.1, dir);

    expect(outcome.previousRun).toBe("2026-09-12T12-00-00.json");
    expect(outcome.previousCc).toBeNull();
    expect(outcome.trigger).toBeNull();
    expect(errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).some((s: string) => s.includes("RED-CARD"))).toBe(false);
  });

  it("K4 上一锚 CC 双源兼容：原档无内嵌 lm 时读旁挂 .layered.json 副本", async () => {
    writeRun(dir, "2026-09-12T12-00-00.json", { note: "anchor written after A1: metrics live in the sidecar" });
    writeRun(dir, "2026-09-12T12-00-00.layered.json", { layeredMetrics: { metrics: { cc: 0.8 } } });
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", {});

    const outcome = await checkCcCollapseAgainstRuns(cur, 0.2, dir);

    expect(outcome.previousCc).toBe(0.8);
    expect(outcome.trigger).not.toBeNull();
    expect(outcome.trigger!.previous).toBe(0.8);
    expect(outcome.trigger!.current).toBe(0.2);
    expect(outcome.trigger!.ratio).toBeCloseTo(0.75, 12);
  });

  it("K5 上一锚选取排除派生副本与当前锚", async () => {
    writeRun(dir, "2026-09-12T12-00-00.json", { layeredMetrics: { metrics: { cc: 0.4 } } });
    // 派生副本时间戳更晚（若不排除会被误选为"上一份锚"）
    writeRun(dir, "2026-09-12T12-30-00.layered.json", { layeredMetrics: { metrics: { cc: 0.9 } } });
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", {});

    const outcome = await checkCcCollapseAgainstRuns(cur, 0.1, dir);

    expect(outcome.previousRun).toBe("2026-09-12T12-00-00.json");
    expect(outcome.previousCc).toBe(0.4);
  });

  it("K6 无任何早于当前锚的归档 → previousRun null，不红牌", async () => {
    const cur = writeRun(dir, "2026-09-12T13-00-00.json", {});
    const outcome = await checkCcCollapseAgainstRuns(cur, 0.1, dir);
    expect(outcome.previousRun).toBeNull();
    expect(outcome.trigger).toBeNull();
    expect(errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).some((s: string) => s.includes("RED-CARD"))).toBe(false);
  });
});

describe("[L] pickLatestAnchorRun：缺省目标排除派生副本", () => {
  it("L1 混有 .layered.json 副本与非 json 文件时只取锚归档", () => {
    const dir = makeTmpRuns();
    try {
      writeRun(dir, "2026-09-12T12-00-00.json", {});
      writeRun(dir, "2026-09-12T12-00-00.layered.json", {});
      fs.writeFileSync(path.join(dir, "notes.txt"), "x", "utf8");
      expect(pickLatestAnchorRun(dir)).toBe(path.join(dir, "2026-09-12T12-00-00.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L2 目录为空 → 抛错（与 pickTargetRun 原语义一致）", () => {
    const dir = makeTmpRuns();
    try {
      expect(() => pickLatestAnchorRun(dir)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
