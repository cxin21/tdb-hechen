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
import type { AgentTool, ContextMessage } from "../../types.js";
import type { FixedAssetCtx } from "../tdai-fixed-asset.js";
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

// ═══════════════ #40（ADR0003-P3 接线票 B）· capabilities 策展与 self-only 携带 ═══════════════

describe("#40 · TdaiL1RecallInjector capabilities 策展（self-only 携带）", () => {
  const CAP_LINES = ["t1：能力一", "t2：能力二"];
  const TOOLS: AgentTool[] = [
    { name: "t1", description: "能力一", parameters: {} },
    { name: "t2", description: "能力二", parameters: {} },
  ];
  const SELF: FixedAssetCtx = {
    teamId: "teamA", userId: "userA", agentId: "agentA", agentName: "agentA", isSelf: true,
  };
  const BORROWED: FixedAssetCtx = {
    teamId: "teamA", userId: "userA", agentId: "agentB", agentName: "agentB", isSelf: false,
  };

  /** 在 makeCtx 基础上携带工具面与（可选）fixed-asset ctx 缓存（借入 ctx 测试缝，绕过控制面）。 */
  function makeToolsCtx(userText: string, tools: AgentTool[], fixedAssetCtxs?: FixedAssetCtx[]) {
    const base = makeCtx(userText) as Parameters<TdaiL1RecallInjector["execute"]>[0];
    base.tools = tools;
    if (fixedAssetCtxs) {
      (base.metadata.custom as Record<string, unknown>).__tdaiFixedAssetCtxs = fixedAssetCtxs;
    }
    return base;
  }

  /** 本 describe 专用假 client（makeMergeInjector 为上 describe 局部，不跨块复用）。 */
  function makeCapInjector() {
    const recallBlockForCtx = vi.fn(async () => ({
      block: "<relevant-memories>\n- [结论|合并召回] 核心组装块行甲\n</relevant-memories>",
      meta: { conclusionCount: 1, experienceCount: 1, sessionReused: false, layered: true },
    }));
    const injector = new TdaiL1RecallInjector({ recallBlockForCtx } as unknown as TdaiClient, null);
    return { injector, recallBlockForCtx };
  }

  it("self ctx：tools 非空 → recallBlockForCtx 第 6 参携带策展清单（≤5 行模板直出）", async () => {
    const { injector, recallBlockForCtx } = makeCapInjector();
    await injector.execute(makeToolsCtx("召回专项最近有什么新进展", TOOLS));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    const args = recallBlockForCtx.mock.calls[0] as unknown[];
    expect(args[5]).toEqual(CAP_LINES);
  });

  it("借入 ctx：不携带 capabilities（他人身份不混当前 agent 能力）", async () => {
    const { injector, recallBlockForCtx } = makeCapInjector();
    await injector.execute(makeToolsCtx("召回专项最近有什么新进展", TOOLS, [SELF, BORROWED]));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
    const calls = recallBlockForCtx.mock.calls as unknown as unknown[][];
    const selfCall = calls.find((c) => (c[0] as { agentId: string }).agentId === "agentA");
    const borrowedCall = calls.find((c) => (c[0] as { agentId: string }).agentId === "agentB");
    expect(selfCall?.[5]).toEqual(CAP_LINES);
    expect(borrowedCall?.[5]).toBeUndefined();
  });

  it("tools 为空 → 第 6 参 undefined（请求体不带 capabilities=逐位现状）", async () => {
    const { injector, recallBlockForCtx } = makeCapInjector();
    await injector.execute(makeToolsCtx("召回专项最近有什么新进展", []));
    const args = recallBlockForCtx.mock.calls[0] as unknown[];
    expect(args[5]).toBeUndefined();
  });

  // ═══ #40-B（ADR0003 派生票 B）：config lines 显式数据源通道（构造第 6 参透传）═══

  /** #40-B 专用：构造第 6 参携带 config 能力策展行（injection.toolCapabilities.lines）。 */
  function makeCapInjectorWithLines(lines: readonly string[] | undefined) {
    const recallBlockForCtx = vi.fn(async () => ({
      block: "<relevant-memories>\n- [结论|合并召回] 核心组装块行甲\n</relevant-memories>",
      meta: { conclusionCount: 1, experienceCount: 1, sessionReused: false, layered: true },
    }));
    const injector = new TdaiL1RecallInjector(
      { recallBlockForCtx } as unknown as TdaiClient,
      null,
      undefined,
      5,
      null,
      lines,
    );
    return { injector, recallBlockForCtx };
  }

  it("#40-B：构造携带 config lines → 第 6 参逐字携带 lines（工具面不参与策展）", async () => {
    const { injector, recallBlockForCtx } = makeCapInjectorWithLines(["行甲：能力甲", "行乙：能力乙"]);
    await injector.execute(makeToolsCtx("召回专项最近有什么新进展", TOOLS));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    const args = recallBlockForCtx.mock.calls[0] as unknown[];
    expect(args[5]).toEqual(["行甲：能力甲", "行乙：能力乙"]);
  });

  it("#40-B：构造 lines 缺省 → 第 6 参=运行时策展（现状逐位）", async () => {
    const { injector, recallBlockForCtx } = makeCapInjectorWithLines(undefined);
    await injector.execute(makeToolsCtx("召回专项最近有什么新进展", TOOLS));
    const args = recallBlockForCtx.mock.calls[0] as unknown[];
    expect(args[5]).toEqual(CAP_LINES);
  });
});

// ═══════════════ #87 · 同意图只自动召回一次（会话级 intent 指纹闸） ═══════════════

describe("#87 · TdaiL1RecallInjector 同意图去重闸（仅 intent 档）", () => {
  const INTENT = "不要影子规则，直接完整实现";
  const MERGE_BLOCK_87 = "<relevant-memories>\n- [结论|#87] 去重闸测试块\n</relevant-memories>";

  /** intent 档 ctx：metadata.sessionKey + custom.tdaiTurnContext.turnIntent 定源。 */
  function makeIntentCtx(sessionKey: string, intent: string) {
    const base = makeCtx("占位：intent 档 query 由 turnIntent 提供") as Parameters<TdaiL1RecallInjector["execute"]>[0];
    base.metadata.sessionKey = sessionKey;
    (base.metadata.custom as Record<string, unknown>).tdaiTurnContext = {
      turnIntent: { classification: "real", text: intent },
      classified: [],
    };
    return base;
  }

  function makeDedupInjector(dedup: boolean, recallBlock?: () => Promise<{ block: string; meta: Record<string, unknown> } | null>) {
    const recallBlockForCtx = vi.fn(recallBlock ?? (async () => ({
      block: MERGE_BLOCK_87,
      meta: { conclusionCount: 1, experienceCount: 0, sessionReused: false, layered: true },
    })));
    const searchL1ForCtx = vi.fn(async () => [] as Array<{ type: string; content: string; score: number }>);
    const injector = new TdaiL1RecallInjector(
      { recallBlockForCtx, searchL1ForCtx } as unknown as TdaiClient,
      null, undefined, 5, null, undefined, undefined,
      "intent",
      dedup,
    );
    return { injector, recallBlockForCtx };
  }

  it("同 session 第二步同意图 → 不再 POST，execute 返回 []", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(true);
    const first = await injector.execute(makeIntentCtx("sessA", INTENT));
    expect(first).toHaveLength(1);
    const second = await injector.execute(makeIntentCtx("sessA", INTENT));
    expect(second).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
  });

  it("新意图（同 session）→ 正常再次召回", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(true);
    await injector.execute(makeIntentCtx("sessA", INTENT));
    const second = await injector.execute(makeIntentCtx("sessA", "换一个问题：召回为什么要去重"));
    expect(second).toHaveLength(1);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("dedup=false（config 关）→ 同意图每步都召回（行为逐位现状）", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(false);
    await injector.execute(makeIntentCtx("sessA", INTENT));
    await injector.execute(makeIntentCtx("sessA", INTENT));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("召回成功但 0 行 → 仍置指纹（下一步同意图跳过）", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(true, async () => ({
      block: "",
      meta: { conclusionCount: 0, experienceCount: 0, sessionReused: false, layered: true },
    }));
    const first = await injector.execute(makeIntentCtx("sessA", INTENT));
    expect(first).toEqual([]);
    const second = await injector.execute(makeIntentCtx("sessA", INTENT));
    expect(second).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
  });

  it("POST 异常不置指纹：主链+降级路同败 → execute 拒绝；恢复后成功召回；第三步跳过", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const recallBlockForCtx = vi.fn()
        .mockRejectedValueOnce(new Error("/v3/recall http 500"))
        .mockResolvedValue({ block: MERGE_BLOCK_87, meta: { conclusionCount: 1, experienceCount: 0, sessionReused: false, layered: true } });
      const searchL1ForCtx = vi.fn().mockRejectedValueOnce(new Error("atomic search down")).mockResolvedValue([]);
      const injector = new TdaiL1RecallInjector(
        { recallBlockForCtx, searchL1ForCtx } as unknown as TdaiClient,
        null, undefined, 5, null, undefined, undefined, "intent", true,
      );
      await expect(injector.execute(makeIntentCtx("sessA", INTENT))).rejects.toThrow();
      const recovered = await injector.execute(makeIntentCtx("sessA", INTENT));
      expect(recovered).toHaveLength(1);
      const third = await injector.execute(makeIntentCtx("sessA", INTENT));
      expect(third).toEqual([]);
      expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("legacy 档不受去重影响：同文本每步都召回", async () => {
    const recallBlockForCtx = vi.fn(async () => ({
      block: MERGE_BLOCK_87,
      meta: { conclusionCount: 1, experienceCount: 0, sessionReused: false, layered: true },
    }));
    const injector = new TdaiL1RecallInjector(
      { recallBlockForCtx, searchL1ForCtx: vi.fn(async () => []) } as unknown as TdaiClient,
      null, undefined, 5, null, undefined, undefined, "legacy", true,
    );
    await injector.execute(makeCtx("同一句提问"));
    await injector.execute(makeCtx("同一句提问"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("#88 R8 · 容量上限 200：LRU 仅逐出最旧会话（未逐出会话指纹保留不漏闸）", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(true);
    for (let i = 0; i < 200; i++) {
      await injector.execute(makeIntentCtx(`sess-${i}`, INTENT));
    }
    expect(recallBlockForCtx).toHaveBeenCalledTimes(200);
    await injector.execute(makeIntentCtx("sess-overflow", INTENT));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(201);
    // #88 R8：未逐出会话（sess-1）指纹必须保留——旧 clear() 整表清空在此漏闸（改前 RED；判别步）
    await injector.execute(makeIntentCtx("sess-1", INTENT));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(201);
    // 被逐出的最旧会话（sess-0）→ 指纹让位，可再次召回
    await injector.execute(makeIntentCtx("sess-0", INTENT));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(202);
  });

  it("#88 M1 · scope 槽真 LRU：命中刷新（非 FIFO 插入序）——刚命中者免逐出、最久未用者让位", async () => {
    const { injector, recallBlockForCtx } = makeDedupInjector(true);
    for (let i = 0; i < 200; i++) {
      await injector.execute(makeIntentCtx("sess-" + i, "intent-" + i));
    }
    // 命中刷新：sess-0 复访经 getScopeState 命中（去重闸挡 POST）——真 LRU 必须重插尾部；FIFO 在此不刷新（RED 判别锚）
    await injector.execute(makeIntentCtx("sess-0", "intent-0"));
    // 第 201 scope 溢出：真 LRU 逐出最久未用的 sess-1（FIFO 会误逐出刚命中的 sess-0）
    await injector.execute(makeIntentCtx("sess-overflow", "intent-ov"));
    // 判别 A：刚命中的 sess-0 指纹仍在 → 同意图不重 POST
    await injector.execute(makeIntentCtx("sess-0", "intent-0"));
    // 判别 B：最久未用的 sess-1 已让位 → 指纹丢失可重 POST
    await injector.execute(makeIntentCtx("sess-1", "intent-1"));
    const calls = recallBlockForCtx.mock.calls;
    const countFor = (q: string) => calls.filter((c) => (c as unknown[])[1] === q).length;
    expect(countFor("intent-0")).toBe(1);
    expect(countFor("intent-1")).toBe(2);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(202);
  });
});

// ═══════════ #88 · 惰性刷新超窗 + 短消息三分 + 三级 scope 指纹（R 矩阵，2026-10-22 定案） ═══════════

describe("#88 · TdaiL1RecallInjector 超窗/短消息/scope（R1-R10）", () => {
  const INTENT88 = "不要影子规则，直接完整实现";
  const W = 60 * 60 * 1000; // recallIntentDedupTtlMs 缺省 60min（定案参数终表）
  const BLOCK = "<relevant-memories>\n- [结论|#88] R 矩阵块\n</relevant-memories>";

  function makeClock() {
    let now = 1_700_000_000_000;
    return { nowFn: () => now, advance(ms: number) { now += ms; } };
  }

  function makeInjector88(opts: { nowFn: () => number; dedup?: boolean; ttlMs?: number }) {
    const recallBlockForCtx = vi.fn(async () => ({
      block: BLOCK,
      meta: { conclusionCount: 1, experienceCount: 0, sessionReused: false, layered: true },
    }));
    const searchL1ForCtx = vi.fn(async () => []);
    const injector = new TdaiL1RecallInjector(
      { recallBlockForCtx, searchL1ForCtx } as unknown as TdaiClient,
      null, undefined, 5, null, undefined, undefined,
      "intent",
      opts.dedup ?? true,
      opts.ttlMs ?? W,
      opts.nowFn,
    );
    return { injector, recallBlockForCtx };
  }

  function makeIntentCtx88(sessionKey: string, intent: string) {
    const ctx = makeCtx(intent);
    (ctx.metadata as Record<string, unknown>).sessionKey = sessionKey;
    (ctx.metadata.custom as Record<string, unknown>).tdaiTurnContext = {
      turnIntent: { classification: "real", text: intent },
      classified: [],
    };
    return ctx;
  }

  /** R7b：同 sessionKey、不同 user_id（scope=userId:agentId:sessionKey 隔离验证）。 */
  function makeIntentCtxAsUser(sessionKey: string, intent: string, userId: string) {
    const ctx = makeIntentCtx88(sessionKey, intent);
    (ctx.metadata.custom as Record<string, unknown>).session = { ...SESSION, user_id: userId };
    return ctx;
  }

  it("R1 · 同文 3 步（各 +1min，W=60min）→ 仅 1 次 POST", async () => {
    const clock = makeClock();
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    await injector.execute(makeIntentCtx88("sessA", INTENT88));
    clock.advance(60_000);
    await injector.execute(makeIntentCtx88("sessA", INTENT88));
    clock.advance(60_000);
    await injector.execute(makeIntentCtx88("sessA", INTENT88));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
  });

  it("R2 · A→B→A 窗内 → 第二次 A 不 POST（指纹按意图分槽，不被 B 冲掉）", async () => {
    const clock = makeClock();
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    await injector.execute(makeIntentCtx88("sessA", "分析召回根因"));
    clock.advance(60_000);
    await injector.execute(makeIntentCtx88("sessA", "换成看降级路径"));
    clock.advance(60_000);
    const third = await injector.execute(makeIntentCtx88("sessA", "分析召回根因"));
    expect(third).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("R3 · A→B→A 超 W → A 重新 POST 且时间戳刷新（条目是刷新非删除）", async () => {
    const clock = makeClock();
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    await injector.execute(makeIntentCtx88("sessA", "分析召回根因"));
    clock.advance(60_000);
    await injector.execute(makeIntentCtx88("sessA", "换成看降级路径"));
    clock.advance(60 * 60_000); // 累计 61min > W=60min
    const third = await injector.execute(makeIntentCtx88("sessA", "分析召回根因"));
    expect(third).toHaveLength(1);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(3);
    // 刷新后再窗内 → 不 POST（证明 lastRecalledAt 被刷新）
    clock.advance(60_000);
    const fourth = await injector.execute(makeIntentCtx88("sessA", "分析召回根因"));
    expect(fourth).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(3);
  });

  it("R4a · 「继续」+ last-known 窗内 → 不 POST（延续消息不独立召回）", async () => {
    const clock = makeClock();
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    await injector.execute(makeIntentCtx88("sessA", "帮我分析召回根因"));
    clock.advance(60_000);
    const second = await injector.execute(makeIntentCtx88("sessA", "继续"));
    expect(second).toEqual([]);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
  });

  it("R4b · 「继续」无 last-known → 不 POST 且记 intent-missing（不得记 scaffold-skip）", async () => {
    const clock = makeClock();
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
      const blocks = await injector.execute(makeIntentCtx88("sessA", "继续"));
      expect(blocks).toEqual([]);
      expect(recallBlockForCtx).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.some((c) => c[0] === "dsh-recall-intent-missing")).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("R5 · 短新意图「换北京」→ 正常 POST 且 query 原样透传（残差门不再拍平）", async () => {
    const clock = makeClock();
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    const blocks = await injector.execute(makeIntentCtx88("sessA", "换北京"));
    expect(blocks).toHaveLength(1);
    expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    expect((recallBlockForCtx.mock.calls[0] as unknown[])[1]).toBe("换北京");
  });

  it("R6 · 「停」→ 不 POST + 记 short-command + 清 last-known（后续「继续」不召回）", async () => {
    const clock = makeClock();
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
      await injector.execute(makeIntentCtx88("sessA", "帮我分析召回根因"));
      clock.advance(60_000);
      const stop = await injector.execute(makeIntentCtx88("sessA", "停"));
      expect(stop).toEqual([]);
      expect(infoSpy.mock.calls.some((c) => c[0] === "dsh-recall-short-command")).toBe(true);
      // 焦点切换：last-known 已清除 → 「继续」无 last-known → 不 POST
      clock.advance(60_000);
      const cont = await injector.execute(makeIntentCtx88("sessA", "继续"));
      expect(cont).toEqual([]);
      expect(recallBlockForCtx).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("R7a · 同文跨 sessionKey → 各自召回不误杀", async () => {
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: () => 1_700_000_000_000 });
    await injector.execute(makeIntentCtx88("sessA", INTENT88));
    await injector.execute(makeIntentCtx88("sessB", INTENT88));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("R7b · 同 sessionKey 跨 user_id → scope 隔离，各自召回", async () => {
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: () => 1_700_000_000_000 });
    await injector.execute(makeIntentCtx88("sessA", INTENT88));
    await injector.execute(makeIntentCtxAsUser("sessA", INTENT88, "userB"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(2);
  });

  it("R10 · 同会话 33 意图 → 仅最旧逐出（中间意图指纹保留、总量有界）", async () => {
    const clock = makeClock(); // 静态时钟：全部窗内
    const { injector, recallBlockForCtx } = makeInjector88({ nowFn: clock.nowFn });
    for (let i = 1; i <= 33; i++) {
      await injector.execute(makeIntentCtx88("sessA", `意图编号${String(i).padStart(2, "0")}`));
    }
    expect(recallBlockForCtx).toHaveBeenCalledTimes(33);
    // 最旧（意图01）已被逐出 → 可再次召回
    await injector.execute(makeIntentCtx88("sessA", "意图编号01"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(34);
    // 中间（意图20）未被逐出 → 指纹保留不漏闸
    await injector.execute(makeIntentCtx88("sessA", "意图编号20"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(34);
    // 最新（意图33）保留
    await injector.execute(makeIntentCtx88("sessA", "意图编号33"));
    expect(recallBlockForCtx).toHaveBeenCalledTimes(34);
  });
});
