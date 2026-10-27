import { describe, it, expect } from "vitest";
import { computeSupersessions } from "./supersession.js";
import { supersessionEligibleForContent } from "./write-policy.js";
import type { WritePolicy } from "./write-policy.js";
import { selectByValidity } from "../recall/validity-policy.js";

/**
 * #136 验收①：一行两事实、只取代其一 → 另一事实仍可召回。
 * 行级失效是把整行 valid_end 写掉，所以"不删错"必须同时满足两件事：
 *   a) 写侧：多值属性那条**不产生**失效 op（cardinality 契约）；
 *   b) 读侧：即使行真的被单值那条取代，soft 模式下也降权保留（另一事实还在池里）。
 */
describe("#136 验收① 一行两事实，只取代其一", () => {
  const NOW = new Date("2026-10-27T00:00:00Z");
  /** turn t1 = 一行两事实：粉丝数（单值）+ 在考虑的配送服务（多值）。 */
  const turns = [
    {
      turnId: "t1",
      timestamp: "2023-05-01T10:00:00",
      facts: [
        { subject: "User", predicate: "Instagram followers", value: "1250" },
        { subject: "User", predicate: "is considering", value: "a new grocery delivery service" },
      ],
    },
    {
      turnId: "t2",
      timestamp: "2023-06-01T10:00:00",
      facts: [
        { subject: "User", predicate: "Instagram followers", value: "1300" },
        { subject: "User", predicate: "is considering", value: "trying Thrive Market" },
      ],
    },
  ];

  it("只有单值事实产生失效 op；多值事实永不失效（#136 评论里的误失效谓词）", () => {
    const ops = computeSupersessions(turns);
    expect(ops.map((o) => o.predicate)).toEqual(["Instagram followers"]);
    expect(ops[0].cardinality).toBe("single");
  });

  it("即使该行被单值那条取代，soft 下仍保留 → 另一事实可召回", () => {
    const ops = computeSupersessions(turns);
    // 写侧 op 落在整行上（行级失效的既有语义，本票不改）
    const row = { id: "t1", valid_start: "2023-05-01T10:00:00", valid_end: ops[0].validEnd };
    const soft = selectByValidity([row], { now: NOW, mode: "soft", presentIntent: false });
    expect(soft.kept.map((r) => r.id)).toEqual(["t1"]);
    // 对照：hard（#136 前）会把它整行删掉——正是误失效的伤害
    const hard = selectByValidity([row], { now: NOW, mode: "hard" });
    expect(hard.dropped.map((r) => r.id)).toEqual(["t1"]);
  });

  it("显式 cardinality 优先；关闭分类（cardinalityGate=false）时 = #136 前逐位行为", () => {
    const explicit = computeSupersessions([
      { turnId: "t1", timestamp: "2023-05-01T10:00:00", facts: [{ subject: "U", predicate: "hobby", value: "yoga", cardinality: "multi" }] },
      { turnId: "t2", timestamp: "2023-06-01T10:00:00", facts: [{ subject: "U", predicate: "hobby", value: "pilates", cardinality: "multi" }] },
    ]);
    expect(explicit).toEqual([]);

    // 对照：多值事实单独成行时，关掉门控（= #136 前）它照样被失效
    const multiOnly = [
      { turnId: "m1", timestamp: "2023-05-01T10:00:00", facts: [{ subject: "User", predicate: "is considering", value: "a new grocery delivery service" }] },
      { turnId: "m2", timestamp: "2023-06-01T10:00:00", facts: [{ subject: "User", predicate: "is considering", value: "trying Thrive Market" }] },
    ];
    expect(computeSupersessions(multiOnly).map((o) => o.turnId)).toEqual([]);
    expect(computeSupersessions(multiOnly, { cardinalityGate: false }).map((o) => o.turnId)).toEqual(["m1"]);
  });
});

describe("#136 生产写侧内容级门控（supersessionEligibleForContent）", () => {
  const on: WritePolicy = { factKey: { enabled: false, separator: " | ", maxFactChars: 240 }, supersession: { enabled: true } };

  it("单值内容：允许失效（knowledge-update 依赖它）", () => {
    expect(supersessionEligibleForContent("我的 Instagram 粉丝数涨到 1300 了", on)).toBe(true);
  });

  it("多值/模态内容：不失效（新增是 additive）", () => {
    expect(supersessionEligibleForContent("我在考虑换一家生鲜配送", on)).toBe(false);
    expect(supersessionEligibleForContent("我想创建一个私密 Facebook 社群", on)).toBe(false);
  });

  it("无契约线索：缺省允许（保覆盖）；cardinalityDefault=multi 时收紧", () => {
    expect(supersessionEligibleForContent("今天天气不错", on)).toBe(true);
    const strict: WritePolicy = { ...on, supersession: { enabled: true, cardinalityDefault: "multi" } };
    expect(supersessionEligibleForContent("今天天气不错", strict)).toBe(false);
  });

  it("cardinalityGate=false：一律允许（逐位旧行为）", () => {
    const off: WritePolicy = { ...on, supersession: { enabled: true, cardinalityGate: false } };
    expect(supersessionEligibleForContent("我在考虑换一家生鲜配送", off)).toBe(true);
  });
});
