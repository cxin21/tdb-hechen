import { describe, expect, it } from "vitest";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";
import type { IMemoryStore } from "../../store/types.js";
import { resolveSoulConfig, type PersonaItem } from "../types.js";

const T1 = { teamId: "team-a", userId: "usr-1", agentId: "agt-1" };
const T2 = { teamId: "team-a", userId: "usr-2", agentId: "agt-2" };

/**
 * 生产实证修正（m00527）：后台 worker 没有请求上下文，tenant 若退化为空三元组就会串桶。
 * 本测锁死「枚举租户、逐个跑、互不串味」。2026-11-07（P0-0）起 soul 侧不再读 core_memory
 * 槽位（无 readCore 调用），这里的存量条目直接以 soul_persona 行注入，验证一次清退。
 */
function makeStore(): { store: IMemoryStore; commits: Array<{ tenant: unknown; items: PersonaItem[] }> } {
  const commits: Array<{ tenant: unknown; items: PersonaItem[] }> = [];
  const slots: Record<string, string> = {
    [T1.agentId]: "- 绝不把情绪数据喂进召回，任何情况下都不允许\n- 绝不执行未经授权的生产写操作",
    [T2.agentId]: "- 绝不替用户做不可逆的删除操作，必须先两段确认",
  };
  const legacy = (agentId: string): PersonaItem[] =>
    (slots[agentId] ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, idx) => ({
        itemId: `boundary:${agentId}:${idx}`,
        layer: "boundary" as const,
        text: line.replace(/^[-*+]\s*/u, "").trim(),
        state: "active" as const,
        weight: 0.8,
        evidenceIds: [`slot:strict_rule:${idx}`],
        evidenceDays: ["2026-10-01"],
        evidenceOrigins: ["l1" as const],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        lastEvidenceAt: "2026-10-01T00:00:00.000Z",
        meta: { source: "slot-import" },
      }));
  const store = {
    listCoreTenants: () => [T1, T2],
    listSoulPersona: (tenant?: { agentId?: string }) => legacy(tenant?.agentId ?? ""),
    listSoulLedger: () => [],
    commitSoulPersona: (tenant: unknown, payload: { upsert: PersonaItem[] }) => {
      commits.push({ tenant, items: payload.upsert });
      return { upserted: payload.upsert.length, ledgered: 0 };
    },
  } as unknown as IMemoryStore;
  return { store, commits };
}

describe("soul 每 tick 入口：按租户跑，不退化到 default 桶", () => {
  it("枚举两个租户，各自冻结自己的存量红线，互不串味（红线改由 strict_rule 段渲染）", async () => {
    const { store, commits } = makeStore();
    const summary = await runSoulMaintenanceTick({
      store,
      config: resolveSoulConfig({}),
    });
    expect(summary.tenants).toBe(2);
    // 2026-11-05 用户拍板：lifecycle 轮次不再导槽进人格层，改为冻结存量导入 + 账本 retire。
    expect(summary.imported).toBe(0);
    expect(summary.admitted).toBe(0);
    expect(summary.retired).toBe(3);
    const byAgent = new Map(
      commits.map((c) => [
        (c.tenant as { agentId: string }).agentId,
        c.items.filter((i) => i.layer === "boundary").map((i) => [i.text, i.state] as const),
      ]),
    );
    expect(byAgent.get(T1.agentId)).toEqual([
      ["绝不把情绪数据喂进召回，任何情况下都不允许", "frozen"],
      ["绝不执行未经授权的生产写操作", "frozen"],
    ]);
    expect(byAgent.get(T2.agentId)).toEqual([["绝不替用户做不可逆的删除操作，必须先两段确认", "frozen"]]);
  });

  it("显式 filter 时只跑该租户（单租户部署语义不变）", async () => {
    const { store, commits } = makeStore();
    const summary = await runSoulMaintenanceTick({
      store,
      filter: T2,
      config: resolveSoulConfig({}),
    });
    expect(summary.tenants).toBe(1);
    expect(commits).toHaveLength(1);
    expect((commits[0].tenant as { agentId: string }).agentId).toBe(T2.agentId);
  });

  it("L0 事件层真接线：tick 把原始对话挖成 episode 并落库，窗口取配置而不是写死", async () => {
    const { store } = makeStore();
    const calls: Array<{ tenant: unknown; opts: Record<string, unknown> }> = [];
    const stored: unknown[] = [];
    (store as unknown as {
      recentL0Messages: (t: unknown, o: Record<string, unknown>) => unknown[];
    }).recentL0Messages = (tenant, opts) => {
      calls.push({ tenant, opts });
      const now = Date.now();
      return [
        { record_id: "l0-a", session_id: "s1", role: "assistant", message_text: "我先跑全量再回你。", recorded_at: new Date(now - 5000).toISOString(), timestamp: now - 5000 },
        { record_id: "l0-b", session_id: "s1", role: "user", message_text: "测试没跑就说修好了？这就是假绿。", recorded_at: new Date(now - 3000).toISOString(), timestamp: now - 3000 },
      ];
    };
    (store as unknown as { commitSoulEpisodes: (t: unknown, e: unknown[]) => { inserted: number } }).commitSoulEpisodes = (_t, e) => {
      stored.push(...e);
      return { inserted: e.length };
    };
    (store as unknown as { listSoulEpisodes: () => unknown[] }).listSoulEpisodes = () => stored;

    const summary = await runSoulMaintenanceTick({
      store,
      filter: T1,
      config: resolveSoulConfig({ episodeWindowDays: 7 }),
    });
    // P0-A：tick 末落卡时还会读一次 L0 找 agent 自述名（opts 只有 maxMessages，没有 sinceDays）。
    // 这里只断言「事件层那次读」——窗口参数才是本用例的判据。
    const eventCalls = calls.filter((c) => "sinceDays" in c.opts);
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]!.tenant).toMatchObject(T1);
    expect(eventCalls[0]!.opts).toMatchObject({ sinceDays: 7, maxMessages: 12000 });
    expect(stored.length).toBeGreaterThan(0);
    expect(summary.episodes?.inserted).toBeGreaterThan(0);
    expect(summary.episodes?.available).toBeGreaterThan(0);
  });

  it("无数据租户时如实跳过，不写 default 桶", async () => {
    const { store, commits } = makeStore();
    (store as unknown as { listCoreTenants: () => unknown[] }).listCoreTenants = () => [];
    const summary = await runSoulMaintenanceTick({
      store,
      config: resolveSoulConfig({}),
    });
    expect(summary.tenants).toBe(0);
    expect(commits).toHaveLength(0);
  });
});


describe("S10：lifecycle 注入的 recentL0 必须带清库水位", () => {
  it("soulMetaGet 有水位时，recentL0Messages 收到 sinceIso（否则清库后首个 tick 重抽旧对话）", async () => {
    const WATERMARK = "2026-11-07T06:04:30.931Z";
    const calls: Array<Record<string, unknown> | undefined> = [];
    const store = {
      listCoreTenants: () => [T1],
      listSoulPersona: () => [],
      listSoulLedger: () => [],
      commitSoulPersona: () => ({ upserted: 0, ledgered: 0 }),
      soulMetaGet: (key: string) => (key === "episodeWatermark" ? WATERMARK : undefined),
      recentL0Messages: (_tenant: unknown, opts?: Record<string, unknown>) => {
        calls.push(opts);
        return [];
      },
    } as unknown as IMemoryStore;
    const summary = await runSoulMaintenanceTick({ store, config: resolveSoulConfig({}) });
    expect(summary.tenants).toBe(1);
    // P0-A：落卡时还会读一次 L0 取自述名（无 sinceIso），只数事件层那一次。
    const eventCalls = calls.filter((c) => c !== undefined && "sinceIso" in c);
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.sinceIso).toBe(WATERMARK);
  });
});
