/**
 * C1（ADR-0025）：task 隔离轴的**写读往返证明**——只钉契约，不改生产代码。
 *
 * 为什么需要这份证明：生产库 l1_records.task_id 4225/4225 空、l0_conversations.task_id
 * 14100/14100 空，容易被误判成「隔离轴只接了读、没接写」。实码复核结论相反——写读链
 * 逐跳本来就通：
 *   iso.taskId → gateway/v2-router.ts:1080（L0Record.taskId）
 *     → store/sqlite.ts upsertL0（stmtUpsertL0 绑定 task_id）
 *     → queryL0GroupedBySessionId（groupKey 含 taskId）
 *     → utils/pipeline-factory.ts:810 → record/l1-extractor.ts → record/l1-writer.ts:321
 *     → store/sqlite.ts upsertL1（stmtUpsertMeta 绑定 task_id）。
 * 0 填充的唯一原因在**生产者侧**：发 iso.taskId 的 TDAI MemoryProxy preset/task 头在
 * DSH 特化波次退场，dsh-plugin 从不发该字段（ADR-0025 C1 记录了裁决：挂起，不删列）。
 *
 * 本文件用真实 VectorStore（临时目录 + dims=0，离线）证明四件事：
 *  1. upsertL1 带 taskId → 底表 task_id 落库，且按 taskId 过滤只命中该 task；
 *  2. L0 同理（upsertL0 → queryL0Paginated taskId）；
 *  3. 不传 taskId = broad recall（不加过滤，全量命中）——不是「空 task 只匹配空」；
 *  4. 同 record_id 二次写不传 taskId/source_message_ids 时**不清空已存值**（粘性列，
 *     ADR-0025 D3 已修：ON CONFLICT 取 COALESCE(NULLIF(excluded.x,''),x)）。
 *
 * 铁律：不连生产库。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";
import type { L0Record } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const dirs: string[] = [];
const stores: VectorStore[] = [];

// Windows EBUSY：句柄未关即 rmSync 会锁临时文件——afterEach 先 close 再删目录。
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeStore(): VectorStore {
  const store = new VectorStore(join(tmpDir("l1-task-iso-"), "vectors.db"), 0);
  stores.push(store);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return store;
}

const rawDb = (store: VectorStore) =>
  (store as unknown as {
    db: { prepare(sql: string): { get(...p: unknown[]): unknown } };
  }).db;

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "trace",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-01T00:00:00Z"],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    version: 0,
    sessionKey: "k1",
    sessionId: "s1",
    ...over,
  }) as MemoryRecord;

const mkL0 = (id: string, over: Partial<L0Record> = {}): L0Record => ({
  id,
  sessionKey: "k1",
  sessionId: "s1",
  role: "user",
  messageText: `消息 ${id}`,
  recordedAt: "2026-11-01T00:00:00.000Z",
  timestamp: Date.parse("2026-11-01T00:00:00.000Z"),
  ...over,
});

describe("C1 L1：task 轴写读往返（upsertL1 → queryL1Paginated taskId 过滤）", () => {
  it("写入带 taskId → 底表落库；按 taskId 过滤只命中该 task，另一 task 查不到", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-alpha", { taskId: "task-alpha" }), undefined);
    store.upsertL1(mkRecord("m-beta", { taskId: "task-beta" }), undefined);

    const cell = rawDb(store)
      .prepare("SELECT task_id AS v FROM l1_records WHERE record_id = ?")
      .get("m-alpha") as { v: unknown };
    expect(cell.v).toBe("task-alpha");

    const alpha = store.queryL1Paginated({ taskId: "task-alpha", limit: 10, offset: 0 });
    expect(alpha.rows.map((r) => r.record_id)).toEqual(["m-alpha"]);
    expect(alpha.total).toBe(1);

    const beta = store.queryL1Paginated({ taskId: "task-beta", limit: 10, offset: 0 });
    expect(beta.rows.map((r) => r.record_id)).toEqual(["m-beta"]);

    const gamma = store.queryL1Paginated({ taskId: "task-gamma", limit: 10, offset: 0 });
    expect(gamma.rows).toEqual([]);
    expect(gamma.total).toBe(0);
  });

  it("不传 taskId = broad recall：不过滤，两个 task 的行都在（不是「空 task 只匹配空」）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-alpha", { taskId: "task-alpha" }), undefined);
    store.upsertL1(mkRecord("m-beta", { taskId: "task-beta" }), undefined);

    const all = store.queryL1Paginated({ limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.record_id).sort()).toEqual(["m-alpha", "m-beta"]);
    expect(all.total).toBe(2);
  });

  it("getL1ByIds 读回 task_id（编辑链以它重建记录，读侧不是残废字段）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-alpha", { taskId: "task-alpha" }), undefined);
    const rows = store.getL1ByIds(["m-alpha"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe("task-alpha");
  });
});

describe("C1 L0：task 轴写读往返（upsertL0 → queryL0Paginated taskId 过滤）", () => {
  it("L0 写入带 taskId → 按 taskId 过滤只命中该 task；不传则全量", () => {
    const store = makeStore();
    store.upsertL0(mkL0("l0-alpha", { taskId: "task-alpha" }), undefined);
    store.upsertL0(mkL0("l0-beta", { taskId: "task-beta" }), undefined);

    const alpha = store.queryL0Paginated({ taskId: "task-alpha", limit: 10, offset: 0 });
    expect(alpha.rows.map((r) => r.record_id)).toEqual(["l0-alpha"]);

    const all = store.queryL0Paginated({ limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.record_id).sort()).toEqual(["l0-alpha", "l0-beta"]);
  });
});

describe("C1 幂等：隔离轴与溯源是粘性列（ADR-0025 D3 已修）", () => {
  // 定案依据：编辑/重要度/失效三条重建链以 getL1ByIds 取行后整行 upsert，一旦漏带
  // taskId 或 source_message_ids，excluded 覆盖会把它们刷成 ''/'[]' —— 等于把记忆从
  // 它的隔离桶里抹掉、把原话证据抹掉。修法=ON CONFLICT 用 COALESCE(NULLIF(excluded.x,''),x)：
  // 「本次没带」与「显式清空」在语义上不可区分，因此一律按"没带"处理（只增不减）。
  it("二次写不传 taskId 不清空已存 task_id", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-alpha", { taskId: "task-alpha" }), undefined);
    store.upsertL1(mkRecord("m-alpha", { content: "改后的内容" }), undefined);
    const after = store.queryL1Paginated({ limit: 10, offset: 0 }).rows[0];
    expect(after.task_id).toBe("task-alpha");
    expect(after.content).toBe("改后的内容"); // 其余列照常被新值覆盖
  });

  it("二次写不带 source_message_ids 不清空已存溯源", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-beta", { source_message_ids: ["m1", "m2"] }), undefined);
    store.upsertL1(mkRecord("m-beta", { content: "改后的内容", source_message_ids: [] }), undefined);
    expect(store.getL1ByIds(["m-beta"])[0].source_message_ids).toEqual(["m1", "m2"]);
  });

  it("显式给出新值则照常覆盖（粘性不是只读）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("m-gamma", { taskId: "task-a", source_message_ids: ["m1"] }), undefined);
    store.upsertL1(mkRecord("m-gamma", { taskId: "task-b", source_message_ids: ["m9"] }), undefined);
    const row = store.getL1ByIds(["m-gamma"])[0];
    expect(row.task_id).toBe("task-b");
    expect(row.source_message_ids).toEqual(["m9"]);
  });
});
