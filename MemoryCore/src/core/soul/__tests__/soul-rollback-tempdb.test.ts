/**
 * 回滚演练（L3，临时库）：点名条目 → 恢复到最近一次变更前的快照；
 * 新建条目回滚即删除；全程写 rollback 账本。不碰生产库。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { makePersonaItem } from "../persona.js";
import type { SoulLedgerEntry } from "../types.js";

const T = { teamId: "t-rb", userId: "u-rb", agentId: "a-rb" };
const NOW = "2026-11-06T12:00:00.000Z";

function ledger(action: string, itemId: string, before: ReturnType<typeof makePersonaItem> | null, at: string): SoulLedgerEntry {
  return {
    entryId: `led-${action}-${itemId}-${at}`,
    at,
    trigger: "manual",
    layer: before?.layer ?? "self",
    itemId,
    action: action as SoulLedgerEntry["action"],
    gates: [],
    reason: "test",
    evidenceIds: [],
    before,
  };
}

describe("条目级回滚", () => {
  it("更新后可恢复到变更前；新建后回滚即删除；写 rollback 账本", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-rb-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const v1 = makePersonaItem({ layer: "self", text: "我没守住：先取证再改", now: "2026-11-06T01:00:00.000Z", weight: 0.7 });
      await store.commitSoulPersona(T, { upsert: [v1], ledger: [ledger("admit", v1.itemId, null, "2026-11-06T01:00:00.000Z")] });
      const v2 = { ...v1, text: "我改过口：先取证再改，后来按原话重做", updatedAt: "2026-11-06T02:00:00.000Z", weight: 0.73 };
      await store.commitSoulPersona(T, { upsert: [v2], ledger: [ledger("update", v1.itemId, v1, "2026-11-06T02:00:00.000Z")] });
      expect(store.listSoulPersona(T).find((x) => x.itemId === v1.itemId)?.text).toBe(v2.text);

      const out = store.rollbackSoulPersona(T, [v1.itemId], { now: NOW, reason: "演练" });
      expect(out).toEqual({ restored: 1, removed: 0, skipped: 0 });
      expect(store.listSoulPersona(T).find((x) => x.itemId === v1.itemId)?.text).toBe(v1.text);
      expect(store.listSoulLedger(T, 10).some((e) => e.action === "rollback" && e.itemId === v1.itemId)).toBe(true);

      const created = makePersonaItem({ layer: "values", text: "我宁可慢一点也要一手证据", now: "2026-11-06T03:00:00.000Z" });
      await store.commitSoulPersona(T, { upsert: [created], ledger: [ledger("admit", created.itemId, null, "2026-11-06T03:00:00.000Z")] });
      const out2 = store.rollbackSoulPersona(T, [created.itemId], { now: NOW });
      expect(out2).toEqual({ restored: 0, removed: 1, skipped: 0 });
      expect(store.listSoulPersona(T).some((x) => x.itemId === created.itemId)).toBe(false);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
