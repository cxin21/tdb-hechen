/**
 * T16（K3）：current_feeling 解冻单测。
 *
 * 背景：prewarm 只缓存 cacheStrategy ∈ {session_init, hybrid} 的 hook，
 * TdaiProfileMemoryInjector 入选且 prewarm 时 messages=[] → q="" → 感受块恒空
 * 落缓存 → 整个会话冻结（主流程 session_init 命中缓存跳过 execute）。
 *
 * 修法（拆分，R2/R3 模式）：
 *   - core_memory 稳定块保留在 TdaiProfileMemoryInjector（session_init 缓存，A 项成果不动）
 *   - current_feeling 移入独立的 TdaiCurrentFeelingInjector（cacheStrategy="none"，
 *     每轮 execute 用当轮真实用户消息重算，注入 user.before 动态区）
 *
 * 本文件验证五组验收：
 *   1. 解冻：两轮不同价值向提问 → 感受块内容随轮变化
 *   2. 稳定块不动：core_memory 块两轮间逐字节一致；且旧注入路径删干净
 *      （profile injector 输出不再含 <current_feeling>）
 *   3. 宁缺毋滥：无价值命中轮 → 零感受块
 *   4. prewarm 白名单：感受块 injector 不被 prewarm 缓存
 *   5. 租户键：双租户交替 → 各自感受块（复用 T12 corecache 单测模式）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TdaiCurrentFeelingInjector } from "../tdai-current-feeling-injector.js";
import { TdaiProfileMemoryInjector } from "../tdai-profile-memory-injector.js";
import { resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import { HookRegistryImpl } from "../../registry.js";
import { prewarmAll } from "../../prewarm.js";
import type { HookCacheRepo, HookCacheEntry } from "../../../db/hookCacheRepo.js";
import type { ContextBlock, ContextMessage } from "../../types.js";
import type { TdaiMemoryConfig } from "../../../tdai/types.js";

const SESSION_A = {
  session_id: "sA",
  team_id: "teamA",
  user_id: "userA",
  agent_id: "agentA",
  space_id: "",
  user_key: "ukA",
};
const SESSION_B = {
  session_id: "sB",
  team_id: "teamB",
  user_id: "userB",
  agent_id: "agentB",
  space_id: "",
  user_key: "ukB",
};

/** appraisal 挂在 baseConfig 上（与 index.ts 装配 tdaiBaseConfig 同构）。 */
function makeConfig(appraisal?: {
  enabled: boolean;
  firedThreshold: number;
  values: Array<{ id: string; label: string; weight: number }>;
  injectL2L3?: boolean;
}): TdaiMemoryConfig {
  const base: TdaiMemoryConfig = {
    enabled: true,
    endpoint: "http://127.0.0.1:8420",
    apiKey: "k",
    serviceId: "default",
    writeL0: false,
    recallL1: false,
    injectL2L3: appraisal?.injectL2L3 ?? false,
    l1Limit: 5,
    l2Limit: 5,
    timeoutMs: 1000,
  };
  if (!appraisal) return base;
  return { ...base, appraisal } as unknown as TdaiMemoryConfig;
}

function userMsg(text: string): ContextMessage {
  return { role: "user", blocks: [{ type: "text", content: text }] };
}

function makeCtx(q: string, session: Record<string, unknown>) {
  return {
    messages: [
      { role: "system", blocks: [{ type: "text", content: "sys" }] } as ContextMessage,
      userMsg(q),
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
      custom: { session, userKey: session.user_key },
    },
  };
}

interface FetchCall { url: string; headers: Record<string, string> }

/**
 * 按 URL + team 头路由的 fetch stub。payload 缺省键返回空结构，
 * 避免未预期的调用把测试炸掉（Client 侧本来就把空当降级）。
 */
function stubFetchRouter(routes: {
  byUrl: Record<string, unknown>;
  byTeam?: Record<string, unknown>;
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, headers });
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v3/core-memory/read") {
      const team = headers["x-tdai-team-id"] ?? "";
      const data = routes.byTeam?.[team] ?? {};
      return { ok: true, json: async () => ({ code: 0, data }) } as unknown as Response;
    }
    const data = routes.byUrl[path] ?? {};
    return { ok: true, json: async () => ({ code: 0, data }) } as unknown as Response;
  }));
  return { calls };
}

const VALUES_TWO = [
  { value_id: "perf", label: "性能", weight: 0.9 },
  { value_id: "settle", label: "结算", weight: 0.9 },
];
/** config.yaml appraisal.values 的形状是 {id,label,weight}（与 core-memory 的 {value_id} 不同）。 */
const FALLBACK_VALUES = [
  { id: "perf", label: "性能", weight: 0.9 },
  { id: "settle", label: "结算", weight: 0.9 },
];

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T16 解冻：TdaiCurrentFeelingInjector 每轮重算", () => {
  it("两轮不同价值向提问 → 感受块内容随轮变化", async () => {
    stubFetchRouter({ byUrl: {}, byTeam: { teamA: { values: VALUES_TWO, slots: [] } } });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: FALLBACK_VALUES }),
    );

    const r1 = await injector.execute(makeCtx("这块性能太差", SESSION_A));
    const r2 = await injector.execute(makeCtx("结算又出错了", SESSION_A));

    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
    expect(r1[0].content).toContain("<current_feeling>");
    expect(r1[0].content).toContain("性能(perf)");
    expect(r2[0].content).toContain("结算(settle)");
    expect(r1[0].content).not.toBe(r2[0].content);
  });

  it("宁缺毋滥：无价值命中轮 → 零感受块", async () => {
    stubFetchRouter({ byUrl: {}, byTeam: { teamA: { values: VALUES_TWO, slots: [] } } });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: FALLBACK_VALUES }),
    );

    const r = await injector.execute(makeCtx("今天天气怎么样", SESSION_A));
    expect(r).toEqual([]);
  });

  it("identity=null → 早返回零注入（M-1：session 缺 agent_id，不触网）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: FALLBACK_VALUES }),
    );

    // 缺 agent_id → deriveTdaiIdentity 返回 null → execute 早返回
    const brokenSession = {
      session_id: "sX",
      team_id: "teamX",
      user_id: "userX",
      space_id: "",
      user_key: "ukX",
    };
    const r = await injector.execute(makeCtx("性能很差", brokenSession));
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("值拉不到且无 fallback → 零感受块（宁缺毋滥）", async () => {
    stubFetchRouter({ byUrl: {}, byTeam: { teamA: { values: [], slots: [] } } });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: [] }),
    );
    const r = await injector.execute(makeCtx("性能很差", SESSION_A));
    expect(r).toEqual([]);
  });

  it("值拉不到但有 config fallback → fallback 值参与判定（B1 单一源语义保留）", async () => {
    stubFetchRouter({ byUrl: {}, byTeam: { teamA: { values: [], slots: [] } } });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: FALLBACK_VALUES }),
    );
    const r = await injector.execute(makeCtx("性能很差", SESSION_A));
    expect(r.length).toBe(1);
    expect(r[0].content).toContain("性能(perf)");
  });

  it("prewarm 白名单：cacheStrategy=none，prewarmAll 不缓存感受块 injector", async () => {
    stubFetchRouter({ byUrl: {}, byTeam: { teamA: { values: VALUES_TWO, slots: [] } } });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: FALLBACK_VALUES }),
    );
    expect(injector.cacheStrategy).toBe("none");

    const puts: HookCacheEntry[] = [];
    const fakeRepo: HookCacheRepo = {
      put: async () => {},
      putMany: async (_s, _u, _a, _sid, entries) => {
        puts.push(...entries);
      },
      get: async () => null,
      getAllForSession: async () => [],
      clearBySession: async () => {},
    };
    const registry = new HookRegistryImpl();
    registry.register(injector);
    const result = await prewarmAll(
      registry,
      fakeRepo,
      {
        keyId: "k",
        userId: "userA",
        agentSource: "claude-code",
        sessionInfo: SESSION_A as unknown as Parameters<typeof prewarmAll>[2]["sessionInfo"],
        agentDetail: null,
        taskDetail: null,
      },
    );
    expect(result.cachedHookIds).not.toContain("tdai-current-feeling-injector");
    expect(puts).toHaveLength(0);
    // prewarm（messages=[]）路径下也不产生感受块（injector 根本没有 prewarm）
    expect(typeof (injector as { prewarm?: unknown }).prewarm).toBe("undefined");
  });

  it("租户键：双租户交替 → 各自感受块（复用 T12 corecache 模式）", async () => {
    stubFetchRouter({
      byUrl: {},
      byTeam: {
        teamA: { values: [{ value_id: "perfA", label: "性能", weight: 0.9 }], slots: [] },
        teamB: { values: [{ value_id: "perfB", label: "性能", weight: 0.9 }], slots: [] },
      },
    });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: [] }),
    );

    const a1 = await injector.execute(makeCtx("性能很差", SESSION_A));
    const b1 = await injector.execute(makeCtx("性能很差", SESSION_B));
    const a2 = await injector.execute(makeCtx("性能很差", SESSION_A));
    const b2 = await injector.execute(makeCtx("性能很差", SESSION_B));

    expect(a1[0].content).toContain("性能(perfA)");
    expect(b1[0].content).toContain("性能(perfB)");
    expect(a2[0].content).toContain("性能(perfA)");
    expect(b2[0].content).toContain("性能(perfB)");
  });

  // C2（spec §3.3）：core_values 携带 valence → loadAppraisalValues 透传 → 方向行渲染。
  it("C2 方向行：valence 透传（1→推进行；null→无方向行）", async () => {
    stubFetchRouter({
      byUrl: {},
      byTeam: {
        teamA: { values: [{ value_id: "perf", label: "性能", weight: 0.9, valence: 1 }], slots: [] },
      },
    });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: [] }),
    );
    const r = await injector.execute(makeCtx("性能很差", SESSION_A));
    expect(r.length).toBe(1);
    expect(r[0].content).toContain("本轮方向：围绕【性能】推进");
  });

  it("C2 方向行：valence 未判定（null）→ 块照常输出但无方向行（D1 兜底）", async () => {
    stubFetchRouter({
      byUrl: {},
      byTeam: {
        teamA: { values: [{ value_id: "perf", label: "性能", weight: 0.9, valence: null }], slots: [] },
      },
    });
    const injector = new TdaiCurrentFeelingInjector(
      makeConfig({ enabled: true, firedThreshold: 0.4, values: [] }),
    );
    const r = await injector.execute(makeCtx("性能很差", SESSION_A));
    expect(r.length).toBe(1);
    expect(r[0].content).toContain("性能(perf)");
    expect(r[0].content).not.toContain("本轮方向");
  });
});

describe("T16 稳定块不动：TdaiProfileMemoryInjector", () => {
  function makeProfileConfig(): TdaiMemoryConfig {
    // injectL2L3=true 让 hasAnything 命中（L3 有内容），走完整稳定块路径
    return makeConfig({
      enabled: true,
      firedThreshold: 0.4,
      values: FALLBACK_VALUES,
      injectL2L3: true,
    });
  }

  function stubProfileFetch(): void {
    stubFetchRouter({
      byUrl: {
        "/v3/core/read": { content: "L3 persona 内容" },
        "/v3/scenario/ls": { entries: [] },
      },
      byTeam: {
        teamA: {
          values: VALUES_TWO,
          slots: [{ slot: "identity", content: "TDB 工程师身份", source: "api", version: 1, updated_at: "" }],
        },
      },
    });
  }

  function extractCoreMemory(content: string): string {
    const start = content.indexOf("<core_memory>");
    const end = content.indexOf("</core_memory>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return content.slice(start, end + "</core_memory>".length);
  }

  function extractFeeling(content: string): string {
    const start = content.indexOf("<current_feeling>");
    if (start === -1) return "";
    const end = content.indexOf("</current_feeling>");
    return content.slice(start, end + "</current_feeling>".length);
  }

  it("core_memory 块在两轮不同提问间逐字节一致（session_init 缓存语义保留）", async () => {
    stubProfileFetch();
    const injector = new TdaiProfileMemoryInjector(makeProfileConfig(), null);

    const r1: ContextBlock[] = await injector.execute(makeCtx("这块性能太差", SESSION_A));
    const r2: ContextBlock[] = await injector.execute(makeCtx("结算又出错了", SESSION_A));

    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
    const core1 = extractCoreMemory(r1[0].content);
    const core2 = extractCoreMemory(r2[0].content);
    expect(core1).toBe(core2);
  });

  it("旧注入路径删干净：session_init 路径输出不再含 <current_feeling>", async () => {
    stubProfileFetch();
    const injector = new TdaiProfileMemoryInjector(makeProfileConfig(), null);

    // 修复前：这一轮（q 命中价值）会把感受块拼进 session_init 缓存输出
    const r: ContextBlock[] = await injector.execute(makeCtx("这块性能太差", SESSION_A));
    expect(extractFeeling(r[0].content)).toBe("");

    // prewarm 路径（messages=[]，q=""）同样不得出现感受块
    const prewarmBlocks = await injector.prewarm({
      keyId: "k",
      userId: "userA",
      agentSource: "claude-code",
      sessionInfo: SESSION_A as unknown as Parameters<typeof injector.prewarm>[0]["sessionInfo"],
      agentDetail: null,
      taskDetail: null,
    });
    for (const b of prewarmBlocks) {
      if (b.type === "text") expect(extractFeeling(b.content)).toBe("");
    }
  });
});
