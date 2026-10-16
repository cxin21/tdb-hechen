/**
 * #39（ADR0003-P3 / 接线票 A，2026-10-16）：红线动作点近端 event 注入器。
 *
 * 合同（票面 + ADR 0003 D3 + r5-37）：
 *   - point=tools.before_call（#37 首交付已冻结类型，本票接线分发层）；
 *   - 内容源=core strict_rule 槽原文（与 #24-C1 soul-identity 红线段同源同渲染：
 *     逐 slot 一行 `- [strict_rule] ${content}`，多行原文逐字直出——无预算/无截断/无改写）；
 *   - 时机 config-first：SoulTimingConfig.redline 缺省 "session_head"=不注入（逐位现状），
 *     显式 "action_proximate" 才挂块；
 *   - 动作点判定：尾消息携带 tool_result（agentic loop 中，模型下一步可能发起工具调用）；
 *   - cacheStrategy="none"：动作点现场渲染，绝不进指纹缓存（#37 票面验收）；
 *   - 宁缺毋滥：无 strict_rule 槽 / 身份缺失 / 资产位关 / core 不可达 → 零块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TdaiSoulRedlineEventInjector } from "../tdai-soul-redline-event-injector.js";
import { resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import { DEFAULT_SOUL_TIMING, type SoulTimingConfig } from "../../types.js";
import type { AgentContext, AgentContextMetadata, ContextMessage } from "../../types.js";
import type { TdaiMemoryConfig } from "../../../tdai/types.js";

const SESSION_A = {
  session_id: "sA",
  team_id: "teamA",
  user_id: "userA",
  agent_id: "agentA",
  space_id: "",
  user_key: "ukA",
};

/** 多行 strict_rule 原文（换行 + 伪标题逐字直出合同钉，同 soul-snapshots R5-F6）。 */
const STRICT_RULE = "- 排查期间绝不可通过任何路径删除记忆（P1红线）。\n- ## 伪标题也逐字保留";
const IDENTITY_LINE = "- 用户承担TDB系统的运维与故障排查职责。";

const SLOTS = [
  { slot: "identity", content: IDENTITY_LINE, source: "core", version: 1, updated_at: "2026-10-16" },
  { slot: "strict_rule", content: STRICT_RULE, source: "core", version: 2, updated_at: "2026-10-16" },
];

function makeConfig(): TdaiMemoryConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "k",
    serviceId: "default",
    writeL0: false,
    recallL1: false,
    injectL2L3: true,
    l1Limit: 5,
    l2Limit: 5,
    timeoutMs: 1000,
  };
}

function actionProximate(): SoulTimingConfig {
  return { ...DEFAULT_SOUL_TIMING, redline: "action_proximate" };
}

/** tool_result 尾（动作点）与普通 user 尾（非动作点）两种 ctx。 */
function makeCtx(opts: { tail: "tool_result" | "user"; capsOff?: boolean; brokenIdentity?: boolean }): AgentContext {
  const session = opts.brokenIdentity
    ? { ...SESSION_A, agent_id: undefined }
    : SESSION_A;
  const custom: Record<string, unknown> = { session, userKey: SESSION_A.user_key };
  if (opts.capsOff) custom.assetCapabilities = { chat_memory: false };

  const messages: ContextMessage[] = [
    { role: "system", blocks: [{ type: "text", content: "sys" }] },
    { role: "user", blocks: [{ type: "text", content: "开始任务" }] },
  ];
  if (opts.tail === "tool_result") {
    messages.push({
      role: "assistant",
      blocks: [{ type: "tool_use", content: '{"name":"read_file","arguments":"{}"}', metadata: { tool_id: "tu1" } }],
    });
    messages.push({
      role: "user",
      blocks: [{ type: "tool_result", content: "file contents", metadata: { tool_use_id: "tu1" } }],
    });
  } else {
    messages.push({ role: "user", blocks: [{ type: "text", content: "继续" }] });
  }
  return {
    messages,
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: "t",
      keyId: "k",
      modelId: "m",
      stream: false,
      agentSource: "claude-code",
      custom,
    } as AgentContextMetadata,
  };
}

function stubSlots(slots: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { slots } }),
  }) as unknown as Response));
}

function stubUnreachable(): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ code: 1 }) }) as unknown as Response));
}

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#39 TdaiSoulRedlineEventInjector", () => {
  it("缺省 timing（redline=session_head）→ 零块且不触网（config-first 门）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), { ...DEFAULT_SOUL_TIMING });

    const r = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("action_proximate + tool_result 尾 → 单块：包络+段名+红线行原文逐字直出（多行不转写）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r).toHaveLength(1);
    const c = r[0].content;
    expect(c).toContain('<soul-event kind="redline">');
    expect(c).toContain("</soul-event>");
    expect(c).toContain("## 不可逾越（红线）");
    expect(c).toContain(`- [strict_rule] ${STRICT_RULE}`);
    // 多行原文逐字：换行与伪标题原样保留（真实性边界：不改写/不转写）
    expect(c).toContain("- ## 伪标题也逐字保留");
    // 红线子集：identity 槽不进事件块
    expect(c).not.toContain("用户承担TDB系统的运维");
    // soul.event 分类 + 观测 metadata
    expect(r[0].metadata?.soulBlockKind).toBe("soul.event");
    expect(r[0].metadata?.source).toBe("tdai-soul-redline-event-injector");
    expect(String(r[0].metadata?.cacheKey)).toMatch(/^soul-redline-event:[0-9a-f]{8}$/);
  });

  it("action_proximate + 非 tool_result 尾（普通 user 消息）→ 零块且不触网（动作点判定）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "user" }));
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("无 strict_rule 槽 → 零块（宁缺毋滥）", async () => {
    stubSlots([{ slot: "identity", content: IDENTITY_LINE, source: "core", version: 1, updated_at: "t" }]);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r).toEqual([]);
  });

  it("identity 缺失（session 缺 agent_id）→ 零块且不触网", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "tool_result", brokenIdentity: true }));
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("资产位 chat_memory=false → 零块且不触网", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "tool_result", capsOff: true }));
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("core 不可达（ok=false）→ 零块（宁缺毋滥，不阻断管线）", async () => {
    stubUnreachable();
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r).toEqual([]);
  });

  it("cacheKey 指纹确定性：同内容同键；内容变更换键（32 位 FNV-1a，Math.imul）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r1 = await injector.execute(makeCtx({ tail: "tool_result" }));
    const r2 = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r1[0].metadata?.cacheKey).toBe(r2[0].metadata?.cacheKey);

    // 内容变更 → 键变化（先清租户缓存，避免 60s TTL 命中旧 slots）
    resetCoreTenantCachesForTest();
    stubSlots([{ slot: "strict_rule", content: "- 另一条红线", source: "core", version: 3, updated_at: "t" }]);
    const r3 = await injector.execute(makeCtx({ tail: "tool_result" }));
    expect(r3[0].metadata?.cacheKey).not.toBe(r1[0].metadata?.cacheKey);
  });
});
