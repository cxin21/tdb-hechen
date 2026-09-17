/**
 * P2 Task 1（DS-SOUL-MEMORY-002 §2.6）：core_values 人物锚双节点扩列测试。
 * node_type/attrs_json 幂等 ALTER（T12 模式）+ upsertValue 扩参 + 读路扩列
 * + backfillMemoryRef 通用键族（coreRefs/personRefs/identityRefs 单源）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";
import type { MemoryRecord, CoreTenant } from "./core/store/types.js";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

async function makeStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "p2-t1-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), 0);
  await s.init();
  return s;
}
const T: CoreTenant = { teamId: "t", userId: "u", agentId: "a" };
function mkRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 0.5,
    certainty: "observed",
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-17T00:00:00Z"],
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    occurred_at: "2026-09-17T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: "t",
    userId: "u",
    agentId: "a",
  } as unknown as MemoryRecord;
}

describe("P2 core_values 扩列（node_type/attrs_json）", () => {
  it("upsertValue person：node_type/attrs_json 落库且读回", async () => {
    const s = await makeStore();
    expect(s.upsertValue("v1", "女儿", 0.6, "auto-growth", T, 1, "auto", "person", { role: "家人", aliases: ["闺女"] })).toBe(true);
    const rows = s.listValues(T);
    expect(rows[0]!.node_type).toBe("person");
    expect(JSON.parse(rows[0]!.attrs_json)).toEqual({ role: "家人", aliases: ["闺女"] });
  });

  it("DO UPDATE 不碰 node_type/attrs_json（theme 侧调用零改动重写不丢人物属性）", async () => {
    const s = await makeStore();
    s.upsertValue("v1", "女儿", 0.6, "auto-growth", T, 1, "auto", "person", { role: "家人" });
    s.upsertValue("v1", "女儿", 0.9, "auto-growth", T, 1, "auto");
    const row = s.listValues(T)[0]!;
    expect(row.node_type).toBe("person");
    expect(JSON.parse(row.attrs_json)).toEqual({ role: "家人" });
    expect(row.weight).toBe(0.9);
  });

  it("缺省 node_type='theme' / attrs_json='{}'（既有调用方逐位现状）", async () => {
    const s = await makeStore();
    s.upsertValue("t1", "数据隐私", 0.5, "manual", T);
    const row = s.listValues(T)[0]!;
    expect(row.node_type).toBe("theme");
    expect(row.attrs_json).toBe("{}");
  });

  it("listValuesAnyState 同样携带 node_type/attrs_json", async () => {
    const s = await makeStore();
    s.upsertValue("p1", "老周", 0.5, "auto-growth", T, undefined, "auto", "person", { role: "朋友", aliases: ["老周头"] });
    const rows = s.listValuesAnyState(T);
    expect(rows[0]!.node_type).toBe("person");
    expect(JSON.parse(rows[0]!.attrs_json).aliases).toEqual(["老周头"]);
  });
});

describe("P2 backfillMemoryRef 通用键族", () => {
  it("三键族写入 metadata_json 且同键去重；原 backfillCoreRef 行为保持", async () => {
    const s = await makeStore();
    s.upsertL1(mkRecord("r1", "女儿今天月考"), undefined);
    expect(s.backfillMemoryRef!("r1", "personRefs", "女儿", T)).toBe(true);
    expect(s.backfillMemoryRef!("r1", "personRefs", "女儿", T)).toBe(false);
    expect(s.backfillMemoryRef!("r1", "identityRefs", "用户重视女儿教育", T)).toBe(true);
    expect(s.backfillMemoryRef!("r1", "coreRefs", "数据隐私", T)).toBe(true);
    const db = (s as unknown as { db: { prepare: (q: string) => { get: (...a: unknown[]) => { metadata_json: string } | undefined } } }).db;
    const row = db.prepare("SELECT metadata_json FROM l1_records WHERE record_id='r1'").get() as { metadata_json: string };
    const meta = JSON.parse(row.metadata_json);
    expect(meta.personRefs).toEqual(["女儿"]);
    expect(meta.identityRefs).toEqual(["用户重视女儿教育"]);
    expect(meta.coreRefs).toEqual(["数据隐私"]);
  });
});
