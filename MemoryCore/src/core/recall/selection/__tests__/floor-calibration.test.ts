import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFloorCalibration,
  embeddingSimFloorKey,
  loadFloorCalibrationFile,
  parseFloorCalibration,
  resolveEmbeddingSimFloor,
} from "../floor-calibration.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "floor-cal-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("embeddingSimFloorKey", () => {
  it("按 model@dims 组键（换维即失配）", () => {
    expect(embeddingSimFloorKey("text-embedding-3-large", 3072)).toBe("text-embedding-3-large@3072");
    expect(embeddingSimFloorKey("embeddinggemma-300m", 768)).not.toBe(
      embeddingSimFloorKey("embeddinggemma-300m", 1024),
    );
  });
});

describe("parseFloorCalibration", () => {
  it("解析合法 JSON 且值有限", () => {
    const raw = buildFloorCalibration([
      { model: "m1", dims: 768, value: 0.31, measuredAt: "2026-11-02", samples: 300, method: "null-probe-p95" },
      { model: "m1", dims: 1024, value: 0.28 },
    ]);
    const map = parseFloorCalibration(raw);
    expect(map.get("m1@768")).toBeCloseTo(0.31, 5);
    expect(map.get("m1@1024")).toBeCloseTo(0.28, 5);
    expect(map.size).toBe(2);
  });

  it("坏 JSON / 坏形状 / 非法值 → 空表（诚实 no-op，不抛）", () => {
    expect(parseFloorCalibration("{not json").size).toBe(0);
    expect(parseFloorCalibration("[]").size).toBe(0);
    expect(parseFloorCalibration(JSON.stringify({ entries: { "m@1": { value: "x" } } })).size).toBe(0);
    expect(parseFloorCalibration(JSON.stringify({ entries: { "m@1": { value: 2 } } })).size).toBe(0);
    expect(parseFloorCalibration(JSON.stringify({ entries: { "m@1": { value: null } } })).size).toBe(0);
  });
});

describe("buildFloorCalibration", () => {
  it("产物含样本来源与可重算元信息", () => {
    const raw = buildFloorCalibration([
      {
        model: "embeddinggemma-300m",
        dims: 768,
        value: 0.3021,
        measuredAt: "2026-11-02T03:00:00.000Z",
        samples: 300,
        method: "null-probe-p95",
        source: "recall-journal cross-session pairs",
      },
    ]);
    const doc = JSON.parse(raw) as {
      schemaVersion?: number;
      entries?: Record<string, { value?: number; samples?: number; method?: string; source?: string }>;
    };
    expect(doc.schemaVersion).toBe(1);
    const rec = doc.entries?.["embeddinggemma-300m@768"];
    expect(rec?.value).toBeCloseTo(0.3021, 5);
    expect(rec?.samples).toBe(300);
    expect(rec?.method).toBe("null-probe-p95");
    expect(rec?.source).toContain("recall-journal");
  });
});

describe("resolveEmbeddingSimFloor", () => {
  const cal = new Map([["m@768", 0.31]]);

  it("config 优先", () => {
    expect(resolveEmbeddingSimFloor({ configured: 0.5, calibration: cal, model: "m", dims: 768 })).toEqual({
      value: 0.5,
      source: "config",
    });
  });

  it("config 缺省则用标定值", () => {
    expect(resolveEmbeddingSimFloor({ configured: null, calibration: cal, model: "m", dims: 768 })).toEqual({
      value: 0.31,
      source: "calibration",
    });
  });

  it("键缺失/维度不符 → uncalibrated + null（不猜地板）", () => {
    expect(resolveEmbeddingSimFloor({ configured: null, calibration: cal, model: "m", dims: 1024 })).toEqual({
      value: null,
      source: "uncalibrated",
    });
    expect(resolveEmbeddingSimFloor({ configured: null, calibration: new Map(), model: "m", dims: 768 })).toEqual({
      value: null,
      source: "uncalibrated",
    });
  });
});

describe("loadFloorCalibrationFile", () => {
  it("文件缺失 → 空表且不抛", () => {
    expect(loadFloorCalibrationFile(join(tmpDir(), "missing.json")).size).toBe(0);
  });

  it("读到文件后按 mtime 缓存（内容更新可见）", () => {
    const dir = tmpDir();
    const file = join(dir, "embedding-sim-floor.json");
    writeFileSync(file, buildFloorCalibration([{ model: "m", dims: 768, value: 0.3 }]), "utf8");
    expect(loadFloorCalibrationFile(file).get("m@768")).toBeCloseTo(0.3, 5);
    writeFileSync(file, buildFloorCalibration([{ model: "m", dims: 768, value: 0.4 }]), "utf8");
    const update = new Date(Date.now() + 5000);
    require("node:fs").utimesSync(file, update, update);
    expect(loadFloorCalibrationFile(file).get("m@768")).toBeCloseTo(0.4, 5);
  });
});
