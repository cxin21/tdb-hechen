/**
 * #156（P0）端到端：assistant 轮次的自述行为必须能落到 L1，无信息量寒暄必须不落。
 *
 * 上游单测（prompts/l1-extraction.single-source.test.ts）只锁提示词契约；这里补的是
 * 「提示词 → 真实 extractL1Memories → 落库」这条链，防止再次出现「改结论层/改 routing
 * 却永远抽不出 assistant 记忆」的假修复：
 *  1) 开 selfIdentity 时，真正发给模型的 systemPrompt 里 agent 行为事实块在位，且不再有
 *     旧禁令「AI助手自身的行为或输出」——矛盾信号消失是抽取的前提；
 *  2) assistant 自述行为（type=persona/instruction）能穿过 parse 的 type 门并写进 L1 文件；
 *  3) 无信息量寒暄（模型按新口径输出空数组）= extractedCount/storedCount 0，不落任何行。
 *
 * LLM 用 stub（不触网）：真实模型行为不可单测，可测的是「提示词口径 + 管线把模型输出原样落库」。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractL1Memories } from "./l1-extractor.js";

const OLD_CONTRADICTION = "AI助手自身的行为或输出";

/** assistant 自述行为的一轮对话（user 提问 + assistant 交代自己做了什么）。 */
const ACT_MSGS = [
  { id: "m1", role: "user" as const, content: "L1 提取是不是根本没抽过我的行为？先看看 agent 通道到底通没通。", timestamp: 1_700_000_000_000 },
  { id: "m2", role: "assistant" as const, content: "我把 agent 行为事实块接进了 systemPrompt，并约定以后每次改提示词都同步补契约测试，避免再出现自相矛盾的规则。", timestamp: 1_700_000_000_500 },
];

/** 无信息量寒暄的一轮对话。 */
const GREETING_MSGS = [
  { id: "g1", role: "user" as const, content: "好的，收到。", timestamp: 1_700_000_100_000 },
  { id: "g2", role: "assistant" as const, content: "嗯嗯，随时叫我。", timestamp: 1_700_000_100_500 },
];

const ACT_JSON =
  '[{"scene_name":"修复 L1 提取","message_ids":["m2"],"memories":[{"content":"我约定每次改 L1 提示词都同步补契约测试，防止规则再次自相矛盾","type":"instruction","priority":80}]}]';

function makeLogger() {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => { warns.push(m); },
      error: () => {},
    },
  };
}

async function runExtraction(params: {
  messages: typeof ACT_MSGS;
  raw: string;
  selfIdentity: boolean;
}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1x156-"));
  const { logger } = makeLogger();
  // 只记 taskId=l1-extraction 的调用：抽取成功后还会跟一发 l1-enrich（事实补全），
  // 它是另一个 task，混进来会把「system prompt 长什么样」断言错。
  const seen: Array<{ systemPrompt?: string; prompt?: string }> = [];
  const llmRunner = {
    run: async (args: { systemPrompt?: string; prompt?: string; taskId?: string }) => {
      if (args.taskId === "l1-extraction") {
        seen.push(args);
        return params.raw;
      }
      return "{}";
    },
  } as never;
  try {
    const result = await extractL1Memories({
      messages: params.messages as never,
      sessionKey: "sess-156",
      baseDir,
      config: undefined,
      memoryConfig: { coreMemory: { selfIdentity: { enabled: params.selfIdentity } } } as never,
      options: { enableDedup: false, llmRunner, maxMemoriesPerSession: 10 },
      logger: logger as never,
    });
    // 落库证据：无 storage 时 l1-writer 写 {baseDir}/records/{YYYY-MM-DD}.jsonl
    const recordsDir = path.join(baseDir, "records");
    const persisted = fs.existsSync(recordsDir)
      ? fs
          .readdirSync(recordsDir)
          .flatMap((f) =>
            fs
              .readFileSync(path.join(recordsDir, f), "utf-8")
              .split("\n")
              .filter((l) => l.trim().length > 0)
              .map((l) => JSON.parse(l) as Record<string, unknown>),
          )
      : [];
    return { result, seen, persisted };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

describe("#156 assistant 轮次抽取端到端", () => {
  it("开关开：发给模型的 systemPrompt 含 agent 行为事实块、不含旧禁令", async () => {
    const { seen } = await runExtraction({ messages: ACT_MSGS, raw: ACT_JSON, selfIdentity: true });
    expect(seen).toHaveLength(1);
    const sys = seen[0].systemPrompt ?? "";
    expect(sys).toContain("agent 行为事实");
    expect(sys).toContain("第一人称");
    expect(sys).not.toContain(OLD_CONTRADICTION);
  });

  it("assistant 自述行为能穿过 type 门并落库（type=instruction）", async () => {
    const { result, persisted } = await runExtraction({ messages: ACT_MSGS, raw: ACT_JSON, selfIdentity: true });
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].type).toBe("instruction");
    expect(String(persisted[0].content)).toContain("同步补契约测试");
  });

  it("开关关：systemPrompt 不注入 agent 行为事实块（门控不被修复破坏）", async () => {
    const { seen } = await runExtraction({ messages: ACT_MSGS, raw: ACT_JSON, selfIdentity: false });
    const sys = seen[0].systemPrompt ?? "";
    expect(sys).not.toContain("agent 行为事实");
    expect(sys).not.toContain(OLD_CONTRADICTION);
  });

  it("无信息量寒暄：模型输出空数组 → 不抽、不落库", async () => {
    const { result, persisted, seen } = await runExtraction({ messages: GREETING_MSGS, raw: "[]", selfIdentity: true });
    expect(result.extractedCount).toBe(0);
    expect(result.storedCount).toBe(0);
    expect(persisted).toHaveLength(0);
    // 新口径（寒暄/空泛回复不抽）真的进了提示词，否则模型没依据做这个判断
    expect(seen[0].systemPrompt ?? "").toContain("寒暄");
  });
});
