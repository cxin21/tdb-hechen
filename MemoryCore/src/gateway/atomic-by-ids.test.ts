/**
 * F-CLUSTER §5 Panel 簇视图数据端 TDD（2026-09-30）：/v3/atomic/by-ids。
 * RED 判据：租户隔离行过滤 / 缺头拒绝写明头名 / schema 上限 / archived 标记。
 */
import { describe, it, expect } from "vitest";
import { handleAtomicByIds, filterByIsolation } from "./atomic-by-ids.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { L1SearchResult } from "../core/store/types.js";

const ISO = { teamId: "t-1", userId: "u-1", agentId: "a-1", sessionId: "s-1" };

function row(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id, content: "内容" + id, type: "work_fact", priority: 0, scene_name: "",
    score: 0, timestamp_str: "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "", session_id: "s-1", team_id: "t-1", task_id: "", user_id: "u-1",
    agent_id: "a-1", metadata_json: "{}",
    ...over,
  };
}

function makeDeps(opts: {
  withArchive?: L1SearchResult[];
  live?: L1SearchResult[];
  missing?: string[];
}): V2RouterDeps {
  return {
    requestIsolation: opts.missing ? undefined : ISO,
    requestIsolationMissing: opts.missing,
    getStore: () => ({
      getL1ByIdsWithArchive: (ids: string[]) =>
        (opts.withArchive ?? []).filter((r) => ids.includes(r.record_id)),
      getL1ByIds: (ids: string[]) =>
        (opts.live ?? opts.withArchive ?? []).filter((r) => ids.includes(r.record_id)),
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as V2RouterDeps;
}

describe("/v3/atomic/by-ids", () => {
  it("T1 行级租户过滤：同租户保留、跨租户行剔除", async () => {
    const rows = [row("r1"), row("r2", { team_id: "t-EVIL" }), row("r3", { user_id: "u-EVIL" })];
    const out = await handleAtomicByIds(
      { ids: ["r1", "r2", "r3"] }, {} as never, "req-1",
      makeDeps({ withArchive: rows }),
    );
    expect(out.code).toBe(0);
    const items = (out.data as { items: L1SearchResult[] }).items;
    expect(items.map((r) => r.record_id)).toEqual(["r1"]);
  });

  it("T2 缺租户头→400 且写明缺失头名", async () => {
    const out = await handleAtomicByIds(
      { ids: ["r1"] }, {} as never, "req-2",
      makeDeps({ missing: ["x-tdai-team-id"], withArchive: [row("r1")] }),
    );
    expect(out.code).toBe(400);
    expect(out.message).toContain("x-tdai-team-id");
  });

  it("T3 schema 边界：ids 空 / 超 100 → 400", async () => {
    const deps = makeDeps({ withArchive: [] });
    expect((await handleAtomicByIds({ ids: [] }, {} as never, "r3", deps)).code).toBe(400);
    const big = Array.from({ length: 101 }, (_, i) => "id" + i);
    expect((await handleAtomicByIds({ ids: big }, {} as never, "r4", deps)).code).toBe(400);
  });

  it("T4 archived 标记：实时面缺失而归档桶命中 → archived:true", async () => {
    const archived = [row("old-1")];
    const out = await handleAtomicByIds(
      { ids: ["old-1"] }, {} as never, "req-4",
      makeDeps({ withArchive: archived, live: [] }),
    );
    expect(out.code).toBe(0);
    const items = (out.data as { items: Array<L1SearchResult & { archived?: boolean }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].archived).toBe(true);
  });

  it("T5 死 id 自然跳过（store 未返回该行则 items 不含）", async () => {
    const out = await handleAtomicByIds(
      { ids: ["live-1", "dead-9"] }, {} as never, "req-5",
      makeDeps({ withArchive: [row("live-1")], live: [row("live-1")] }),
    );
    const items = (out.data as { items: Array<L1SearchResult & { archived?: boolean }> }).items;
    expect(items.map((r) => r.record_id)).toEqual(["live-1"]);
    expect(items[0].archived).toBe(false);
  });

  it("T6 filterByIsolation 直测：iso 无 teamId 时 team 不过滤（与 search filter 语义一致）", () => {
    const iso = { userId: "u-1", agentId: "a-1", sessionId: "s-1" };
    expect(filterByIsolation([row("x", { team_id: "t-ANY" })], iso)).toHaveLength(1);
    expect(filterByIsolation([row("x")], undefined)).toHaveLength(0);
  });
});
