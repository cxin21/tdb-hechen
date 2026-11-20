/**
 * A1 Round12：回滚不得把已取代（validTo 非空）的行洗回可见。
 *
 * 保留键 validTo / supersededBy / supersededReason 存在行顶层，落库时被打进
 * meta_json。回滚 upsert 若只写 before.meta（旧实现），历史账本条目恢复后这些键
 * 全丢：行会以 active 回到读侧，等于把「已被新结论取代」的旧说法复活。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { makePersonaItem } from "../persona.js";
import type { SoulLedgerEntry } from "../types.js";

const T = { teamId: "t-rbk", userId: "u-rbk", agentId: "a-rbk" };

function ledger(
  action: string,
  itemId: string,
  before: ReturnType<typeof makePersonaItem> | null,
  at: string,
): SoulLedgerEntry {
  return {
    entryId: `led-${action}-${itemId}-${at}`,
    at,
    trigger: "manual",
    layer: before?.layer ?? "identity",
    itemId,
    action: action as SoulLedgerEntry["action"],
    gates: [],
    reason: "test",
    evidenceIds: [],
    before,
  };
}

describe("回滚保留键（A1 Round12）", () => {
  it("恢复被取代的行时 validTo / supersededBy 不丢", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-rbk-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");

      const v1 = {
        ...makePersonaItem({
          layer: "identity",
          text: "我亲手跑过才算数",
          now: "2026-11-01T00:00:00.000Z",
          weight: 0.9,
        }),
        validTo: "2026-11-04T00:00:00.000Z",
        supersededBy: "identity:next",
        supersededReason: "被新证据取代",
      };
      await store.commitSoulPersona(T, {
        upsert: [v1],
        ledger: [ledger("admit", v1.itemId, null, "2026-11-01T00:00:00.000Z")],
      });

      const v2 = {
        ...v1,
        text: "我亲手跑过才算数（新说法）",
        updatedAt: "2026-11-05T00:00:00.000Z",
      };
      await store.commitSoulPersona(T, {
        upsert: [v2],
        ledger: [ledger("update", v1.itemId, v1, "2026-11-05T00:00:00.000Z")],
      });

      const rb = store.rollbackSoulPersona(T, [v1.itemId]);
      expect(rb.restored).toBe(1);

      const row = store
        .listSoulPersona(T, { includeSuperseded: true })
        .find((x) => x.itemId === v1.itemId);
      expect(row).toBeTruthy();
      expect(row?.text).toBe("我亲手跑过才算数");
      // 旧实现这两条都是 undefined
      expect(row?.validTo).toBe("2026-11-04T00:00:00.000Z");
      expect(row?.supersededBy).toBe("identity:next");
      expect(row?.supersededReason).toBe("被新证据取代");
    } finally {
      (store as unknown as { close?: () => void }).close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
