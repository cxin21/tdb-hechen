/**
 * task-83（生产 L0 测试数据卫生 · A 段）：会话忽略匹配器的语义契约。
 *
 * 这些用例锁的是「前缀匹配 + `*` 通配 + 其余字符字面转义」这一实现选择
 * （票面允许 glob 或前缀二选一，此处两者兼顾），以及缺省/关闸两种配置的边界：
 *   - `undefined` → 用缺省 `["probe-", "session-probe-"]`（不是「关」）；
 *   - `[]` → 关闸，任何会话都不被忽略（行为回到 task-83 之前）。
 */
import { describe, expect, it } from "vitest";
import {
  compileSessionIgnorePatterns,
  DEFAULT_IGNORE_SESSION_PATTERNS,
} from "./session-ignore.js";

describe("task-83 · 会话忽略匹配器", () => {
  const dflt = compileSessionIgnorePatterns(undefined);

  it("缺省模式命中 probe- 前缀（session_id）", () => {
    expect(DEFAULT_IGNORE_SESSION_PATTERNS).toEqual(["probe-", "session-probe-"]);
    const hit = dflt.match("probe-abc", "probe-abc");
    expect(hit).toEqual({ pattern: "probe-", matchedOn: "session_id", value: "probe-abc" });
    expect(dflt.isIgnored("probe-1700000000-a", undefined)).toBe(true);
  });

  it("缺省模式命中 session-probe- 前缀", () => {
    expect(dflt.isIgnored("session-probe-chatmem", "session-probe-chatmem")).toBe(true);
  });

  it("非命中：前缀只锚开头，中间出现 probe- 不算", () => {
    expect(dflt.isIgnored("my-probe-abc", "my-probe-abc")).toBe(false);
    expect(dflt.isIgnored("probeX", "probeX")).toBe(false);
    // 生产真实会话形态不该被误伤
    expect(dflt.isIgnored("sess-2026-10-31-abcdef", "sess-2026-10-31-abcdef")).toBe(false);
  });

  it("大小写敏感（不做归一化）", () => {
    expect(dflt.isIgnored("PROBE-abc", "PROBE-abc")).toBe(false);
  });

  it("行级 session_id 不命中但外层 session_key 命中 → 也算忽略（matchedOn=session_key）", () => {
    const hit = dflt.match("sess-inner-1", "session-probe-chatmem");
    expect(hit).toEqual({ pattern: "session-probe-", matchedOn: "session_key", value: "session-probe-chatmem" });
  });

  it("空数组 = 关闸：任何会话都不被忽略", () => {
    const off = compileSessionIgnorePatterns([]);
    expect(off.patterns).toEqual([]);
    expect(off.isIgnored("probe-abc", "session-probe-x")).toBe(false);
    expect(off.match("probe-abc", "probe-abc")).toBeUndefined();
  });

  it("* 通配：展开为 .*，其余部分仍按前缀锚定", () => {
    const m = compileSessionIgnorePatterns(["sess-*-probe"]);
    expect(m.isIgnored("sess-ab-probe", undefined)).toBe(true);
    expect(m.isIgnored("sess--probe", undefined)).toBe(true);
    expect(m.isIgnored("sess-ab", undefined)).toBe(false);
    expect(m.isIgnored("xsess-ab-probe", undefined)).toBe(false);
  });

  it("通配符转义：正则元字符按字面匹配", () => {
    const m = compileSessionIgnorePatterns(["probe.[1]", "a+b"]);
    expect(m.isIgnored("probe.[1]tail", undefined)).toBe(true);
    // 若被当正则，[1] 会命中 probe.1；这里必须不命中
    expect(m.isIgnored("probe.1tail", undefined)).toBe(false);
    expect(m.isIgnored("a+btail", undefined)).toBe(true);
    expect(m.isIgnored("aaabtail", undefined)).toBe(false);
  });

  it("空串/纯空白 pattern 被丢弃（不会命中一切）", () => {
    const m = compileSessionIgnorePatterns(["", "   "]);
    expect(m.patterns).toEqual([]);
    expect(m.isIgnored("anything", "anything")).toBe(false);
  });

  it("空/缺值 session_id 与 session_key 安全跳过", () => {
    expect(dflt.isIgnored(undefined, undefined)).toBe(false);
    expect(dflt.isIgnored("", "")).toBe(false);
    expect(dflt.isIgnored("", "probe-x")).toBe(true);
  });

  it("只在目标字段上匹配：session_key 命中不误报 session_id", () => {
    const hit = dflt.match("sess-real", "probe-key");
    expect(hit?.matchedOn).toBe("session_key");
    expect(hit?.value).toBe("probe-key");
  });
});
