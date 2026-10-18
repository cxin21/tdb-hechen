/**
 * soul-dedupe（2026-10-19）：yaml injection.soulTiming.redlineDedup 解析合同。
 *
 * 条件材料化（与 parseSoulTiming strict-enum 同哲学）：
 *   - 缺 redlineDedup 键 / enabled 非 true / 整段非对象 → 不带键（= off = 逐位现状，
 *     DEFAULT_SOUL_TIMING 不材料化此键，config.soul-timing.test.ts 的 toEqual 合同不破坏）；
 *   - enabled=true → { enabled:true, jaccardThreshold:0.45 }（缺省阈值与 MemoryCore
 *     soul-dedupe DEFAULT_RULE_JACCARD_THRESHOLD 同源）；
 *   - jaccardThreshold 数值且 ∈[0,1] 透传；非数值/越界 → 回退 0.45。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../config.js";
import { DEFAULT_SOUL_TIMING } from "../injection/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function buildWith(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-soul-dd-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, yaml, "utf-8");
  return buildConfig({ configFile: file });
}

/** yaml 片段行拼接（避开模板串，行数组可读）。 */
function y(...ls: string[]): string {
  return ls.join("\n") + "\n";
}

describe("soulTiming.redlineDedup 解析（条件材料化，config-first）", () => {
  it("缺 redlineDedup 键 → soulTiming 不带键（toEqual DEFAULT_SOUL_TIMING 合同不破坏）", () => {
    const cfg = buildWith(y(
      "injection:",
      "  enabled: true",
      "  soulTiming:",
      '    redline: "action_proximate"',
    ));
    expect(cfg.injection.soulTiming).toEqual({ ...DEFAULT_SOUL_TIMING, redline: "action_proximate" });
    expect(cfg.injection.soulTiming).not.toHaveProperty("redlineDedup");
  });

  it("enabled=true → 材料化 { enabled:true, jaccardThreshold:0.45 }（缺省阈值）", () => {
    const cfg = buildWith(y(
      "injection:",
      "  enabled: true",
      "  soulTiming:",
      '    redline: "action_proximate"',
      "    redlineDedup:",
      "      enabled: true",
    ));
    expect(cfg.injection.soulTiming.redlineDedup).toEqual({ enabled: true, jaccardThreshold: 0.45 });
  });

  it("jaccardThreshold=0.6 → 透传", () => {
    const cfg = buildWith(y(
      "injection:",
      "  soulTiming:",
      "    redlineDedup:",
      "      enabled: true",
      "      jaccardThreshold: 0.6",
    ));
    expect(cfg.injection.soulTiming.redlineDedup).toEqual({ enabled: true, jaccardThreshold: 0.6 });
  });

  it("enabled=false → 不带键（缺省 off=逐位现状）", () => {
    const cfg = buildWith(y(
      "injection:",
      "  soulTiming:",
      "    redlineDedup:",
      "      enabled: false",
    ));
    expect(cfg.injection.soulTiming).not.toHaveProperty("redlineDedup");
  });

  it("jaccardThreshold 非数值/越界 → 回退 0.45", () => {
    const junk = buildWith(y(
      "injection:",
      "  soulTiming:",
      "    redlineDedup:",
      "      enabled: true",
      '      jaccardThreshold: "x"',
    ));
    expect(junk.injection.soulTiming.redlineDedup).toEqual({ enabled: true, jaccardThreshold: 0.45 });
    const oob = buildWith(y(
      "injection:",
      "  soulTiming:",
      "    redlineDedup:",
      "      enabled: true",
      "      jaccardThreshold: 1.5",
    ));
    expect(oob.injection.soulTiming.redlineDedup).toEqual({ enabled: true, jaccardThreshold: 0.45 });
  });

  it("redlineDedup 整段非对象（字符串）→ 不带键", () => {
    const cfg = buildWith(y(
      "injection:",
      "  soulTiming:",
      '    redlineDedup: "junk"',
    ));
    expect(cfg.injection.soulTiming).not.toHaveProperty("redlineDedup");
  });
});
