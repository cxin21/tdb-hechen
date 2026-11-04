/**
 * A 项 RED 套件（ADR-0025 决定 10，2026-11-04）：POST /atomic/sensitivity —— 显式降敏。
 *
 * 契约（owner 定案）：
 * - body { id, sensitivity, expect, reason? }；sensitivity/expect 都必须是可写白名单
 *   none|health|finance|relationship 之一（'unclassified' 是脏值归一结果，不可写）；
 * - CAS：expect 与库中当前值不一致 → 409（不泄漏行存在性 / 不盲覆盖并发改写）；
 * - 单向棘轮必须走 store.setL1Sensitivity（upsert 的粘性 CASE 永远无法把行降回 none）；
 * - 后端未实现 setL1Sensitivity → 501（fail-loud，不静默成功）；
 * - 跨租户 403 / 未知行 404 / 非法枚举 400；成功后写 memory_audit（action='sensitivity'）。
 */
import { describe, it, expect } from "vitest";
import { handleAtomicSensitivity } from "../v2-router.js";
import type { V2RouterDeps } from "../v2-router.js";
import type { L1RecordRow } from "../../core/store/types.js";

const ISO = { teamId: "t-1", userId: "u-1", agentId: "a-1", sessionId: "s-1" };

function l1Row(id: string, over: Partial<L1RecordRow> = {}): L1RecordRow {
  return {
    record_id: id, content: "内容" + id, type: "work_fact", priority: 50, scene_name: "",
    session_key: "", session_id: "s-1", team_id: "t-1", task_id: "", user_id: "u-1",
    agent_id: "a-1", version: 3, timestamp_str: "2026-10-14T00:00:00Z",
    timestamp_start: "", timestamp_end: "", created_time: "2026-10-14T00:00:00Z",
    updated_time: "2026-10-14T00:00:00Z", metadata_json: "{}",
    occurred_at: "2026-10-14T00:00:00Z", valid_start: null, valid_end: null,
    certainty: "observed", valence: 0.2, arousal: 0.1, significance: 0.8,
    sensitivity: "finance", importance: 2,
    ...over,
  } as L1RecordRow;
}

function makeDeps(row: L1RecordRow | undefined, opts: { noSetter?: boolean } = {}) {
  const calls: Array<{ recordId: string; value: string; expect: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const store: Record<string, unknown> = {
    getL1ByIds: (ids: string[]) => (row && ids.includes(row.record_id) ? [row] : []),
    appendAudit: (e: Record<string, unknown>) => { audits.push(e); return true; },
  };
  if (!opts.noSetter) {
    store.setL1Sensitivity = (recordId: string, value: string, expect: string) => {
      calls.push({ recordId, value, expect });
      // 真后端语义：expect 与当前值不符 → false（CAS 未命中）
      return row ? expect === (row.sensitivity ?? "none") : false;
    };
  }
  const deps: V2RouterDeps = {
    requestIsolation: ISO,
    getStore: () => store,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as V2RouterDeps;
  return { deps, calls, audits };
}

describe("POST /atomic/sensitivity（A 项：显式降敏 · 单向棘轮下限）", () => {
  it("成功：CAS 命中 → 单条 UPDATE 写 none，返回 previous/version，并记 sensitivity 审计", async () => {
    const { deps, calls, audits } = makeDeps(l1Row("r1"));
    const out = await handleAtomicSensitivity(
      { id: "r1", sensitivity: "none", expect: "finance", reason: "用户要求解除" },
      {} as never, "rq-1", deps,
    );
    expect(out.code).toBe(0);
    expect(calls).toEqual([{ recordId: "r1", value: "none", expect: "finance" }]);
    // 不走 upsert：绝不整行重写（否则 soul/source_message_ids 有刷空风险）
    expect((deps.getStore() as unknown as Record<string, unknown>).upsertL1).toBeUndefined();
    const d = out.data as { id: string; sensitivity: string; previous: string; sensitivity_source: string };
    expect(d.id).toBe("r1");
    expect(d.sensitivity).toBe("none");
    expect(d.previous).toBe("finance");
    expect(d.sensitivity_source).toBe("manual");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("sensitivity");
    expect(audits[0]!.record_id).toBe("r1");
  });

  it("CAS 未命中（expect 与库中不符）→ 409，且库没被改", async () => {
    const { deps, calls } = makeDeps(l1Row("r2", { sensitivity: "health" }));
    const out = await handleAtomicSensitivity(
      { id: "r2", sensitivity: "none", expect: "finance" },
      {} as never, "rq-2", deps,
    );
    expect(out.code).toBe(409);
    expect(calls).toHaveLength(1);            // 交给了 CAS，由后端判定
    expect((out as { message?: string }).message ?? "").not.toBe("");
  });

  it("非法枚举 → 400（'unclassified' / 'private' / 空串都拒绝；不调用 store）", async () => {
    const { deps, calls } = makeDeps(l1Row("r3"));
    for (const bad of ["unclassified", "private", "", "NONE"]) {
      const out = await handleAtomicSensitivity(
        { id: "r3", sensitivity: bad, expect: "finance" },
        {} as never, "rq-3", deps,
      );
      expect(out.code).toBe(400);
    }
    // expect 也必须在白名单内（脏值归一结果不可作为 CAS 条件）
    expect((await handleAtomicSensitivity(
      { id: "r3", sensitivity: "none", expect: "unclassified" }, {} as never, "rq-4", deps,
    )).code).toBe(400);
    // 缺 expect → 400（强制 CAS，不许盲覆盖）
    expect((await handleAtomicSensitivity(
      { id: "r3", sensitivity: "none" }, {} as never, "rq-5", deps,
    )).code).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("跨租户 403 / 未知行 404 / 缺 id 400", async () => {
    const { deps } = makeDeps(l1Row("r4"));
    expect((await handleAtomicSensitivity(
      { sensitivity: "none", expect: "finance" }, {} as never, "rq-6", deps,
    )).code).toBe(400);
    expect((await handleAtomicSensitivity(
      { id: "ghost", sensitivity: "none", expect: "finance" }, {} as never, "rq-7", deps,
    )).code).toBe(404);
    const { deps: evilDeps } = makeDeps(l1Row("r5", { team_id: "t-EVIL" }));
    expect((await handleAtomicSensitivity(
      { id: "r5", sensitivity: "none", expect: "finance" }, {} as never, "rq-8", evilDeps,
    )).code).toBe(403);
  });

  it("后端未实现 setL1Sensitivity → 501 fail-loud（不静默成功）", async () => {
    const { deps } = makeDeps(l1Row("r6"), { noSetter: true });
    const out = await handleAtomicSensitivity(
      { id: "r6", sensitivity: "none", expect: "finance" }, {} as never, "rq-9", deps,
    );
    expect(out.code).toBe(501);
  });

  it("存储抛错（degraded / SQL 失败）→ 503，不伪装成 409 CAS 未命中、不记审计", async () => {
    // 对抗评审 P1：此前 store 异常也 return false，网关一律 409「CAS 未命中」——
    // 主表可能已改，客户端按并发冲突重试永远失败，且审计无行。两类失败必须可区分。
    const audits: Array<Record<string, unknown>> = [];
    const store = {
      getL1ByIds: (ids: string[]) => (ids.includes("r8") ? [l1Row("r8")] : []),
      appendAudit: (e: Record<string, unknown>) => { audits.push(e); return true; },
      setL1Sensitivity: () => { throw new Error("database is locked"); },
    };
    const deps = {
      requestIsolation: ISO,
      getStore: () => store,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as V2RouterDeps;
    const out = await handleAtomicSensitivity(
      { id: "r8", sensitivity: "none", expect: "finance" }, {} as never, "rq-11", deps,
    );
    expect(out.code).toBe(503);
    expect((out as { message?: string }).message ?? "").toContain("database is locked");
    expect(audits).toHaveLength(0);
  });

  it("写 n 后降 none 后再用 expect='none' 可重复调用（幂等方向；改造幂等性）", async () => {
    const { deps, calls } = makeDeps(l1Row("r7", { sensitivity: "none" }));
    const out = await handleAtomicSensitivity(
      { id: "r7", sensitivity: "none", expect: "none" }, {} as never, "rq-10", deps,
    );
    expect(out.code).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
