/**
 * #59（S21，2026-10-18）：身份漂移再锚定注入器（TdaiSoulReanchorInjector ×
 * SoulTimingConfig.driftTrigger="auto"）。
 *
 * 合同：
 *   - 时机 config-first：driftTrigger 缺省 "off"（/ "shadow"）→ 零块零触网（逐位现状）；
 *     显式 "auto" 才挂块；
 *   - point = tools.before_call（动作点近端；per-identity 轮次计数 = execute 调用序）；
 *   - 节流：首轮注入、之后每 intervalTurns 轮一次（clamp [1,200]，缺省 20）；
 *   - 内容 = core identity/self_identity 槽行级渲染（identity 在前、逐行 tag、
 *     行数 ≤ REANCHOR_MAX_LINES(8)、每行 ≤ REANCHOR_LINE_MAX_CHARS(120)——短注入，
 *     文献 adaptive re-injection 对冲长会话注意力稀释）；空槽 → 零块（宁缺毋滥）；
 *   - 其余 Gate 与红线注入器同链：资产位关 / 无身份 / 非动作点 → 零块；
 *   - cacheStrategy="none"；块带 cacheKey="soul-reanchor-event:<fnv1a32(section)>"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REANCHOR_LINE_MAX_CHARS,
  REANCHOR_MAX_LINES,
  TdaiSoulReanchorInjector,
  renderReanchorLines,
} from "../tdai-soul-reanchor-injector.js";
import { resetCoreTenantCachesForTest } from "../tdai-profile-memory-injector.js";
import { DEFAULT_SOUL_TIMING, type SoulTimingConfig } from "../../types.js";
import type { AgentContext, AgentContextMetadata, ContextMessage } from "../../types.js";
import type { TdaiMemoryConfig } from "../../../tdai/types.js";

const IDENTITY = "- 用户承担TDB系统的运维与故障排查职责。";
const SELF_A = "- 我一贯以根因优先的方式解决问题。";
const SELF_B = "- 我倾向于先把事实钉牢再下结论。";
const REDLINE = "- 生产红线：所有 ssh 命令必须带 -i 密钥文件。";

const SLOTS = [
  { slot: "identity", content: IDENTITY, source: "core", version: 1, updated_at: "2026-10-18" },
  { slot: "self_identity", content: SELF_A + "\n" + SELF_B, source: "core", version: 2, updated_at: "2026-10-18" },
  { slot: "strict_rule", content: REDLINE, source: "core", version: 3, updated_at: "2026-10-18" },
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

function autoTiming(intervalTurns?: number): SoulTimingConfig {
  const reanchor = intervalTurns === undefined ? undefined : { intervalTurns };
  return { ...DEFAULT_SOUL_TIMING, driftTrigger: "auto", ...(reanchor ? { reanchor } : {}) };
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

const SESSION_A = {
  session_id: "sA",
  team_id: "teamA",
  user_id: "userA",
  agent_id: "agentA",
  space_id: "",
  user_key: "ukA",
};

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

describe("#59 身份漂移再锚定注入器（driftTrigger=auto）", () => {
  it("缺省（driftTrigger=off）→ 零块零触网（逐位现状，连调两次）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), { ...DEFAULT_SOUL_TIMING });
    expect(await injector.execute(makeCtx())).toEqual([]);
    expect(await injector.execute(makeCtx())).toEqual([]);
  });

  it("auto 首轮 → 1 块：kind=reanchor、段名、identity 在前 self_identity 在后、strict_rule 不入", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming());
    const r = await injector.execute(makeCtx());
    expect(r).toHaveLength(1);
    const c = r[0].content;
    expect(c).toContain('<soul-event kind="reanchor">');
    expect(c).toContain("## 身份基线（再锚定）");
    expect(c).toContain("- [identity] 用户承担TDB系统的运维与故障排查职责。");
    expect(c).toContain("- [self_identity] 我一贯以根因优先的方式解决问题。");
    expect(c).toContain("- [self_identity] 我倾向于先把事实钉牢再下结论。");
    expect(c).not.toContain("strict_rule");
    expect(c).not.toContain(REDLINE);
    expect(c).toContain("</soul-event>");
    expect(r[0].type).toBe("text");
    expect(r[0].metadata?.soulBlockKind).toBe("soul.event");
    expect(String(r[0].metadata?.cacheKey)).toMatch(/^soul-reanchor-event:/);
  });

  it("槽序无关：self_identity 在前 identity 在后 → 渲染仍 identity 在前", async () => {
    stubSlots([SLOTS[1], SLOTS[0]]);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming());
    const r = await injector.execute(makeCtx());
    const c = r[0].content;
    expect(c.indexOf("[identity]")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("[identity]")).toBeLessThan(c.indexOf("[self_identity]"));
  });

  it("缺省 intervalTurns=20：第 2..20 轮静默、第 21 轮再注入", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming());
    expect((await injector.execute(makeCtx())).length).toBe(1);
    for (let t = 2; t <= 20; t++) {
      expect(await injector.execute(makeCtx())).toEqual([]);
    }
    expect((await injector.execute(makeCtx())).length).toBe(1);
  });

  it("intervalTurns=1 → 每轮都注入", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming(1));
    for (let t = 0; t < 3; t++) {
      expect((await injector.execute(makeCtx())).length).toBe(1);
    }
  });

  it("intervalTurns=0 → clamp 到 1（每轮注入）", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming(0));
    expect((await injector.execute(makeCtx())).length).toBe(1);
    expect((await injector.execute(makeCtx())).length).toBe(1);
  });

  it("intervalTurns=999 → clamp 到 200：第 201 轮再注入", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming(999));
    expect((await injector.execute(makeCtx())).length).toBe(1);
    for (let t = 2; t <= 200; t++) {
      expect(await injector.execute(makeCtx())).toEqual([]);
    }
    expect((await injector.execute(makeCtx())).length).toBe(1);
  });

  it("空槽（identity/self_identity 全缺）→ 零块（宁缺毋滥）", async () => {
    stubSlots([SLOTS[2]]);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming());
    expect(await injector.execute(makeCtx())).toEqual([]);
  });

  it("Gate：资产位关 / 非动作点（user 尾）→ 零块", async () => {
    stubSlots(SLOTS);
    const injector = new TdaiSoulReanchorInjector(makeConfig(), autoTiming());
    const offCtx = makeCtx();
    (offCtx.metadata.custom as Record<string, unknown>).assetCapabilities = { chat_memory: false };
    expect(await injector.execute(offCtx)).toEqual([]);
    const userTail = makeCtx();
    userTail.messages = userTail.messages.slice(0, 2); // user 尾，非 tool_result
    expect(await injector.execute(userTail)).toEqual([]);
  });
});

describe("#59 renderReanchorLines（纯函数）", () => {
  it("常量合同：REANCHOR_MAX_LINES=8、REANCHOR_LINE_MAX_CHARS=120", () => {
    expect(REANCHOR_MAX_LINES).toBe(8);
    expect(REANCHOR_LINE_MAX_CHARS).toBe(120);
  });

  it("行数 cap 8（跨槽累计）+ 逐行 tag + 只认 identity/self_identity", () => {
    const many = Array.from({ length: 10 }, (_, i) => "- identity 行" + (i + 1) + "。").join("\n");
    const lines = renderReanchorLines([
      { slot: "identity", content: many },
      { slot: "self_identity", content: SELF_A },
      { slot: "strict_rule", content: REDLINE },
    ]);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("- [identity] identity 行1。");
    expect(lines[7]).toBe("- [identity] identity 行8。");
    expect(lines.some((l) => l.includes("strict_rule"))).toBe(false);
  });

  it("长行截断 120（tag 形态不变形）", () => {
    const long = "- " + "长".repeat(130) + "。";
    const lines = renderReanchorLines([{ slot: "self_identity", content: long }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("- [self_identity] ")).toBe(true);
    expect([...lines[0]].length).toBeLessThanOrEqual(REANCHOR_LINE_MAX_CHARS);
  });
});
