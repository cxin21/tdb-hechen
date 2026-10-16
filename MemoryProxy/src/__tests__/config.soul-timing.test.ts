/**
 * #39（ADR0003-P3 / 接线票 A，2026-10-16）：yaml `injection.soulTiming` 解析合同。
 *
 * 合同（#37 首交付 SoulTimingConfig 类型冻结 → 本票材料化接线）：
 *   - 缺段 → 全字段材料化为 DEFAULT_SOUL_TIMING（缺省=现状逐位，config-first）；
 *   - 显式合法值逐字段翻转（strict enum）；
 *   - 非法枚举值/整段非对象 → 回退缺省（不静默携带垃圾值进管线）。
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
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-soul-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, body, "utf-8");
  return buildConfig({ configFile: file });
}

describe("#39 injection.soulTiming 解析（strict enum，config-first）", () => {
  it("缺 soulTiming 段 → 全字段材料化为 DEFAULT_SOUL_TIMING", () => {
    const cfg = buildWith(`injection:
  enabled: true
`);
    expect(cfg.injection.soulTiming).toEqual(DEFAULT_SOUL_TIMING);
  });

  it("显式 redline=action_proximate → 单字段翻转，其余保持缺省", () => {
    const cfg = buildWith(`injection:
  enabled: true
  soulTiming:
    redline: "action_proximate"
`);
    expect(cfg.injection.soulTiming).toEqual({
      ...DEFAULT_SOUL_TIMING,
      redline: "action_proximate",
    });
  });

  it("driftTrigger=shadow 与 feeling=session_head 亦为合法翻转位", () => {
    const cfg = buildWith(`injection:
  enabled: true
  soulTiming:
    driftTrigger: "shadow"
    feeling: "session_head"
`);
    expect(cfg.injection.soulTiming).toEqual({
      ...DEFAULT_SOUL_TIMING,
      driftTrigger: "shadow",
      feeling: "session_head",
    });
  });

  it("非法枚举值 → 该字段回退缺省（不携带垃圾值进管线）", () => {
    const cfg = buildWith(`injection:
  enabled: true
  soulTiming:
    redline: "yolo"
    identity: "whenever"
`);
    expect(cfg.injection.soulTiming).toEqual(DEFAULT_SOUL_TIMING);
  });

  it("soulTiming 整段非对象（字符串）→ 整段回退缺省", () => {
    const cfg = buildWith(`injection:
  enabled: true
  soulTiming: "junk"
`);
    expect(cfg.injection.soulTiming).toEqual(DEFAULT_SOUL_TIMING);
  });
});
