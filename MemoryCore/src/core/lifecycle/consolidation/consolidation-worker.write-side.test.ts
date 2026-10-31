/**
 * #155 写面：巩固产出的「证据链」必须真的落库、且两套证据口径一致。
 *
 * 审计结论（docs/audit/2026-10-31-open-issues-first-principles.md §4 #155）：
 * 「读写全断」这个判定是假的——写面确实在建 part_of 边。真问题有两个：
 *  1) M3：addLink 返回 MaybePromise<boolean>（store/types.ts:736），旧实现 for 循环里不 await，
 *     异步 store 下 runConsolidation 先返回、边在之后才落（或随失败静默丢）⇒ 读面
 *     getLinksBySource 永远空 ⇒ 看起来像「从没写过」。
 *  2) 口径分叉：边是 ON CONFLICT 幂等累积，而 metadata.evidence_ids 旧实现每轮整列覆盖成
 *     「本轮组内源」——复蒸馏后边=累计 N 轮、metadata=仅最近一轮，任何一方做回退都会看到
 *     不完整的证据集。
 *
 * 本文件锁：①runConsolidation 返回时边已落定（异步 store 也如此）；②边参数正确；
 * ③复蒸馏后 evidence_ids 与 part_of 边集合相等；④单边失败 soft-fail 不阻塞其余边/不中断巩固。
 */
import { describe, expect, it } from "vitest";
import { runConsolidation } from "./consolidation-worker.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const del = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SUBJECT = "L1 提取管线修复";

function src(id: string, day: number): MemoryRecord {
  const ts = `2026-10-0${day}T00:00:00.000Z`;
  return {
    id,
    content: `第 ${day} 天：继续修 L1 提取管线 ${id}`,
    type: "episodic",
    priority: 60,
    scene_name: "修复 L1",
    source_message_ids: [],
    metadata: { subject: SUBJECT } as Record<string, unknown> as MemoryRecord["metadata"],
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    version: 1,
    sessionKey: "s",
    sessionId: "s",
    occurred_at: ts,
    certainty: "observed",
    valence: 0,
    arousal: 0,
    significance: 0.6,
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
  } as unknown as MemoryRecord;
}

type Link = { sourceId: string; targetId: string; type: string; strength?: number };

/** 最小 store：upsertL1 按 id 覆盖；addLink 是**异步**（延迟落定），用来暴露未 await 的丢失。 */
function makeStore(opts?: { delayMs?: number; linkResult?: () => boolean | Promise<boolean> }) {
  const rows: MemoryRecord[] = [];
  const attempted: Link[] = [];
  const settled: Link[] = [];
  const store = {
    upsertL1: (rec: MemoryRecord) => {
      const i = rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) rows[i] = rec;
      else rows.push(rec);
      return true;
    },
    addLink: async (sourceId: string, targetId: string, type: string, strength?: number) => {
      const link = { sourceId, targetId, type, strength };
      attempted.push(link);
      await del(opts?.delayMs ?? 5);
      const ok = opts?.linkResult ? await opts.linkResult() : true;
      if (ok) settled.push(link);
      return ok;
    },
  };
  return { store, rows, attempted, settled };
}

const DURATIVE_JSON = '{"content":"用户长期在修 L1 提取管线，并把契约测试当成交付门槛","certainty":"observed"}';

function makeDeps(storeRows: { current: MemoryRecord[] }, store: unknown, warns: string[]) {
  return {
    queryL1: async () => storeRows.current,
    llmRunner: { run: async () => DURATIVE_JSON } as never,
    config: { enabled: true, minCount: 3, minSpanDays: 0, persist: true } as never,
    store: store as never,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => { warns.push(m); },
      error: () => {},
    } as never,
  };
}

function evidenceIdsOf(rec: MemoryRecord): string[] {
  const meta = (rec.metadata ?? {}) as Record<string, unknown>;
  return Array.isArray(meta.evidence_ids) ? (meta.evidence_ids as unknown[]).map(String) : [];
}

describe("#155 巩固写面：part_of 边 await + evidence_ids 同口径", () => {
  it("runConsolidation 返回时边已落定（异步 addLink 不被丢）", async () => {
    const { store, attempted, settled } = makeStore();
    const rows = { current: [src("r1", 1), src("r2", 3), src("r3", 5)] };
    const res = await runConsolidation(makeDeps(rows, store, []));
    expect(res.persisted).toBe(1);
    // 未 await 的旧实现：函数返回时 settled 还是 0（边在之后 5ms 才落）
    expect(settled).toHaveLength(3);
    expect(attempted).toHaveLength(3);
  });

  it("边参数正确：持续态 → 组内每条源记忆，type=part_of，strength=1", async () => {
    const { store, settled } = makeStore();
    const rows = { current: [src("r1", 1), src("r2", 3), src("r3", 5)] };
    await runConsolidation(makeDeps(rows, store, []));
    expect(settled.map((l) => l.targetId).sort()).toEqual(["r1", "r2", "r3"]);
    for (const l of settled) {
      expect(l.type).toBe("part_of");
      expect(l.strength).toBe(1);
      expect(l.sourceId).toBeTruthy();
      expect(l.targetId).not.toBe(l.sourceId);
    }
    // 同一个卡对全部源记忆（不是每条各自建一张卡）
    expect(new Set(settled.map((l) => l.sourceId)).size).toBe(1);
  });

  it("复蒸馏后 evidence_ids 与 part_of 边集合相等（不再整列覆盖成本轮）", async () => {
    const { store, settled, rows } = makeStore();
    const state = { current: [src("r1", 1), src("r2", 3), src("r3", 5)] };
    const first = await runConsolidation(makeDeps(state, store, []));
    expect(first.persisted).toBe(1);
    const durative = rows[0];
    const durativeId = String(durative.id);
    expect(evidenceIdsOf(durative).sort()).toEqual(["r1", "r2", "r3"]);

    // 第二轮：老源记忆退出（归档/老化），新三条进来；持续态自身留在 queryL1 结果里作幂等锚
    state.current = [durative, src("r4", 7), src("r5", 9), src("r6", 11)];
    const second = await runConsolidation(makeDeps(state, store, []));
    expect(second.persisted).toBe(1);
    const updated = rows[0];
    // 幂等：id 复用、版本递增（不是新建一张卡）
    expect(String(updated.id)).toBe(durativeId);
    expect(Number(updated.version)).toBe(2);
    const edges = settled.filter((l) => l.sourceId === durativeId).map((l) => l.targetId);
    expect(evidenceIdsOf(updated).sort()).toEqual([...edges].sort());
    expect(evidenceIdsOf(updated).sort()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  });

  it("单边失败 soft-fail：其余边照建，巩固不中断", async () => {
    let n = 0;
    const { store, attempted, settled } = makeStore({ linkResult: () => (n += 1) === 2 ? false : true });
    const rows = { current: [src("r1", 1), src("r2", 3), src("r3", 5)] };
    const warns: string[] = [];
    const res = await runConsolidation(makeDeps(rows, store, warns));
    expect(res.persisted).toBe(1);
    expect(attempted).toHaveLength(3);
    expect(settled).toHaveLength(2);
    expect(warns.some((w) => w.includes("part_of edge soft-failed"))).toBe(true);
  });

  it("addLink 抛错也不中断巩固（边失败 ≠ 卡失败）", async () => {
    const store = {
      upsertL1: () => true,
      addLink: async () => { throw new Error("link backend down"); },
    };
    const rows = { current: [src("r1", 1), src("r2", 3), src("r3", 5)] };
    const warns: string[] = [];
    const res = await runConsolidation(makeDeps(rows, store, warns));
    expect(res.persisted).toBe(1);
    expect(warns.filter((w) => w.includes("part_of edge soft-failed")).length).toBe(3);
  });
});
