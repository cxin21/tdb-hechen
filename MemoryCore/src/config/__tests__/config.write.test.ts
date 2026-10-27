import { describe, it, expect } from "vitest";
import { parseConfig } from "../../config.js";

/**
 * #134 生产写面配置（memory.write）：
 *  - 缺省全关（生产安全缺省，逐位现状）
 *  - yaml 值生效；maxFactChars clamp ≥0；separator 空串回落默认
 */
describe("config: write（#134 写面策略）", () => {
  it("缺省全关", () => {
    const c = parseConfig({});
    expect(c.write.factKey).toEqual({ enabled: false, separator: " | ", maxFactChars: 240 });
    expect(c.write.supersession).toEqual({ enabled: false });
  });

  it("yaml 值生效 + clamp", () => {
    const c = parseConfig({
      write: {
        factKey: { enabled: true, separator: "::", maxFactChars: -5 },
        supersession: { enabled: true },
      },
    });
    expect(c.write.factKey.enabled).toBe(true);
    expect(c.write.factKey.separator).toBe("::");
    expect(c.write.factKey.maxFactChars).toBe(0);
    expect(c.write.supersession.enabled).toBe(true);
  });

  it("separator 保原样（前后空格保留）；空白串回落默认", () => {
    expect(parseConfig({ write: { factKey: { separator: " | " } } }).write.factKey.separator).toBe(" | ");
    expect(parseConfig({ write: { factKey: { separator: "" } } }).write.factKey.separator).toBe(" | ");
    expect(parseConfig({ write: { factKey: { separator: "   " } } }).write.factKey.separator).toBe(" | ");
  });
});
