import { describe, it, expect } from "vitest";
import { parseConfig } from "../../config.js";

/**
 * #134 生产写面配置（memory.write）：
 *  - 缺省 = 生产最优档（2026-10-31 拍板）：supersession 开（long-session-bench §6 正收益）、
 *    factKey 关（#149 −2.2pp）、factRows 关（#146 无读数）
 *  - yaml 值生效；maxFactChars clamp ≥0；separator 空串回落默认
 */
describe("config: write（#134 写面策略）", () => {
  it("缺省 = 生产最优档（supersession 开 / factKey 关 / factRows 关）", () => {
    const c = parseConfig({});
    expect(c.write.factKey).toEqual({
      enabled: false,
      mode: "replace",       // #137：缺省 replace = W1 旧形态（不静默改语义）
      separator: " | ",
      maxFactChars: 240,
      maxFacts: 5,
      includeTriples: false,
      onlyForTypes: [],
    });
    // #136：cardinalityGate 缺省 true（修复开启）；cardinalityDefault 缺省 single（保覆盖）
    // supersession 缺省开 = 生产最优档（读数见 docs/long-session-bench.md §6）
    expect(c.write.supersession).toEqual({ enabled: true, cardinalityGate: true, cardinalityDefault: "single" });
    // factRows 缺省显式关（不靠键缺失隐式表达）
    expect(c.write.factRows?.enabled).toBe(false);
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

  it("#136 属性契约开关：cardinalityGate / cardinalityDefault 解析", () => {
    const off = parseConfig({ write: { supersession: { cardinalityGate: false } } }).write.supersession;
    expect(off.cardinalityGate).toBe(false);
    expect(off.cardinalityDefault).toBe("single");
    const strict = parseConfig({ write: { supersession: { cardinalityDefault: "multi" } } }).write.supersession;
    expect(strict.cardinalityDefault).toBe("multi");
    // 非法值回落缺省 single
    expect(parseConfig({ write: { supersession: { cardinalityDefault: "bogus" } } }).write.supersession.cardinalityDefault).toBe("single");
  });

  it("#137 factKey 通道形态 + maxFacts clamp + onlyForTypes 解析", () => {
    const ch = parseConfig({
      write: {
        factKey: {
          enabled: true,
          mode: "channel",
          maxFacts: 99,
          includeTriples: true,
          onlyForTypes: ["work_fact", "", "episodic"],
        },
      },
    }).write.factKey;
    expect(ch.mode).toBe("channel");
    expect(ch.maxFacts).toBe(12); // clamp 上界
    expect(ch.includeTriples).toBe(true);
    expect(ch.onlyForTypes).toEqual(["work_fact", "episodic"]);
    // 非法 mode → 回落 replace（不静默切形态）
    expect(parseConfig({ write: { factKey: { mode: "bogus" } } }).write.factKey.mode).toBe("replace");
    // 0/负/非法 = 回落缺省 5（全仓一套语义，不再有"0=不限"分叉）
    expect(parseConfig({ write: { factKey: { maxFacts: 0 } } }).write.factKey.maxFacts).toBe(5);
    expect(parseConfig({ write: { factKey: { maxFacts: 3 } } }).write.factKey.maxFacts).toBe(3);
  });

  it("separator 保原样（前后空格保留）；空白串回落默认", () => {
    expect(parseConfig({ write: { factKey: { separator: " | " } } }).write.factKey.separator).toBe(" | ");
    expect(parseConfig({ write: { factKey: { separator: "" } } }).write.factKey.separator).toBe(" | ");
    expect(parseConfig({ write: { factKey: { separator: "   " } } }).write.factKey.separator).toBe(" | ");
  });

  // #146（事实行粒度）：factRows 缺省关 = 整行失效语义逐位不变
  it("#146 factRows 缺省关闭，不注入 maxFacts（留空交给写侧回落 factKey.maxFacts）", () => {
    const fr = parseConfig({}).write.factRows;
    expect(fr?.enabled).toBe(false);
    // 缺省不发 maxFacts：写侧 factRowOptionsOf 才能回落 factKey.maxFacts（配置不越权改语义）
    expect(fr?.maxFacts).toBeUndefined();
  });

  it("#146 factRows yaml 生效 + maxFacts 同一套 clamp", () => {
    const on = parseConfig({ write: { factRows: { enabled: true } } }).write.factRows;
    expect(on?.enabled).toBe(true);
    expect(on?.maxFacts).toBeUndefined();
    // clamp 与 extraction.facts.maxFacts / factKey.maxFacts 同一套（0/负/非法 → 5；>12 → 12）
    expect(parseConfig({ write: { factRows: { enabled: true, maxFacts: 3 } } }).write.factRows?.maxFacts).toBe(3);
    expect(parseConfig({ write: { factRows: { enabled: true, maxFacts: 99 } } }).write.factRows?.maxFacts).toBe(12);
    expect(parseConfig({ write: { factRows: { enabled: true, maxFacts: 0 } } }).write.factRows?.maxFacts).toBe(5);
    expect(parseConfig({ write: { factRows: { enabled: true, maxFacts: -2 } } }).write.factRows?.maxFacts).toBe(5);
  });

  it("#146 factRows 非法/未知值不报错，回落到缺省关", () => {
    // 非对象 / 字符串 / 未知字段：一律安全回落，不抛
    expect(parseConfig({ write: { factRows: "bogus" } }).write.factRows?.enabled).toBe(false);
    expect(parseConfig({ write: { factRows: { enabled: "yes" } } }).write.factRows?.enabled).toBe(false);
    expect(parseConfig({ write: { factRows: { enabled: 1, whatever: true } } }).write.factRows?.enabled).toBe(false);
  });
});
