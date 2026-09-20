/**
 * A-7b（用户已拍板）证据指针 RED→GREEN：
 * 提案协议增可选 support（样本行号 1..N）→ 确定性校验门（整数/窗内/去重/上限 5）→
 * identityRefs 精确回填到支撑行（摘要式改写不再依赖 12 字滑窗）→ supportMap 并入身份状态 kv →
 * GROW-MAINT 确定性重验（映射命中且引用行 active = 支撑；悬空/未命中回退滑窗）。
 * 向后兼容：无 support 字段 → 行为与现状逐位一致（滑窗路径）。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, identityFactSlice } from "./identity-discovery.js";
import { maintainIdentityFacts } from "./anchor-growth.js";

const TENANT = { teamId: "ev15-team", userId: "ev15-user-a", agentId: "ev15-agent-a" };
const NOW = () => new Date("2026-09-20T14:00:00Z");

function makeStore(rows: Array<{ record_id: string; content: string }>, existing: Array<{ slot: string; content: string }> = []) {
  const backfills: Array<{ rid: string; key: string; label: string }> = [];
  const coreUpserts: Array<{ slot: string; content: string }> = [];
  const state: Record<string, unknown> = { lastAttemptAt: null, lastCorpusCount: null };
  return {
    backfills, coreUpserts, state,
    queryL1Records: () => rows.map((r) => ({ ...r, significance: 0.9, updated_time: "2026-09-20T09:00:00Z" })),
    countL1: () => rows.length,
    readCore: () => existing,
    upsertCore: (slot: string, content: string, createdBy: string) => {
      coreUpserts.push({ slot, content });
      void createdBy;
      return true;
    },
    backfillMemoryRef: (rid: string, key: string, label: string) => {
      backfills.push({ rid, key, label });
      return true;
    },
    getIdentityDiscoveryState: async () => state,
    setIdentityDiscoveryState: async (s: Record<string, unknown>) => { Object.assign(state, s); },
  } as never;
}

const COFFEE_ROWS = [
  { record_id: "r1", content: "我只喝手冲咖啡，豆子每周自烘焙" },
  { record_id: "r2", content: "用户承诺每周五定时发送数据质量周报" },
];

async function run(store: never, reply: string) {
  return runIdentityDiscovery({
    store,
    llmRunner: { run: vi.fn().mockResolvedValue(reply) },
    logger: undefined,
    config: { intervalHours: 24 },
    selfIdentity: { enabled: false, maxPerPass: 2 },
    now: NOW,
  });
}

describe("A-7b 支撑样本指针", () => {
  it("①合法 support → identityRefs 精确回填到支撑行（滑窗必然漏报的摘要式改写 = RED）", async () => {
    const store = makeStore(COFFEE_ROWS);
    await run(store, JSON.stringify([
      { slot: "identity", content: "用户是手冲咖啡爱好者，每周自烘焙豆子", rationale: "多源", support: [1] },
    ]));
    const caps = (store as never as { backfills: Array<{ rid: string; label: string }> }).backfills;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.rid).toBe("r1");
    expect(caps[0]!.label).toBe(identityFactSlice("用户是手冲咖啡爱好者，每周自烘焙豆子"));
  });

  it("②非法编号全弃 → 滑窗兜底（向后兼容语义）", async () => {
    const store = makeStore(COFFEE_ROWS);
    await run(store, JSON.stringify([
      { slot: "identity", content: "用户承诺每周五定时发送数据质量周报给团队", rationale: "多源", support: [99, 0, -1, 1.5] },
    ]));
    const caps = (store as never as { backfills: Array<{ rid: string }> }).backfills;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.rid).toBe("r2");
  });

  it("③编号上限 5（超量截断，防投机全选）", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ record_id: `r${i + 1}`, content: `第${i + 1}条记忆内容` }));
    const store = makeStore(rows);
    await run(store, JSON.stringify([
      { slot: "identity", content: "用户是手冲咖啡爱好者，每周自烘焙豆子", rationale: "多源", support: [1, 2, 3, 4, 5, 6, 7] },
    ]));
    const caps = (store as never as { backfills: Array<{ rid: string }> }).backfills;
    expect(caps).toHaveLength(5);
  });

  it("④supportMap 并入身份状态 kv（GROW-MAINT 确定性重验的数据前提 = RED）", async () => {
    const store = makeStore(COFFEE_ROWS);
    await run(store, JSON.stringify([
      { slot: "identity", content: "用户是手冲咖啡爱好者，每周自烘焙豆子", rationale: "多源", support: [1] },
    ]));
    const st = (store as never as { state: { supportMap?: Record<string, string[]> } }).state;
    expect(st.supportMap?.["用户是手冲咖啡爱好者，每周自烘焙豆子"]).toEqual(["r1"]);
  });

  it("⑤GROW-MAINT：映射命中且引用行 active → 支撑（不再 unsupported 假阳 = RED）", async () => {
    const fact = "用户是手冲咖啡爱好者，每周自烘焙豆子";
    const store = { readCore: () => [{ slot: "identity", content: `- ${fact}` }] };
    const unsupported = await maintainIdentityFacts(store as never, TENANT, ["我只喝手冲咖啡，豆子每周自烘焙"], undefined, {
      supportMap: { [fact]: ["r1"] },
      activeRecordIds: new Set(["r1"]),
    });
    expect(unsupported).toBe(0);
  });

  it("⑥GROW-MAINT：映射悬空且滑窗漏 → 仍告警（负控制，防永生事实）", async () => {
    const fact = "用户是手冲咖啡爱好者，每周自烘焙豆子";
    const store = { readCore: () => [{ slot: "identity", content: `- ${fact}` }] };
    const unsupported = await maintainIdentityFacts(store as never, TENANT, ["我只喝手冲咖啡，豆子每周自烘焙"], undefined, {
      supportMap: { [fact]: ["rArchived"] },
      activeRecordIds: new Set<string>(),
    });
    expect(unsupported).toBe(1);
  });

  it("⑦无 support 字段 → 滑窗路径逐位现状（回归控制）", async () => {
    const store = makeStore(COFFEE_ROWS);
    await run(store, JSON.stringify([
      { slot: "identity", content: "用户承诺每周五定时发送数据质量周报", rationale: "多源" },
    ]));
    const caps = (store as never as { backfills: Array<{ rid: string }> }).backfills;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.rid).toBe("r2");
  });
});
