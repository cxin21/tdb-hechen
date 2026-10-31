/**
 * #122：l1-extractor think 剥离 + l1-empty 原因可观测。
 *
 * 生产实锤：思考型端点把推理写进内联 think，think 里的方括号让贪婪数组正则
 * 锚到错误位置 → 提取恒 0 条，且日志里没有任何「为什么 0 条」的单行原因。
 * 本文件锁三件事：
 *  1) 内联 think 在数组匹配前被剥离（含多段、带属性形态）；截断 think（无闭合）
 *     原样保留，不吞后续正文；
 *  2) parseExtractionResult 返回 {scenes, emptyReason?}，emptyReason 为闭集；
 *  3) 每条 0 条路径恰好一条 l1-empty 单行 warn，带 reason/scenes/inputMsgs。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractL1Memories, parseExtractionResult, stripInlineThink } from "./l1-extractor.js";

const SCENES_JSON =
  '[{"scene_name":"排查断流","message_ids":["m1"],"memories":[{"content":"内联 think 里的方括号会锚错数组正则，剥离 think 后再匹配","type":"episodic","priority":60}]}]';

const MSGS = [
  {
    id: "m1",
    role: "user" as const,
    content: "排查 L1 提取断流：生产端思考型模型返回内联 think，提取恒 0 条且日志没有原因，需要先剥离 think 再匹配数组",
    timestamp: 1_700_000_000_000,
  },
  {
    id: "m2",
    role: "assistant" as const,
    content: "确认根因：内联 think 里的方括号把贪婪数组正则锚错位，需要先剥离 think 再做匹配并补上 l1-empty 原因",
    timestamp: 1_700_000_000_500,
  },
];

function makeWarnLogger() {
  const warns: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => { warns.push(message); },
    error: () => {},
  };
  return { warns, logger };
}

/** 跑一次真实 extractL1Memories（本地临时 baseDir + stub LLMRunner，不触网）。 */
async function runExtraction(raw: string | Error) {
  // 临时目录名**不得**含 `l1-empty`：下面按 `l1-empty reason=` 计行数，路径混进日志会污染计数。
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1x122-"));
  const { warns, logger } = makeWarnLogger();
  const llmRunner = {
    run: async () => {
      if (raw instanceof Error) throw raw;
      return raw;
    },
  } as never;
  try {
    const result = await extractL1Memories({
      messages: MSGS,
      sessionKey: "sess-122",
      baseDir,
      config: undefined,
      options: { enableDedup: false, llmRunner, maxMemoriesPerSession: 10 },
      logger: logger as never,
    });
    return { result, warns };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function l1EmptyLines(warns: string[]): string[] {
  // 只认完整 `l1-empty reason=` 锚：宽松匹配会把无关 warn 误计成 0 条上报
  return warns.filter((w) => w.includes("l1-empty reason="));
}

function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([a-zA-Z]+)=([^\s]+)/g)) out[m[1]] = m[2];
  return out;
}

describe("#122 内联 think 剥离", () => {
  it("think 里含 [ 且后面跟正确 JSON → 仍提取出场景（原状锚错位 0 条）", () => {
    const raw = `<think>用户问的是 [索引] 相关，我需要先想清楚</think>\n${SCENES_JSON}`;
    const out = parseExtractionResult(raw);
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0].scene_name).toBe("排查断流");
    expect(out.emptyReason).toBeUndefined();
  });

  it("多段 think 全部剥离（g 标志），只留 JSON", () => {
    const raw = `<think>第一段 [a]</think>中间说明\n<think>第二段 [b]</think>\n${SCENES_JSON}`;
    expect(stripInlineThink(raw)).toBe(`中间说明\n\n${SCENES_JSON}`);
    expect(parseExtractionResult(raw).scenes).toHaveLength(1);
  });

  it("截断 think（无闭合标签）原样保留，不吞后续正文", () => {
    const truncated = "<think>推理写到一半就断了，这里没有闭合标签";
    expect(stripInlineThink(truncated)).toBe(truncated);
    const raw = `${truncated}\n${SCENES_JSON}`;
    expect(stripInlineThink(raw)).toBe(raw);
    // 未剥离，但数组锚仍能落到真正的 JSON 上 → 后续内容没被吞
    expect(parseExtractionResult(raw).scenes).toHaveLength(1);
  });

  it("截断 think 里带方括号时：不吞正文，退化成可观测的 parse_fail（不再静默 0 条）", () => {
    const out = parseExtractionResult(`<think>推理写到一半 [锚点 还没闭合\n${SCENES_JSON}`);
    expect(out.scenes).toHaveLength(0);
    expect(out.emptyReason).toBe("parse_fail");
  });

  it("带属性的 think 形态同样剥离；<thinking> 不是 think，不动它", () => {
    expect(stripInlineThink(`<think type="reasoning">[x]</think>${SCENES_JSON}`)).toBe(SCENES_JSON);
    const thinking = `<thinking>[x]</thinking>${SCENES_JSON}`;
    expect(stripInlineThink(thinking)).toBe(thinking);
  });
});

describe("#122 emptyReason 闭集（parse 层）", () => {
  it("空数组 → empty_scenes", () => {
    expect(parseExtractionResult("[]")).toEqual({ scenes: [], emptyReason: "empty_scenes" });
  });

  it("完全非 JSON 文本 → no_json", () => {
    expect(parseExtractionResult("抱歉，我无法按要求输出。").emptyReason).toBe("no_json");
  });

  it("顶层是 JSON 但不是数组 → not_array（此前一律误报 no_json）", () => {
    expect(parseExtractionResult('{"scene_name":"情境一"}').emptyReason).toBe("not_array");
  });

  it("疑似数组但无法解析且无可抢救 → parse_fail", () => {
    expect(parseExtractionResult("[这里不是 JSON]").emptyReason).toBe("parse_fail");
  });

  it("正常提取 → 无 emptyReason", () => {
    const out = parseExtractionResult(SCENES_JSON);
    expect(out.scenes).toHaveLength(1);
    expect(out.emptyReason).toBeUndefined();
  });
});

describe("#122 每条 0 条路径恰好一条 l1-empty 单行 warn", () => {
  const cases: Array<{ name: string; raw: string | Error; reason: string; scenes: string; success: boolean }> = [
    { name: "llm_error", raw: new Error("endpoint 500"), reason: "llm_error", scenes: "0", success: false },
    { name: "no_json", raw: "抱歉，我无法按要求输出。", reason: "no_json", scenes: "0", success: true },
    { name: "not_array", raw: '{"scene_name":"情境一"}', reason: "not_array", scenes: "0", success: true },
    { name: "parse_fail", raw: "[这里不是 JSON]", reason: "parse_fail", scenes: "0", success: true },
    { name: "empty_scenes", raw: "[]", reason: "empty_scenes", scenes: "0", success: true },
    {
      name: "normalized_all_dropped",
      raw: '[{"scene_name":"情境","message_ids":["m1"],"memories":[{"content":"","type":"episodic","priority":50}]}]',
      reason: "normalized_all_dropped",
      scenes: "1",
      success: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → reason=${c.reason}`, async () => {
      const { result, warns } = await runExtraction(c.raw);
      const lines = l1EmptyLines(warns);
      expect(lines).toHaveLength(1);
      const f = fields(lines[0]);
      expect(f.reason).toBe(c.reason);
      expect(f.sessionKey).toBe("sess-122");
      expect(f.scenes).toBe(c.scenes);
      expect(f.inputMsgs).toBe(String(MSGS.length));
      expect(lines[0]).not.toContain("\n");
      expect(result.success).toBe(c.success);
      expect(result.extractedCount).toBe(0);
    });
  }

  it("正常提取路径不出现 l1-empty", async () => {
    const raw = `<think>先想一下 [锚点]</think>\n${SCENES_JSON}`;
    const { result, warns } = await runExtraction(raw);
    expect(result.extractedCount).toBe(1);
    expect(l1EmptyLines(warns)).toHaveLength(0);
  });
});
