/**
 * #59（S21）：yaml injection.soulTiming.driftTrigger="auto" 与 reanchor.intervalTurns
 * 解析合同（strict enum + 条件材料化，config-first；沿 redlineDedup 先例）。
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
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-reanchor-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, body, "utf-8");
  return buildConfig({ configFile: file });
}

function yaml(intervalTurns: string | null): string {
  const lines = [
    "injection:",
    "  enabled: true",
    "  soulTiming:",
    '    driftTrigger: "auto"',
  ];
  if (intervalTurns !== null) {
    lines.push("    reanchor:", "      intervalTurns: " + intervalTurns);
  }
  return lines.join("\n") + "\n";
}

describe("#59 soulTiming.driftTrigger=auto + reanchor.intervalTurns 解析", () => {
  it("driftTrigger=auto 合法翻转；无 reanchor 键 → 不材料化 reanchor", () => {
    const cfg = buildWith(yaml(null));
    expect(cfg.injection.soulTiming.driftTrigger).toBe("auto");
    expect("reanchor" in cfg.injection.soulTiming).toBe(false);
    expect(cfg.injection.soulTiming).toEqual({ ...DEFAULT_SOUL_TIMING, driftTrigger: "auto" });
  });

  it("auto + reanchor.intervalTurns=10 → 条件材料化 { intervalTurns: 10 }", () => {
    const cfg = buildWith(yaml("10"));
    expect(cfg.injection.soulTiming.reanchor).toEqual({ intervalTurns: 10 });
  });

  it("intervalTurns clamp [1,200] floor：0→1、999→200、1.7→1", () => {
    expect(buildWith(yaml("0")).injection.soulTiming.reanchor).toEqual({ intervalTurns: 1 });
    expect(buildWith(yaml("999")).injection.soulTiming.reanchor).toEqual({ intervalTurns: 200 });
    expect(buildWith(yaml("1.7")).injection.soulTiming.reanchor).toEqual({ intervalTurns: 1 });
  });

  it("intervalTurns 非数值 → 回退缺省 20", () => {
    const cfg = buildWith(yaml('"weekly"'));
    expect(cfg.injection.soulTiming.reanchor).toEqual({ intervalTurns: 20 });
  });

  it("reanchor 非对象（字符串）→ 不带键；driftTrigger 非法 → 回退 off", () => {
    const cfg = buildWith([
      "injection:",
      "  enabled: true",
      "  soulTiming:",
      '    driftTrigger: "bogus"',
      '    reanchor: "junk"',
      "",
    ].join("\n"));
    expect("reanchor" in cfg.injection.soulTiming).toBe(false);
    expect(cfg.injection.soulTiming.driftTrigger).toBe("off");
  });
});
