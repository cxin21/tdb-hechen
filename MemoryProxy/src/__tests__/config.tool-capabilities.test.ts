/**
 * #40-B（ADR0003 派生票 B，2026-10-17）：yaml `injection.toolCapabilities` 解析合同。
 *
 * 合同（工具面数据源合同修订——soul「我能做什么」段数据源从工具面实况扩为 config 显式通道）：
 *   - 缺段 / lines 缺失 / lines 空数组 → 材料化为 {}（lines undefined = 回退运行时
 *     策展，现状逐位，config-first）；
 *   - lines 非空且元素全为 string → 逐字 1:1 透传（不裁剪、不转义、不改序）；
 *   - lines 含非字符串元素 / 非数组 → 整段回退 {}（不静默携带垃圾值进管线）；
 *   - 整段非对象（字符串）→ 整段回退 {}（parseSoulTiming 同构姿势）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../config.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function buildWith(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-toolcap-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, body, "utf-8");
  return buildConfig({ configFile: file });
}

describe("#40-B injection.toolCapabilities 解析（config lines 显式通道）", () => {
  it("缺 toolCapabilities 段 → 材料化为 {}（lines 缺省=回退运行时策展）", () => {
    const cfg = buildWith(`injection:
  enabled: true
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
    expect(cfg.injection.toolCapabilities.lines).toBeUndefined();
  });

  it("lines 非空字符串数组 → 逐字 1:1 透传", () => {
    const lines = [
      "通用开发协作：代码取证、缺陷定位、测试驱动实现",
      "多智能体与任务编排：任务分派、进度跟踪与结果汇总",
    ];
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    lines:
      - "通用开发协作：代码取证、缺陷定位、测试驱动实现"
      - "多智能体与任务编排：任务分派、进度跟踪与结果汇总"
`);
    expect(cfg.injection.toolCapabilities).toEqual({ lines });
  });

  it("lines 空数组 → 回退 {}（lines 缺省语义）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    lines: []
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
  });

  it("lines 含非字符串元素 → 整段回退 {}（不携带垃圾值进管线）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    lines:
      - "合法行"
      - 42
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
  });

  it("lines 非数组（字符串）→ 整段回退 {}", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    lines: "junk"
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
  });

  it("toolCapabilities 整段非对象（字符串）→ 整段回退 {}", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities: "junk"
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
  });
});

describe("kill switch（m00265）· toolCapabilities.enabled 解析（缺省 true，false=整段摘除）", () => {
  it("enabled: false → 采纳（唯一显式关断档）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    enabled: false
`);
    expect(cfg.injection.toolCapabilities).toEqual({ enabled: false });
  });

  it("enabled: true 显式开启 → 采纳", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    enabled: true
`);
    expect(cfg.injection.toolCapabilities).toEqual({ enabled: true });
  });

  it("enabled 缺省 → 不携带键（缺省 true 零行为变化）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    lines:
      - "合法行"
`);
    expect(cfg.injection.toolCapabilities).toEqual({ lines: ["合法行"] });
    expect(cfg.injection.toolCapabilities.enabled).toBeUndefined();
  });

  it("enabled 非布尔（字符串值）→ 不采纳键（不静默携带垃圾值）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    enabled: "false"
`);
    expect(cfg.injection.toolCapabilities).toEqual({});
  });

  it("enabled: false 与 lines 并存 → 双字段齐携（curator 先门 enabled，lines 不参与）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  toolCapabilities:
    enabled: false
    lines:
      - "残留行"
`);
    expect(cfg.injection.toolCapabilities).toEqual({ enabled: false, lines: ["残留行"] });
  });
});
