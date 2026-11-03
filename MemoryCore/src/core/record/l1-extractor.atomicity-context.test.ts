/**
 * A3 接线端到端（2026-11-02）：prompt 参数化 + agent 自述标注必须真的从 memoryConfig
 * 穿到「发给模型的 systemPrompt」与「落库记录的 metadata」——只测纯函数会漏掉接线。
 *
 * 纪律：LLM 用 stub（不触网）；baseDir 走 mkdtemp 临时目录；缺省档必须与今天逐位一致。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractL1Memories } from "./l1-extractor.js";

const MSGS = [
  {
    id: "m1",
    role: "user" as const,
    content: "把 L1 原子性红线调宽一点，顺便看看 agent 自述怎么标。",
    timestamp: 1_700_000_000_000,
  },
  {
    id: "m2",
    role: "assistant" as const,
    content: "我把两处 300 字硬编码改成参数，并约定以后先写失败用例再改实现。",
    timestamp: 1_700_000_000_500,
  },
];

const AGENT_JSON =
  '[{"scene_name":"A3 校准","message_ids":["m2"],"memories":[{"content":"我约定每次改 L1 提示词都先补失败用例，再最小实现到绿","type":"instruction","priority":80,"metadata":{"subject":"交付纪律"}}]}]';

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

async function run(params: { memoryConfig?: unknown; raw?: string }) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1a3-"));
  const seen: Array<{ systemPrompt?: string }> = [];
  const llmRunner = {
    run: async (args: { systemPrompt?: string; prompt?: string; taskId?: string }) => {
      if (args.taskId === "l1-extraction") {
        seen.push(args);
        return params.raw ?? AGENT_JSON;
      }
      // l1-enrich 等旁路任务：返回空对象即可
      return "{}";
    },
  } as never;
  try {
    const result = await extractL1Memories({
      messages: MSGS as never,
      sessionKey: "sess-a3",
      baseDir,
      memoryConfig: params.memoryConfig as never,
      options: { enableDedup: false, llmRunner, maxMemoriesPerSession: 10 },
      logger: makeLogger() as never,
    });
    const recordsDir = path.join(baseDir, "records");
    const persisted = fs.existsSync(recordsDir)
      ? fs.readdirSync(recordsDir).flatMap((f) =>
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

describe("A3 接线：memoryConfig.extraction → systemPrompt / metadata", () => {
  it("缺省（无 extraction 配置）：systemPrompt 仍是 300 字红线、无改写断言", async () => {
    const { seen } = await run({});
    const sys = seen[0]?.systemPrompt ?? "";
    expect(sys).toContain("超过 300 字");
    expect(sys).not.toContain("可验证断言");
  });

  it("atomicMaxChars=600 + atomicityRewrite=true：两处文案都由配置驱动", async () => {
    const { seen } = await run({
      memoryConfig: { extraction: { atomicMaxChars: 600, atomicityRewrite: true } },
    });
    const sys = seen[0]?.systemPrompt ?? "";
    expect(sys).toContain("超过 600 字");
    expect(sys).not.toContain("超过 300 字");
    expect(sys).toContain("可验证断言");
    expect(sys).not.toContain("一条记忆只记一件事");
  });

  it("actorTagging 开：agent 自述行落库时 metadata.actor=agent（原有 metadata 键保留）", async () => {
    const { result, persisted } = await run({
      memoryConfig: { extraction: { actorTagging: true } },
    });
    expect(result.storedCount).toBe(1);
    const md = (persisted[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(md.actor).toBe("agent");
    expect(md.subject).toBe("交付纪律");
  });

  it("actorTagging 缺省关：metadata 不含 actor（字节形态不变）", async () => {
    const { persisted } = await run({});
    expect(persisted).toHaveLength(1);
    const md = (persisted[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(md, "actor")).toBe(false);
    expect(md.subject).toBe("交付纪律");
  });
});
