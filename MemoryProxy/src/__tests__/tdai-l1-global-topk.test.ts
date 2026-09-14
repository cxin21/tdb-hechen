/**
 * R7 复审 Minor ③ · globalTopK 配置化（tdai.memory.l1GlobalTopK，缺省 5 = 现行为不变）。
 *
 * 背景：TdaiL1RecallInjector 的"自有 + 借入"合并 top-K 原为装配处硬编码 5
 * （injection/index.ts `new TdaiL1RecallInjector(l1Client, cfg, undefined, 5, l1Client)`）。
 * 本组断言：① 缺省（DEFAULT_CONFIG / yaml 未配置该键）= 5，行为零变化；
 * ② yaml 显式覆盖生效（config.ts 解析 → 类型 → 装配消费链）；
 * ③ 注入器端显式传入 globalTopK 时合并截断按该值生效（消费端契约）。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, buildConfig } from "../config.js";
import { TdaiL1RecallInjector } from "../injection/injectors/tdai-l1-recall-injector.js";
import type { ContextMessage } from "../injection/types.js";
import type { TdaiClient } from "../tdai/client.js";

function withTempYaml(yamlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "l1topk-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, yamlText, "utf-8");
  return file;
}

function cleanup(file: string): void {
  rmSync(file, { force: true });
  rmSync(join(file, ".."), { recursive: true, force: true });
}

describe("R7 Minor ③ · tdai.memory.l1GlobalTopK 配置化", () => {
  it("缺省：DEFAULT_CONFIG.tdai.memory.l1GlobalTopK = 5（现行为不变）", () => {
    expect(DEFAULT_CONFIG.tdai.memory.l1GlobalTopK).toBe(5);
  });

  it("缺省：yaml 未配置该键 → buildConfig 解析为 5（零变化兜底）", () => {
    const file = withTempYaml(
      [
        "server:",
        "  port: 3100",
        "tdai:",
        "  enabled: true",
        "  memory:",
        "    enabled: true",
        "    recallL1: true",
      ].join("\n"),
    );
    try {
      const cfg = buildConfig({ configFile: file });
      expect(cfg.tdai.memory.l1GlobalTopK).toBe(5);
    } finally {
      cleanup(file);
    }
  });

  it("显式覆盖：yaml 配置 l1GlobalTopK: 7 → buildConfig 解析为 7", () => {
    const file = withTempYaml(
      [
        "server:",
        "  port: 3100",
        "tdai:",
        "  enabled: true",
        "  memory:",
        "    enabled: true",
        "    recallL1: true",
        "    l1GlobalTopK: 7",
      ].join("\n"),
    );
    try {
      const cfg = buildConfig({ configFile: file });
      expect(cfg.tdai.memory.l1GlobalTopK).toBe(7);
    } finally {
      cleanup(file);
    }
  });

  it("消费端契约：注入器显式 globalTopK=2 → 3 条合并命中只注入 2 条", async () => {
    const searchL1ForCtx = vi.fn(async () => [
      { type: "episodic", content: "条目一", score: 0.9 },
      { type: "episodic", content: "条目二", score: 0.8 },
      { type: "episodic", content: "条目三", score: 0.7 },
    ]);
    const injector = new TdaiL1RecallInjector(
      { searchL1ForCtx } as unknown as TdaiClient,
      null,
      undefined,
      2,
    );
    const ctx = {
      messages: [
        { role: "user", blocks: [{ type: "text", content: "查一下" }] },
      ] as ContextMessage[],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic" as const,
        traceId: "t",
        keyId: "k",
        modelId: "m",
        stream: false,
        agentSource: "claude-code",
        custom: {
          session: {
            session_id: "sA",
            team_id: "teamA",
            user_id: "userA",
            agent_id: "agentA",
            space_id: "",
            user_key: "ukA",
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const blocks = await injector.execute(ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("条目一");
    expect(blocks[0].content).toContain("条目二");
    expect(blocks[0].content).not.toContain("条目三");
  });
});
