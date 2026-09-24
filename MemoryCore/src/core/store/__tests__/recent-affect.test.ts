/**
 * M1-S1（S-FEEL-1/IF-1）：recentAffectSignals 只读查询契约。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §1.2/§7.1 + M1 实施计划 S1。
 *   - 数据源=l1_records.valence/arousal/occurred_at（既有列，零 schema 变更）
 *   - 租户三元组硬隔离（F18 同款）；valence IS NOT NULL 过滤
 *   - 样本窗 occurred_at ≥ now−windowHours（UTC ISO 字典序比较成立）；DESC 取 ≤maxSamples
 *   - 只读零写库；接口为可选签名（缺实现=调用侧静默省略基调行，宁缺毋滥）
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recent-affect-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  return { store, dir };
}

const T_A = { teamId: "t1", userId: "u1", agentId: "a1" };
const T_B = { teamId: "t1", userId: "u1", agentId: "a2" };

function mkRecord(id: string, occurredAt: string, valence: number | undefined, tenant: { teamId?: string; userId?: string; agentId?: string }, arousal?: number): MemoryRecord {
  return {
    id,
    content: `情感样本 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [occurredAt],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    occurred_at: occurredAt,
    version: 1,
    sessionKey: "k",
    sessionId: "s-mood",
    valence,
    arousal,
    ...tenant,
  } as MemoryRecord;
}

const hoursAgoIso = (h: number): string => new Date(Date.now() - h * 3600e3).toISOString();

describe("M1-S1 recentAffectSignals（近期情感信号只读查询）", () => {
  it("① 租户三元组硬隔离：B agent 桶查不到 A agent 的情感样本（F18 同款）", () => {
    const { store, dir } = makeStore("tenant");
    try {
      store.upsertL1(mkRecord("ra-1", hoursAgoIso(1), 0.5, T_A, 0.5), undefined);
      store.upsertL1(mkRecord("ra-2", hoursAgoIso(2), -0.4, T_A, 0.3), undefined);
      const b = store.recentAffectSignals(T_B, { windowHours: 72, maxSamples: 20 });
      expect(b).toEqual([]);
      const a = store.recentAffectSignals(T_A, { windowHours: 72, maxSamples: 20 });
      expect(a).toHaveLength(2);
      expect(a.every((r) => typeof r.valence === "number" && r.occurred_at.length > 0)).toBe(true);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("② valence IS NOT NULL 过滤：NULL valence 行不进入样本（基调行宁缺毋滥）", () => {
    const { store, dir } = makeStore("null");
    try {
      store.upsertL1(mkRecord("rn-1", hoursAgoIso(1), 0.6, T_A, 0.4), undefined);
      store.upsertL1(mkRecord("rn-2", hoursAgoIso(2), 0.2, T_A, 0.4), undefined);
      store.upsertL1(mkRecord("rn-3", hoursAgoIso(3), 0.9, T_A, 0.4), undefined);
      store.getRawDb().prepare("UPDATE l1_records SET valence=NULL WHERE record_id='rn-3'").run();
      const rows = store.recentAffectSignals(T_A, { windowHours: 72, maxSamples: 20 });
      expect(rows.map((r) => r.occurred_at).length).toBe(2);
      expect(rows.every((r) => r.valence !== null && r.valence !== undefined)).toBe(true);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("③ LIMIT 与排序：maxSamples 截断且 occurred_at DESC（最新在前）", () => {
    const { store, dir } = makeStore("limit");
    try {
      for (let i = 1; i <= 5; i++) store.upsertL1(mkRecord(`rl-${i}`, hoursAgoIso(i), 0.1 * i, T_A, 0.5), undefined);
      const rows = store.recentAffectSignals(T_A, { windowHours: 72, maxSamples: 3 });
      expect(rows).toHaveLength(3);
      const times = rows.map((r) => r.occurred_at);
      expect([...times].sort().reverse()).toEqual(times);
      expect(rows[0].valence).toBeCloseTo(0.1, 5); // 最近 1h 前的样本
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("④ 样本窗：windowHours 之外的旧样本排除", () => {
    const { store, dir } = makeStore("window");
    try {
      store.upsertL1(mkRecord("rw-in", hoursAgoIso(0.5), 0.5, T_A, 0.5), undefined);
      store.upsertL1(mkRecord("rw-out", hoursAgoIso(5), 0.9, T_A, 0.5), undefined);
      const rows = store.recentAffectSignals(T_A, { windowHours: 1, maxSamples: 20 });
      expect(rows).toHaveLength(1);
      expect(rows[0].valence).toBeCloseTo(0.5, 5);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("⑤ 全 NULL valence 租户返回 []（降级路径=基调行静默省略）", () => {
    const { store, dir } = makeStore("allnull");
    try {
      store.upsertL1(mkRecord("ra-n1", hoursAgoIso(1), 0.3, T_A, 0.5), undefined);
      store.getRawDb().prepare("UPDATE l1_records SET valence=NULL").run();
      const rows = store.recentAffectSignals(T_A, { windowHours: 72, maxSamples: 20 });
      expect(rows).toEqual([]);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });
});
