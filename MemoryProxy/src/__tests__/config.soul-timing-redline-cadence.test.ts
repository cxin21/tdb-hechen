/**
 * redlineCadence（2026-10-23，#39 终判 revisit 后用户拍板 D=8）：yaml
 * injection.soulTiming.redlineCadence 解析合同（strict enum + 条件材料化，
 * config-first；沿 redlineDedup/reanchor 先例）。
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

function buildWith(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-cadence-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, body, "utf-8");
  return buildConfig({ configFile: file });
}

function yamlWith(cadenceLines: string[] | null): string {
  const lines = [
    "injection:",
    "  enabled: true",
    "  soulTiming:",
    '    redline: "action_proximate"',
    '    driftTrigger: "off"',
  ];
  if (cadenceLines !== null) {
    lines.push("    redlineCadence:", ...cadenceLines);
  }
  return lines.join("\n") + "\n";
}

describe("soulTiming.redlineCadence 解析（2026-10-23 用户拍板 D=8）", () => {
  it("mode=turn_head（仅 mode）→ 材料化 { mode, depthOverflow: 8, riskToolPatterns: [] }", () => {
    expect(buildWith(yamlWith(['      mode: "turn_head"'])).injection.soulTiming.redlineCadence).toEqual({
      mode: "turn_head",
      depthOverflow: 8,
      riskToolPatterns: [],
    });
  });

  it("mode=every_action_point → 材料化（显式声明 = 逐位现状语义）", () => {
    expect(buildWith(yamlWith(['      mode: "every_action_point"'])).injection.soulTiming.redlineCadence).toEqual({
      mode: "every_action_point",
      depthOverflow: 8,
      riskToolPatterns: [],
    });
  });

  it("depthOverflow clamp [1,200] floor：10→10、0→1、999→200、1.7→1", () => {
    expect(
      buildWith(yamlWith(['      mode: "turn_head"', "      depthOverflow: 10"])).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 10, riskToolPatterns: [] });
    expect(
      buildWith(yamlWith(['      mode: "turn_head"', "      depthOverflow: 0"])).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 1, riskToolPatterns: [] });
    expect(
      buildWith(yamlWith(['      mode: "turn_head"', "      depthOverflow: 999"])).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 200, riskToolPatterns: [] });
    expect(
      buildWith(yamlWith(['      mode: "turn_head"', "      depthOverflow: 1.7"])).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 1, riskToolPatterns: [] });
  });

  it("depthOverflow 非数值（字符串）→ 回退缺省 8", () => {
    expect(
      buildWith(yamlWith(['      mode: "turn_head"', '      depthOverflow: "8"'])).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 8, riskToolPatterns: [] });
  });

  it("riskToolPatterns 流数组逐字采纳；含非字符串元素过滤；标量 → []（风险覆盖关）", () => {
    expect(
      buildWith(
        yamlWith(['      mode: "turn_head"', "      riskToolPatterns: [push, deploy]"]),
      ).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 8, riskToolPatterns: ["push", "deploy"] });
    expect(
      buildWith(
        yamlWith(['      mode: "turn_head"', "      riskToolPatterns: [1, push]"]),
      ).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 8, riskToolPatterns: ["push"] });
    expect(
      buildWith(
        yamlWith(['      mode: "turn_head"', "      riskToolPatterns: push"]),
      ).injection.soulTiming.redlineCadence,
    ).toEqual({ mode: "turn_head", depthOverflow: 8, riskToolPatterns: [] });
  });

  it("mode 缺失（仅 depthOverflow）→ 整段不带键（逐位现状）", () => {
    const cfg = buildWith(yamlWith(["      depthOverflow: 5"]));
    expect("redlineCadence" in cfg.injection.soulTiming).toBe(false);
  });

  it("mode 非法（bogus）→ 整段不带键", () => {
    const cfg = buildWith(yamlWith(['      mode: "bogus"']));
    expect("redlineCadence" in cfg.injection.soulTiming).toBe(false);
  });

  it("redlineCadence 非对象（标量）→ 不带键", () => {
    const cfg = buildWith(yamlWith(["      junk"]));
    expect("redlineCadence" in cfg.injection.soulTiming).toBe(false);
  });

  it("无 redlineCadence 键 → 不带键；其余 timing 字段照常解析", () => {
    const cfg = buildWith(yamlWith(null));
    expect("redlineCadence" in cfg.injection.soulTiming).toBe(false);
    expect(cfg.injection.soulTiming).toEqual({ ...DEFAULT_SOUL_TIMING, redline: "action_proximate" });
  });
});
