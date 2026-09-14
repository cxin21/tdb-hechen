import { describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";

// ═══════════════ DS-SCENE-GOV-001 Task GOV-1 · sceneGovernance 配置解析 ═══════════════
// 仿 conclusionLayer 的解析+clamp+默认模式（config.ts 同文件同族）。
// 铁律：enabled 缺省 false = 生产行为零变化；仅 yaml 显式开启后治理链路才介入。

describe("DS-SCENE-GOV-001 GOV-1 config：sceneGovernance（enabled 缺省 false + clamp 边界）", () => {
  it("零配置：enabled 缺省 false（生产行为零变化）+ 三键缺省值 8000/60000/20000", () => {
    const g = parseConfig({}).sceneGovernance;
    expect(g.enabled).toBe(false);
    expect(g.maxBlockChars).toBe(8000);
    expect(g.distillTimeoutMs).toBe(60000);
    expect(g.hardCapChars).toBe(20000);
  });

  it("maxBlockChars clamp [500, 100000]：低于下限抬到 500，超上限压到 100000，区间内透传", () => {
    expect(parseConfig({ sceneGovernance: { maxBlockChars: 100 } }).sceneGovernance.maxBlockChars).toBe(500);
    expect(parseConfig({ sceneGovernance: { maxBlockChars: 200000 } }).sceneGovernance.maxBlockChars).toBe(100000);
    expect(parseConfig({ sceneGovernance: { maxBlockChars: 9000 } }).sceneGovernance.maxBlockChars).toBe(9000);
  });

  it("distillTimeoutMs 缺省 60000；负值 clamp 0；正值透传", () => {
    expect(parseConfig({ sceneGovernance: { distillTimeoutMs: -5 } }).sceneGovernance.distillTimeoutMs).toBe(0);
    expect(parseConfig({ sceneGovernance: { distillTimeoutMs: 30000 } }).sceneGovernance.distillTimeoutMs).toBe(30000);
  });

  it("hardCapChars clamp 下限 = maxBlockChars：传入更小值抬到 maxBlockChars，更大值透传", () => {
    // 缺省 maxBlockChars=8000 → hardCapChars 100 抬到 8000
    expect(parseConfig({ sceneGovernance: { hardCapChars: 100 } }).sceneGovernance.hardCapChars).toBe(8000);
    // maxBlockChars=9000 时 hardCapChars 100 抬到 9000（下限跟随解析后的 maxBlockChars）
    expect(
      parseConfig({ sceneGovernance: { maxBlockChars: 9000, hardCapChars: 100 } }).sceneGovernance.hardCapChars,
    ).toBe(9000);
    expect(parseConfig({ sceneGovernance: { hardCapChars: 30000 } }).sceneGovernance.hardCapChars).toBe(30000);
  });

  it("enabled 显式 true 透传（配置化纪律：yaml 开启才生效）", () => {
    expect(parseConfig({ sceneGovernance: { enabled: true } }).sceneGovernance.enabled).toBe(true);
    expect(parseConfig({}).sceneGovernance.enabled).toBe(false);
  });
});
