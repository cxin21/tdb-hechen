import { describe, it, expect } from "vitest";
import { parseExtractionResult } from "./l1-extractor.js";

/**
 * R1 调用链契约测试（2026-10-06 审计轮）：
 *  - P0-1 截断抢救：输出被 maxTokens 砍尾时前缀里已闭合的情境不丢
 *  - P0-3 chat 跨类型门：work_* 在 chat 模式被拒（提示词枚举门双保险）
 *  - P0-3 范围钳制：priority/valence/arousal/significance 越界值裁剪
 *  - P2 occurred_at 空串归 undefined（下游 falsy 口径统一）
 */

const scene = (mems: object[], name = "测试情境") =>
  JSON.stringify([{ scene_name: name, message_ids: ["m1"], memories: mems }]);

describe("P0-1 截断抢救", () => {
  const s1 = JSON.stringify({
    scene_name: "情境一",
    message_ids: ["m1"],
    memories: [{ content: "甲记忆", type: "episodic", priority: 80 }],
  });
  const s2 = JSON.stringify({
    scene_name: "情境二",
    message_ids: ["m2"],
    memories: [{ content: "乙记忆", type: "persona", priority: 70 }],
  });

  it("输出在第二条记忆中被砍尾 → 抢救出第一个完整情境（原状=整批丢失）", () => {
    const full = `[${s1},${s2}]`;
    const truncated = full.slice(0, full.lastIndexOf("乙记忆"));
    const scenes = parseExtractionResult(truncated, undefined, [], { promptMode: "chat" });
    expect(scenes.length).toBe(1);
    expect(scenes[0].scene_name).toBe("情境一");
    expect(scenes[0].memories.length).toBe(1);
    expect(scenes[0].memories[0].content).toBe("甲记忆");
  });

  it("完全非 JSON 的文本仍返回空数组", () => {
    expect(parseExtractionResult("抱歉，我无法完成提取。", undefined, [], { promptMode: "chat" })).toEqual([]);
  });

  it("第一条记忆就被截断（无完整情境）→ 返回空数组（无可抢救）", () => {
    const full = `[${s1},${s2}]`;
    const truncated = full.slice(0, full.indexOf("甲记忆") + 1);
    expect(parseExtractionResult(truncated, undefined, [], { promptMode: "chat" })).toEqual([]);
  });
});

describe("P0-3 chat 跨类型门", () => {
  const raw = scene([{ content: "工作事实一条", type: "work_fact", priority: 75 }]);

  it("promptMode=chat：work_* 被拒（枚举门外泄双保险）", () => {
    const scenes = parseExtractionResult(raw, undefined, [], { promptMode: "chat" });
    expect(scenes.length).toBe(1);
    expect(scenes[0].memories.length).toBe(0);
  });

  it("promptMode=code：work_* 放行", () => {
    const scenes = parseExtractionResult(raw, undefined, [], { promptMode: "code" });
    expect(scenes[0].memories.length).toBe(1);
  });

  it("未传 opts：保持既有口径不门（向后兼容）", () => {
    expect(parseExtractionResult(raw, undefined, [])[0].memories.length).toBe(1);
  });

  it("promptMode=chat：persona/episodic/instruction 放行；legacy 别名不误杀（parse 忠实保留，别名归一在下游 flatten normalizeType）", () => {
    const raw2 = scene([
      { content: "A", type: "persona", priority: 60 },
      { content: "B", type: "episode", priority: 60 },
    ]);
    const scenes = parseExtractionResult(raw2, undefined, [], { promptMode: "chat" });
    expect(scenes[0].memories.length).toBe(2);
    expect(scenes[0].memories[1].type).toBe("episode");
  });
});

describe("P0-3 范围钳制", () => {
  it("priority/valence/arousal/significance 越界被裁剪", () => {
    const raw = scene([
      { content: "X", type: "episodic", priority: 150, valence: -5, arousal: 2, significance: 9 },
    ]);
    const m = parseExtractionResult(raw, undefined, [])[0].memories[0];
    expect(m.priority).toBe(100);
    expect(m.valence).toBe(-1);
    expect(m.arousal).toBe(1);
    expect(m.significance).toBe(1);
  });

  it("priority 负值裁到 -1；缺省仍 50；合法值不动", () => {
    const rawNeg = scene([{ content: "Y", type: "episodic", priority: -20 }]);
    expect(parseExtractionResult(rawNeg, undefined, [])[0].memories[0].priority).toBe(-1);

    const rawMissing = scene([{ content: "Z", type: "episodic" }]);
    expect(parseExtractionResult(rawMissing, undefined, [])[0].memories[0].priority).toBe(50);

    const rawOk = scene([{ content: "W", type: "episodic", priority: 85, valence: -0.4, arousal: 0.6 }]);
    const m = parseExtractionResult(rawOk, undefined, [])[0].memories[0];
    expect(m.priority).toBe(85);
    expect(m.valence).toBe(-0.4);
    expect(m.arousal).toBe(0.6);
  });
});

describe("P2 occurred_at 空串归一", () => {
  it("空串 → undefined（下游 falsy 判 missing 口径统一）", () => {
    const raw = scene([{ content: "W", type: "episodic", occurred_at: "" }]);
    expect(parseExtractionResult(raw, undefined, [])[0].memories[0].occurred_at).toBeUndefined();
  });

  it("合法 ISO 串原样保留", () => {
    const raw = scene([
      { content: "W", type: "episodic", occurred_at: "2026-09-05T03:00:00.000Z" },
    ]);
    expect(parseExtractionResult(raw, undefined, [])[0].memories[0].occurred_at).toBe(
      "2026-09-05T03:00:00.000Z",
    );
  });
});
