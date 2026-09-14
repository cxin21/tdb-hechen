/**
 * 审查修补 I②（跨链路防重）· TdaiL1RecallInjector 标记跳过单测。
 *
 * 背景：TdaiL1RecallInjector 走内核 /v3/atomic/search（"自有 + 借入"合并 top-K），
 * **不是** MemoryCore 的 R7 九通道分层链路，两链路间原无防重——同一部署若同时启用
 * （MemoryProxy tdai.memory.recallL1=true 且 MemoryCore recall.enabled=true），同一轮
 * 用户消息可能被双重注入 L1 记忆。
 *
 * 最小防线：当轮用户消息已含 MemoryCore 注入块固定标记头 <relevant-memories> →
 * 本注入器退出（零注入）。MemoryCore 链路未部署时标记恒不出现 → 行为零变化。
 */
import { describe, expect, it, vi } from "vitest";
import { TdaiL1RecallInjector } from "../tdai-l1-recall-injector.js";
import type { ContextMessage } from "../../types.js";
import type { TdaiClient } from "../../../tdai/client.js";
import { log } from "../../../report/log.js";

const SESSION = {
  session_id: "sA",
  team_id: "teamA",
  user_id: "userA",
  agent_id: "agentA",
  space_id: "",
  user_key: "ukA",
};

function userMsg(text: string): ContextMessage {
  return { role: "user", blocks: [{ type: "text", content: text }] };
}

function makeCtx(userText: string) {
  return {
    messages: [
      { role: "system", blocks: [{ type: "text", content: "sys" }] } as ContextMessage,
      userMsg(userText),
    ],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic" as const,
      traceId: "t",
      keyId: "k",
      modelId: "m",
      stream: false,
      agentSource: "claude-code",
      custom: { session: SESSION, userKey: SESSION.user_key },
    },
  };
}

function makeInjector() {
  const searchL1ForCtx = vi.fn(async () => [
    { type: "episodic", content: "R7FIX 记忆条目甲", score: 0.9 },
  ]);
  const injector = new TdaiL1RecallInjector(
    { searchL1ForCtx } as unknown as TdaiClient,
    null,
  );
  return { injector, searchL1ForCtx };
}

describe("审查修补 I② · 跨链路防重标记跳过（<relevant-memories> 在场 → 退出）", () => {
  it("当轮用户消息已含 MemoryCore 注入标记 → 零注入且不触发内核召回", async () => {
    const { injector, searchL1ForCtx } = makeInjector();
    const ctx = makeCtx(
      "<relevant-memories>\n- [结论|场景A] MemoryCore 链路注入的结论行\n</relevant-memories>\n召回专项最近有什么新进展",
    );
    const blocks = await injector.execute(ctx);
    expect(blocks).toEqual([]);
    expect(searchL1ForCtx).not.toHaveBeenCalled();
  });

  it("标记不在场 → 正常注入（防误伤：MemoryCore 链路未部署时行为零变化）", async () => {
    const { injector, searchL1ForCtx } = makeInjector();
    const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("<tdai_recalled_l1_memories>");
    expect(blocks[0].content).toContain("R7FIX 记忆条目甲");
    expect(searchL1ForCtx).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════ DS-RECALL-MERGE-001 · 合并召回瘦传输链路 ═══════════════

describe("DS-RECALL-MERGE-001 · TdaiL1RecallInjector /v3/recall 瘦传输", () => {
  const MERGE_BLOCK = "<relevant-memories>\n- [结论|合并召回] 核心组装块行甲\n- [episodic] 经验行乙\n</relevant-memories>";

  function makeMergeInjector(opts: {
    recallBlock?: () => Promise<{ block: string; meta: Record<string, unknown> } | null>;
    legacyItems?: Array<{ type: string; content: string; score: number }>;
  }) {
    const recallBlockForCtx = vi.fn(opts.recallBlock ?? (async () => ({
      block: MERGE_BLOCK,
      meta: { conclusionCount: 1, experienceCount: 1, sessionReused: false, layered: true },
    })));
    const searchL1ForCtx = vi.fn(async () => opts.legacyItems ?? [
      { type: "episodic", content: "R7FIX 记忆条目甲", score: 0.9 },
    ]);
    const injector = new TdaiL1RecallInjector(
      { recallBlockForCtx, searchL1ForCtx } as unknown as TdaiClient,
      null,
    );
    return { injector, recallBlockForCtx, searchL1ForCtx };
  }

  it("新链路：/v3/recall 成功 → block 直接前插（零组装），不走旧路", async () => {
    const { injector, recallBlockForCtx, searchL1ForCtx } = makeMergeInjector({});
    const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    expect(searchL1ForCtx).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe(MERGE_BLOCK);
    expect(blocks[0].metadata?.source).toBe("tdai-l1-recall-injector");
  });

  it("降级路：/v3/recall 5xx/超时 → 退回旧路组装 + loud 日志（防静默降级）", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const { injector, recallBlockForCtx, searchL1ForCtx } = makeMergeInjector({
        recallBlock: async () => {
          throw new Error("/v3/recall http 500");
        },
      });
      const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
      expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
      expect(searchL1ForCtx).toHaveBeenCalledTimes(1);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain("<tdai_recalled_l1_memories>");
      expect(blocks[0].content).toContain("R7FIX 记忆条目甲");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("/v3/recall");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("500");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("降级路：404（核心端点 enabled=false）→ 同样退回旧路（输出与现状逐位一致）", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const { injector, searchL1ForCtx } = makeMergeInjector({
        recallBlock: async () => {
          throw new Error("/v3/recall http 404");
        },
      });
      const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
      expect(searchL1ForCtx).toHaveBeenCalledTimes(1);
      expect(blocks[0].content).toContain("<tdai_recalled_l1_memories>");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("recallL1=false → 零注入不变（不降级、零网络调用语义由 client 层保证）", async () => {
    const { injector, recallBlockForCtx, searchL1ForCtx } = makeMergeInjector({
      recallBlock: async () => null,
    });
    const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
    expect(blocks).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    expect(searchL1ForCtx).not.toHaveBeenCalled();
  });

  it("核心 block 空（无命中）→ 零注入（不算失败、不降级旧路）", async () => {
    const { injector, searchL1ForCtx } = makeMergeInjector({
      recallBlock: async () => ({
        block: "",
        meta: { conclusionCount: 0, experienceCount: 0, sessionReused: false, layered: false },
      }),
    });
    const blocks = await injector.execute(makeCtx("召回专项最近有什么新进展"));
    expect(blocks).toEqual([]);
    expect(searchL1ForCtx).not.toHaveBeenCalled();
  });
});
