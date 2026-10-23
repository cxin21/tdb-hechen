/**
 * redlineCadence（2026-10-23，#39 终判 revisit 后用户拍板 D=8）：红线动作点
 * 轮首锚定节流 + 语用附带句合同测试。
 *
 * 背景：#39 终判维持每动作点全文注入（可审计性 + 零漏注），但确认税活体证据
 * （截图 5/5 思考条目=红线复述记账、零任务推理）坐实「习惯化效应」假设 →
 * 用户拍板降频方向（直接实施，不立票）：
 *   - mode="turn_head"：每轮首个动作点必注全文；链内每 depthOverflow 个动作点
 *     溢出重锚一次（缺省 8，clamp [1,200]）；null 态 fail-open；红线指纹变更
 *     强制重注；riskToolPatterns 命中兜底（缺省 [] 关）。
 *   - 语用附带句（rider）：块尾「无需复述确认」，治理逐次确认税。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TdaiSoulRedlineEventInjector } from "../tdai-soul-redline-event-injector.js";
import { resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import {
  DEFAULT_SOUL_TIMING,
  type AgentContext,
  type AgentContextMetadata,
  type ContextMessage,
  type SoulTimingConfig,
} from "../../types.js";
import type { TdaiMemoryConfig } from "../../../tdai/types.js";

const SESSION_A = {
  session_id: "sA",
  team_id: "teamA",
  user_id: "userA",
  agent_id: "agentA",
  space_id: "",
  user_key: "ukA",
};

/** 多行 strict_rule 原文（换行 + 伪标题逐字直出合同钉，同主套件夹具）。 */
const STRICT_RULE = "- 排查期间绝不可通过任何路径删除记忆（P1红线）。\n- ## 伪标题也逐字保留";
const IDENTITY_LINE = "- 用户承担TDB系统的运维与故障排查职责。";

const SLOTS = [
  { slot: "identity", content: IDENTITY_LINE, source: "core", version: 1, updated_at: "2026-10-23" },
  { slot: "strict_rule", content: STRICT_RULE, source: "core", version: 2, updated_at: "2026-10-23" },
];

/** 语用附带句合同钉（逐字；与注入器常量一字不差）。 */
const REDLINE_EVENT_RIDER = "以上为既有红线近端复现，无需复述确认，直接继续当前步骤。";

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

/** cadence 时机（RED 期字段未上 SoulTimingConfig，运行时为准；GREEN 后类型门接管）。 */
function cadenceTiming(
  mode: "turn_head" | "every_action_point",
  extra?: { depthOverflow?: number; riskToolPatterns?: string[] },
): SoulTimingConfig {
  return {
    ...DEFAULT_SOUL_TIMING,
    redline: "action_proximate",
    redlineCadence: { mode, ...extra },
  } as SoulTimingConfig;
}

/** tool_result 尾（动作点）ctx；userTurns 控制真实用户轮数（轮键），riskTool 覆盖尾工具名。 */
function makeCtx(
  opts: { userTurns?: number; riskTool?: string; sessionId?: string } = {},
): AgentContext {
  const session = {
    ...SESSION_A,
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  };
  const custom: Record<string, unknown> = { session, userKey: SESSION_A.user_key };

  const messages: ContextMessage[] = [
    { role: "system", blocks: [{ type: "text", content: "sys" }] },
    { role: "user", blocks: [{ type: "text", content: "开始任务" }] },
  ];
  const turns = opts.userTurns ?? 1;
  for (let i = 1; i <= turns; i++) {
    if (i > 1) messages.push({ role: "user", blocks: [{ type: "text", content: `继续${i}` }] });
    const name = i === turns && opts.riskTool ? opts.riskTool : "read_file";
    messages.push({
      role: "assistant",
      blocks: [{ type: "tool_use", content: `{"name":"${name}","arguments":"{}"}`, metadata: { tool_id: `tu${i}` } }],
    });
    messages.push({
      role: "user",
      blocks: [{ type: "tool_result", content: "out", metadata: { tool_use_id: `tu${i}` } }],
    });
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

beforeEach(() => {
  resetCoreTenantCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redlineCadence（2026-10-23 用户拍板 D=8，#39 终判 revisit）", () => {
  it("语用附带句：事件块段尾带 rider（确认税治理）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    const r = await injector.execute(makeCtx());
    expect(r).toHaveLength(1);
    const c = r[0].content;
    expect(c).toContain(REDLINE_EVENT_RIDER);
    // rider 在段名与红线行之后（段尾附加，不改写红线原文）
    expect(c.indexOf(REDLINE_EVENT_RIDER)).toBeGreaterThan(c.indexOf("## 不可逾越（红线）"));
    expect(c.indexOf(REDLINE_EVENT_RIDER)).toBeGreaterThan(
      c.indexOf("- [strict_rule] 排查期间绝不可通过任何路径删除记忆"),
    );
  });

  it("缺省（无 redlineCadence）→ 每动作点都注入（逐位现状基线）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), actionProximate());

    for (let i = 0; i < 3; i++) {
      expect(await injector.execute(makeCtx())).toHaveLength(1);
    }
  });

  it("turn_head：同轮第 2 个动作点 → 零块（节流生效）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));

    expect(await injector.execute(makeCtx())).toHaveLength(1);
    expect(await injector.execute(makeCtx())).toEqual([]);
  });

  it("turn_head：新真实用户轮（轮键+1）→ 轮首必注全文", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));

    expect(await injector.execute(makeCtx())).toHaveLength(1);
    expect(await injector.execute(makeCtx())).toEqual([]);
    expect(await injector.execute(makeCtx({ userTurns: 2 }))).toHaveLength(1);
  });

  it("turn_head 缺省 D=8：链内第 9 个动作点溢出重锚（v2..v8 零块、v9 重注）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));

    expect(await injector.execute(makeCtx())).toHaveLength(1); // v1 轮首
    for (let i = 2; i <= 8; i++) {
      expect(await injector.execute(makeCtx())).toEqual([]); // v2..v8 节流
    }
    expect(await injector.execute(makeCtx())).toHaveLength(1); // v9 溢出重锚
  });

  it("depthOverflow clamp [1,200]：0→1（v2 即重注）、999→200（v2 仍零块）", async () => {
    stubSlots(SLOTS);
    const clampLow = new TdaiSoulRedlineEventInjector(
      makeConfig(),
      cadenceTiming("turn_head", { depthOverflow: 0 }),
    );
    expect(await clampLow.execute(makeCtx())).toHaveLength(1);
    expect(await clampLow.execute(makeCtx())).toHaveLength(1); // D=1 ≡ 每动作点

    const clampHigh = new TdaiSoulRedlineEventInjector(
      makeConfig(),
      cadenceTiming("turn_head", { depthOverflow: 999 }),
    );
    expect(await clampHigh.execute(makeCtx())).toHaveLength(1);
    expect(await clampHigh.execute(makeCtx())).toEqual([]); // steps=1 < 200
  });

  it("null 态 fail-open：无状态实例（重启/LRU 驱逐模拟）→ 首访强制全文", async () => {
    stubSlots(SLOTS);
    const first = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));
    expect(await first.execute(makeCtx())).toHaveLength(1);
    expect(await first.execute(makeCtx())).toEqual([]);

    const restarted = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));
    expect(await restarted.execute(makeCtx())).toHaveLength(1); // 状态丢失 → fail-open 注入
  });

  it("红线指纹变更（同轮内）→ 强制重注（规则变更立即可见）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));
    expect(await injector.execute(makeCtx())).toHaveLength(1);

    resetCoreTenantCachesForTest();
    stubSlots([{ slot: "strict_rule", content: "- 另一条红线", source: "core", version: 3, updated_at: "t" }]);
    const r2 = await injector.execute(makeCtx());
    expect(r2).toHaveLength(1); // steps=1 < D 但指纹变更 → 兜底注入
    expect(r2[0].content).toContain("另一条红线");
  });

  it("riskToolPatterns 命中 → 覆盖节流强制注入；后续普通动作点恢复节流", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(
      makeConfig(),
      cadenceTiming("turn_head", { riskToolPatterns: ["push"] }),
    );
    expect(await injector.execute(makeCtx())).toHaveLength(1); // v1 轮首
    expect(await injector.execute(makeCtx())).toEqual([]); // v2 普通 → 节流
    expect(await injector.execute(makeCtx({ riskTool: "git push" }))).toHaveLength(1); // v3 风险 → 兜底
    expect(await injector.execute(makeCtx())).toEqual([]); // v4 普通 → 恢复节流
  });

  it("riskToolPatterns 缺省（[]）→ 风险覆盖关", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));
    expect(await injector.execute(makeCtx())).toHaveLength(1);
    expect(await injector.execute(makeCtx({ riskTool: "git push" }))).toEqual([]); // patterns 空 → 不兜底
  });

  it("会话键隔离：session_id 不同 → 互不串扰，各自轮首必注", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulRedlineEventInjector(makeConfig(), cadenceTiming("turn_head"));
    expect(await injector.execute(makeCtx())).toHaveLength(1); // sA v1
    expect(await injector.execute(makeCtx())).toEqual([]); // sA v2 节流
    expect(await injector.execute(makeCtx({ sessionId: "sB" }))).toHaveLength(1); // sB v1 轮首
  });
});
