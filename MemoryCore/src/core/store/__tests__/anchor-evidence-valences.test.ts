/**
 * M2-P1（S-CHAR-2/IF-1 同族）：anchorEvidenceValences 只读查询契约。
 *
 * 设计依据：DS-SOUL-EVOLUTION-001 §2.2/§7.2 + character-tension-m2-plan P1。
 *   - 数据源=l1_records.metadata_json 的 coreRefs/identityRefs 键族 + valence 列（既有列，零 schema 变更）
 *   - 租户三元组硬隔离（F18 同款）；valence IS NOT NULL 过滤
 *   - node 侧 JSON.parse 后按 label 展开（单查询全量+进程内聚合）；只读零写库
 *   - 接口为可选签名（recentAffectSignals 同位先例）；损坏 metadata_json 容忍（宽松解析不造假值）
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-ev-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  return { store, dir };
}

const T_A = { teamId: "t1", userId: "u1", agentId: "a1" };
const T_B = { teamId: "t1", userId: "u1", agentId: "a2" };

function mkRecord(
  id: string,
  occurredAt: string,
  valence: number | undefined,
  tenant: { teamId?: string; userId?: string; agentId?: string },
  metadata: Record<string, unknown> = {},
): MemoryRecord {
  return {
    id,
    content: `证据样本 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata,
    timestamps: [occurredAt],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    occurred_at: occurredAt,
    version: 1,
    sessionKey: "k",
    sessionId: "s-char",
    valence,
    ...tenant,
  } as MemoryRecord;
}

describe("M2-P1 anchorEvidenceValences（锚证据 valence 只读查询）", () => {
  it("① 租户三元组硬隔离：B agent 桶查不到 A agent 的证据行（F18 同款）", () => {
    const { store, dir } = makeStore("tenant");
    try {
      store.upsertL1(mkRecord("ae-1", new Date().toISOString(), 0.5, T_A, { coreRefs: ["数据隐私"] }), undefined);
      const b = store.anchorEvidenceValences!(T_B);
      expect(b).toEqual([]);
      const a = store.anchorEvidenceValences!(T_A);
      expect(a).toHaveLength(1);
      expect(a[0]).toEqual({ label: "数据隐私", valence: 0.5, ref_kind: "coreRefs" });
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("② valence IS NOT NULL 过滤：NULL valence 行不进入证据集（宁缺毋滥）", () => {
    const { store, dir } = makeStore("null");
    try {
      store.upsertL1(mkRecord("an-1", new Date().toISOString(), 0.6, T_A, { coreRefs: ["诚实"] }), undefined);
      store.upsertL1(mkRecord("an-2", new Date().toISOString(), 0.2, T_A, { coreRefs: ["诚实"] }), undefined);
      store.getRawDb().prepare("UPDATE l1_records SET valence=NULL WHERE record_id='an-2'").run();
      const rows = store.anchorEvidenceValences!(T_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].valence).toBeCloseTo(0.6, 5);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("③ coreRefs 多 label 展开：一条记忆 N 个 label → N 行（valence 同源复制）", () => {
    const { store, dir } = makeStore("expand");
    try {
      store.upsertL1(mkRecord("ax-1", new Date().toISOString(), -0.4, T_A, { coreRefs: ["数据隐私", "诚实"] }), undefined);
      const rows = store.anchorEvidenceValences!(T_A);
      expect(rows).toHaveLength(2);
      const labels = rows.map((r) => r.label);
      expect(labels).toHaveLength(2);
      // 中文 label 不做序断言（JS sort=UTF-16 码位序非语义序）——集合语义断言
      expect(labels).toContain("诚实");
      expect(labels).toContain("数据隐私");
      expect(rows.every((r) => r.ref_kind === "coreRefs" && Math.abs(r.valence - -0.4) < 1e-9)).toBe(true);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("④ identityRefs 展开：ref_kind 区分两种键族（identityRefs 切片弱口径如实透传）", () => {
    const { store, dir } = makeStore("identity");
    try {
      store.upsertL1(mkRecord("ai-1", new Date().toISOString(), 0.3, T_A, { identityRefs: ["用户重视女儿教育"] }), undefined);
      store.upsertL1(mkRecord("ai-2", new Date().toISOString(), -0.2, T_A, { coreRefs: ["数据隐私"] }), undefined);
      const rows = store.anchorEvidenceValences!(T_A);
      expect(rows).toHaveLength(2);
      const ident = rows.filter((r) => r.ref_kind === "identityRefs");
      const core = rows.filter((r) => r.ref_kind === "coreRefs");
      expect(ident).toHaveLength(1);
      expect(ident[0].label).toBe("用户重视女儿教育");
      expect(core[0].label).toBe("数据隐私");
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("⑤ 损坏 metadata_json 容忍：坏行跳过不抛错，好行照常返回（宽松解析不造假值）", () => {
    const { store, dir } = makeStore("broken");
    try {
      store.upsertL1(mkRecord("ab-1", new Date().toISOString(), 0.5, T_A, { coreRefs: ["诚实"] }), undefined);
      store.upsertL1(mkRecord("ab-2", new Date().toISOString(), 0.9, T_A, { coreRefs: ["数据隐私"] }), undefined);
      store.getRawDb().prepare("UPDATE l1_records SET metadata_json='{broken' WHERE record_id='ab-2'").run();
      const rows = store.anchorEvidenceValences!(T_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe("诚实");
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("⑥ 非字符串元素与空数组跳过：不产出伪 label 行（宁缺毋滥）", () => {
    const { store, dir } = makeStore("robust");
    try {
      store.upsertL1(mkRecord("ar-1", new Date().toISOString(), 0.1, T_A, { coreRefs: [], identityRefs: [123, "有效切片"] }), undefined);
      store.upsertL1(mkRecord("ar-2", new Date().toISOString(), 0.7, T_A, {}), undefined);
      const rows = store.anchorEvidenceValences!(T_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ label: "有效切片", valence: 0.1, ref_kind: "identityRefs" });
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });
});
