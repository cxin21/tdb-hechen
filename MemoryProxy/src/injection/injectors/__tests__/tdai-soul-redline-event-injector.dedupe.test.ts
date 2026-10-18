/**
 * soul-dedupe（2026-10-19）：红线近端注入去重门（TdaiSoulRedlineEventInjector ×
 * SoulTimingConfig.redlineDedup）。
 *
 * 合同：
 *   - 缺省（无 redlineDedup 键）= off = 逐位现状（近重复行都直出）；
 *   - enabled=true → 近重复整行选择（等长保首现/更长胜），kept 行体逐字，
 *     与会话头红线段同判（dedupeNearDuplicateLines 镜像单一源 + parity 契约）；
 *   - jaccardThreshold 透传（阈值抬高 → 不收敛）；
 *   - 只对渲染行集生效（>1 行才过门），其余 Gate（时机/资产位/身份/动作点）不变。
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

// 近重复对（全角/半角括号变体，char-bigram Jaccard>0.45；与会话头红线同款判据）+ 一条异行。
const L1 = "- 排查期间绝不可通过任何路径删除记忆（P1红线）。";
const L2 = "- 排查期间绝不可通过任何路径删除记忆(P1红线)。";
const L3 = "- 生产红线：所有 ssh 命令必须带 -i 密钥文件，禁止密码登录。";
const STRICT_RULE = [L1, L2, L3].join("\n");

const SLOTS = [
  { slot: "identity", content: "- 用户承担TDB系统的运维与故障排查职责。", source: "core", version: 1, updated_at: "2026-10-19" },
  { slot: "strict_rule", content: STRICT_RULE, source: "core", version: 2, updated_at: "2026-10-19" },
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

function actionProximate(dedup?: SoulTimingConfig["redlineDedup"]): SoulTimingConfig {
  return { ...DEFAULT_SOUL_TIMING, redline: "action_proximate", ...(dedup ? { redlineDedup: dedup } : {}) };
}

function makeCtx(): AgentContext {
  const custom: Record<string, unknown> = { session: SESSION_A, userKey: SESSION_A.user_key };
  const messages: ContextMessage[] = [
    { role: "system", blocks: [{ type: "text", content: "sys" }] },
    { role: "user", blocks: [{ type: "text", content: "开始任务" }] },
    { role: "assistant", blocks: [{ type: "tool_use", content: '{"name":"read_file","arguments":"{}"}', metadata: { tool_id: "tu1" } }] },
    { role: "user", blocks: [{ type: "tool_result", content: "file contents", metadata: { tool_use_id: "tu1" } }] },
  ];
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

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soul-dedupe 红线近端去重门（redlineDedup）", () => {
  it("缺省（无 redlineDedup 键）→ 近重复两行都直出（off=逐位现状）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx());
    expect(r).toHaveLength(1);
    const c = r[0].content;
    expect(c).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆（P1红线）。");
    expect(c).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆(P1红线)。");
    expect(c).toContain("- [strict_rule] 生产红线：所有 ssh 命令必须带 -i 密钥文件，禁止密码登录。");
  });

  it("enabled=true → 近重复对收敛（等长保首现），异行与 tag 形态不受影响", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate({ enabled: true }));

    const r = await injector.execute(makeCtx());
    expect(r).toHaveLength(1);
    const c = r[0].content;
    // 等长近重复 → 保首现（全角变体 kept，半角变体 dropped）
    expect(c).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆（P1红线）。");
    expect(c).not.toContain("(P1红线)");
    // 异行保留；逐行 tag 形态不变形
    expect(c).toContain("- [strict_rule] 生产红线：所有 ssh 命令必须带 -i 密钥文件，禁止密码登录。");
    expect(c).not.toContain("- [strict_rule] -");
  });

  it("jaccardThreshold 抬高（0.99）→ 不收敛（阈值透传）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate({ enabled: true, jaccardThreshold: 0.99 }));

    const r = await injector.execute(makeCtx());
    const c = r[0].content;
    expect(c).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆（P1红线）。");
    expect(c).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆(P1红线)。");
  });

  it("单行红线 + 去重开 → 原样直出（>1 行才过门，不误伤）", async () => {
    stubSlots([{ slot: "strict_rule", content: L1, source: "core", version: 1, updated_at: "t" }]);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate({ enabled: true }));

    const r = await injector.execute(makeCtx());
    expect(r).toHaveLength(1);
    expect(r[0].content).toContain("- [strict_rule] 排查期间绝不可通过任何路径删除记忆（P1红线）。");
  });
});
