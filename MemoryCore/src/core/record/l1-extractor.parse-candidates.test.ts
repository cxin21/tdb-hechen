/**
 * P1-B W1（2026-11-10）：L1 候选解析容错——替换单次贪婪锚 /\[[\s\S]*\]/。
 *
 * 锁两件事：
 *  1) 生产实测两类 parse_fail（rawLen 取自 l1-debug PARSE_FAIL dump）不再误报：
 *     - rawLen=19 原样样本（见下方 RAW_19，双 fenced 空数组）：
 *       贪婪锚会跨围栏拼成一个不可解析片段 → 整批 parse_fail；候选解析后
 *       两段各自是合法空数组 → 真 0 条，报 empty_scenes。
 *     - rawLen=3943 截断尾：围栏内数组被 maxTokens 砍尾，贪婪锚把字符串里的 ']'
 *       当数组结尾 → 截取错位整批丢。原样全文太长，本文件按「前缀截断」构造等价样本：
 *       完整骨架 "[" + 场景一 + "," + 场景二（长 content）+ "]"，`full.slice(0, 3943)`
 *       取前缀，断在场景二字符串中间 → 场景一必须被救回。
 *  2) 候选生成/试解顺序：围栏段优先、括号平衡扫描（字符串内的括号不计数）、
 *     断尾段仍走 salvageTruncatedJsonArray；全坏仍报 parse_fail（reason 枚举不变）。
 */
import { describe, expect, it } from "vitest";
import { makeJsonCandidates, parseExtractionResult, tryParseCandidates } from "./l1-extractor.js";

const FENCE = "```";

const SCENE = (name: string, content: string, mid = "m1") =>
  JSON.stringify([{ scene_name: name, message_ids: [mid], memories: [{ content, type: "episodic", priority: 80 }] }]);

/** 生产实测原样 raw（rawLen=19）：双 fenced 空数组。 */
const RAW_19 = "[]\n\n" + FENCE + "json\n[]\n\n" + FENCE;

/**
 * 生产实测形制（rawLen=3943）：前缀截断样本。
 * 构造方式：场景一段 + 场景二段（content 用长串撑到 3943 之后）拼成合法 JSON，
 * 再 slice(0, 3943) —— 断点落在场景二 content 字符串内部，等价于 maxTokens 砍尾。
 * 旧实现：贪婪锚跨到字符串内的 ']' → 截取错位 → parse_fail（整批 0 条）。
 */
function buildTruncated3943(): string {
  const s1 = JSON.stringify({
    scene_name: "情境一",
    message_ids: ["m1"],
    memories: [{ content: "甲记忆", type: "episodic", priority: 80 }],
  });
  const s2 = JSON.stringify({
    scene_name: "情境二",
    message_ids: ["m2"],
    memories: [{ content: "乙记忆" + "x".repeat(6000), type: "persona", priority: 70 }],
  });
  return `[${s1},${s2}]`.slice(0, 3943);
}

describe("W1 实测两类 parse_fail 原样样本", () => {
  it("rawLen=19 双 fenced 空数组 → 不再 parse_fail，报 empty_scenes（真 0 条）", () => {
    expect(RAW_19).toHaveLength(19);
    const out = parseExtractionResult(RAW_19);
    expect(out.scenes).toEqual([]);
    expect(out.emptyReason).toBe("empty_scenes");
  });

  it("rawLen=3943 截断尾 → 救回第一个完整场景（旧实现整批丢）", () => {
    const raw = buildTruncated3943();
    expect(raw).toHaveLength(3943);
    const out = parseExtractionResult(raw);
    expect(out.emptyReason).toBeUndefined();
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0].scene_name).toBe("情境一");
    expect(out.scenes[0].memories[0].content).toBe("甲记忆");
  });
});

describe("W1 候选序列解析", () => {
  it("多个 fenced 块：空块在前也取到后面的非空块", () => {
    const raw = ["前情提要", FENCE + "json", "[]", FENCE, "", FENCE + "json", SCENE("情境二", "乙记忆", "m2"), FENCE].join(
      "\n",
    );
    const out = parseExtractionResult(raw);
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0].scene_name).toBe("情境二");
  });

  it("多个候选按出现顺序取第一个非空数组", () => {
    const raw = `说明 [{"scene_name":"甲"}] 补充 [{"scene_name":"乙"}]`;
    expect(makeJsonCandidates(raw)).toEqual(['[{"scene_name":"甲"}]', '[{"scene_name":"乙"}]']);
    expect(parseExtractionResult(raw).scenes[0].scene_name).toBe("甲");
  });

  it("纯标量数组不算命中：跳过 [1] 取后面真有场景的候选（scenes 非空口径）", () => {
    const raw = [FENCE + "json", "[1]", FENCE, "", FENCE + "json", SCENE("情境三", "丙记忆", "m3"), FENCE].join("\n");
    expect(makeJsonCandidates(raw)).toEqual(["[1]", SCENE("情境三", "丙记忆", "m3")]);
    expect(parseExtractionResult(raw).scenes[0].scene_name).toBe("情境三");
  });

  it("字符串字面量里的 ']' 不参与深度计数（不会截断候选）", () => {
    const raw =
      '[{"scene_name":"情境","message_ids":["m1"],"memories":[{"content":"看到 [1] 号日志","type":"episodic","priority":50}]}]';
    const candidates = makeJsonCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toBe(raw);
    expect(parseExtractionResult(raw).scenes).toHaveLength(1);
  });

  it("断尾段整段进候选（交给 salvage），fenced 内容优先", () => {
    const raw = ["前情提要", FENCE + "json", '[{"scene_name":"甲"', FENCE].join("\n");
    const candidates = makeJsonCandidates(raw);
    expect(candidates[0]).toBe('[{"scene_name":"甲"\n');
    expect(candidates).toHaveLength(1);
  });

  it("无 '[' 时零候选（no_json / not_array 分支不受影响）", () => {
    expect(makeJsonCandidates("抱歉，我无法按要求输出。")).toEqual([]);
    expect(makeJsonCandidates('{"scene_name":"情境一"}')).toEqual([]);
  });

  it("全坏（围栏内也解析不了、无可抢救对象）→ 仍 parse_fail", () => {
    const raw = ["前情提要", FENCE + "json", "[{这里不是 JSON", FENCE].join("\n");
    expect(parseExtractionResult(raw).emptyReason).toBe("parse_fail");
    expect(parseExtractionResult("[这里不是 JSON]").emptyReason).toBe("parse_fail");
  });
});

describe("W1 tryParseCandidates 契约", () => {
  it("空候选 → null（调用方报 no_json/not_array）", () => {
    expect(tryParseCandidates([])).toBeNull();
  });

  it("跳过空数组取非空；全空数组退化返回第一个（→ empty_scenes）", () => {
    const picked = tryParseCandidates(["[]", '[{"scene_name":"甲"}]']);
    expect(picked?.parsed).toHaveLength(1);
    const emptyOnly = tryParseCandidates(["[]", "[ ]"]);
    expect(emptyOnly?.parsed).toEqual([]);
    expect(parseExtractionResult("[]").emptyReason).toBe("empty_scenes");
  });

  it("repair 通道：priority 裸标识符仍被修好（旧行为不回退）", () => {
    const raw =
      '[{"scene_name":"情境","message_ids":["m1"],"memories":[{"content":"甲","type":"episodic","priority": sheet}]}]';
    expect(parseExtractionResult(raw).scenes).toHaveLength(1);
  });
});
