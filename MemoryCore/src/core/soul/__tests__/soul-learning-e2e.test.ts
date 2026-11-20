/**
 * 会学习（Round6）：错误被纠正 → 账本留痕 → 下一次组装卡时那条纠正真的进了注入段。
 * 只用临时库，不联网；rewriter 是确定性桩，事件由真实 L0 挖出来。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import { assembleSoulCard } from "../card-service.js";
import { resolveSoulConfig } from "../types.js";

const T = { teamId: "t-learn", userId: "u-learn", agentId: "a-learn" };
const LEARNED = "我宁可先跑一遍验证，也不把没验过的步骤写成已验证。";

function l0(id: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: "s-learn-1",
    sessionId: "s-learn-1",
    taskId: "task-learn",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

function dbOf(store: VectorStore) {
  return (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
}

function identityAdmits(store: VectorStore): Array<{ action: string; reason: string }> {
  return dbOf(store)
    .prepare("SELECT action, reason FROM soul_ledger WHERE layer = 'identity' ORDER BY at ASC")
    .all() as unknown as Array<{ action: string; reason: string }>;
}

describe("会学习：纠正进账本，下一次组卡带着它", () => {
  it("同一批纠正事件：第一次 admit 一条身份规则，下一次组装卡包含该条；重复 tick 不重复记", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-learn-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const rows = [
        l0("u1", "user", "这处不对，是不是你改坏的", "2026-11-05T03:00:00.000Z"),
        l0("a1", "assistant", "不是我造成的：这行代码我这一轮没动过，是上游接口返回了旧数据", "2026-11-05T03:01:00.000Z"),
        l0("u2", "user", "你又把没验过的步骤写成已验证了", "2026-11-05T03:10:00.000Z"),
        l0("a2", "assistant", "我漏了，这就补上，先跑一遍再写", "2026-11-05T03:11:00.000Z"),
      ];
      for (const r of rows) store.upsertL0(r, undefined);

      const recordRows = rows.map((r) => ({ id: r.id, content: r.messageText, occurredAt: r.recordedAt }));
      const base = {
        store,
        tenant: T,
        config: resolveSoulConfig({ minEvidence: 2, episodeWindowDays: 30, updateIntervalHours: 0 }),
        trigger: "manual" as const,
        llmCallBudget: 1,
        recentRecords: async () => recordRows,
      };
      let epIds: string[] = [];
      const rewriter = async (input: { episodes?: string[] }) => {
        epIds = (input.episodes ?? [])
          .map((line) => /^(ep-[A-Za-z0-9_-]+)/u.exec(line)?.[1])
          .filter((x): x is string => Boolean(x));
        return [{ layer: "identity" as const, text: LEARNED, evidenceIds: epIds }];
      };

      const first = await runSoulMaintenance({ ...base, now: "2026-11-05T12:00:00.000Z", rewriter });
      expect(epIds.length).toBeGreaterThanOrEqual(2);
      expect(first.admitted).toBeGreaterThanOrEqual(1);
      const admits1 = identityAdmits(store);
      expect(admits1.some((r) => r.action === "admit")).toBe(true);

      const card = await assembleSoulCard({
        store,
        tenant: T,
        now: "2026-11-05T12:05:00.000Z",
        persist: false,
        readAgentProfile: async () => ({ name: "青禾" }),
      });
      expect(card.identity.text).toContain(LEARNED);

      // 同一批事件再 tick 一次（没有新证据）：不允许长第二条同文规则
      await runSoulMaintenance({ ...base, now: "2026-11-05T12:30:00.000Z", rewriter });
      const items = await store.listSoulPersona(T);
      expect(items.filter((i) => i.layer === "identity" && i.text === LEARNED)).toHaveLength(1);
      const admits2 = identityAdmits(store);
      expect(admits2.filter((r) => r.action === "admit")).toHaveLength(1);
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
