/**
 * P0-3（task-1）FTS 重建（rebuildFtsIndex）事务化 RED→GREEN 套件。
 *
 * 背景（实测）：v6 剪枝判定（hasV6Pruned）后 migrateFtsTablesIfNeeded 会 DROP l1_fts/l0_fts，
 * init 随即调 rebuildFtsIndex() 从 l1_records / l0_conversations 重灌。旧实现是
 * DELETE + 逐行 try/catch warn + 外层 catch「non-fatal」——重建中途抛错时会留下一张
 * **半截索引**（被 DELETE 清空后只灌了一半），而且没有任何告警升级。本套件钉住：
 *   ​① 中途抛错 → rebuildFtsIndex 必须抛出（fail-loud），且索引回滚到重建前状态（不许半截）；
 *   ​② 正常重建 → 事务提交，旧脏行被清掉、主表行被灌入。
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const stores: Array<{ store: VectorStore; dir: string }> = [];

function makeStore(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-fts-rebuild-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）");
  stores.push({ store, dir });
  return store;
}

afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 无害 */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows EBUSY 无害 */
    }
  }
});

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `alpha 重建探针 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "rebuild-probe",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-04T00:00:00Z"],
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    version: 1,
    sessionKey: "k-rebuild",
    sessionId: "s-rebuild",
    ...over,
  }) as MemoryRecord;

function rawDb(store: VectorStore): {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown };
} {
  return (store as unknown as { db: ReturnType<typeof rawDb> }).db;
}

function countL1Fts(store: VectorStore): number {
  const row = rawDb(store).prepare("SELECT COUNT(*) AS n FROM l1_fts").get() as { n: number };
  return Number(row.n);
}

describe("P0-3 FTS 重建事务化", () => {
  it("重建中途抛错 → 抛出且索引回滚到重建前状态（不留半截）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r-keep"), undefined);
    // 造一条只存在于索引里的旧行（重建会先 DELETE 掉它）——用于判定是否回滚
    rawDb(store).exec(
      "INSERT INTO l1_fts (record_id, content, content_original, type) VALUES ('sentinel-old','zzsentinel','zzsentinel','episodic')",
    );
    expect(countL1Fts(store)).toBe(2);
    // 造一行 L0，使重建走到 L0 写入循环；再把该语句桩成抛错
    rawDb(store).exec(
      "INSERT INTO l0_conversations (record_id, session_key, message_text) VALUES ('l0-1','sk-rebuild','hello rebuild')",
    );
    const patched = {
      run: () => {
        throw new Error("boom-l0-insert");
      },
    };
    (store as unknown as Record<string, unknown>).stmtL0FtsInsert = patched;

    expect(() => store.rebuildFtsIndex()).toThrow(/boom-l0-insert/);

    // 回滚后：旧索引（r-keep + sentinel-old）逐行仍在
    expect(countL1Fts(store)).toBe(2);
    const kept = store.searchL1Fts("alpha", 5);
    expect(kept.map((r) => r.record_id)).toContain("r-keep");
    // fail-loud 但不降级：FTS 仍可用（重建失败不该把索引判死）
    expect(store.isFtsAvailable()).toBe(true);
  });

  it("正常重建 → 事务提交，脏行被清掉、主表行灌入", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r-keep"), undefined);
    rawDb(store).exec(
      "INSERT INTO l1_fts (record_id, content, content_original, type) VALUES ('sentinel-old','zzsentinel','zzsentinel','episodic')",
    );
    expect(countL1Fts(store)).toBe(2);

    store.rebuildFtsIndex();

    expect(countL1Fts(store)).toBe(1);
    const rows = store.searchL1Fts("alpha", 5);
    expect(rows.map((r) => r.record_id)).toEqual(["r-keep"]);
  });
});
