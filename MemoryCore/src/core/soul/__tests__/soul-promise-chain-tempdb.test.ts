/**
 * 承诺链（临时库，不碰生产）：证明「事件史长出的承诺」真的落到 soul_promises 并会被兑现。
 *
 * 两轮维护，模拟生产形状：
 *   tick1（只有承诺那次对话）→ soul_promises 出现 status=open 的行（ref_key=对象锚）；
 *   tick2（同一对象后来补上了）→ settlePromises 判 kept → open→kept 事件，source=evidence。
 *
 * 只用 mkdtemp 临时 sqlite；不联网、不调 LLM（llmCallBudget=0）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";

const T = { teamId: "t-promise", userId: "u-promise", agentId: "a-promise" };

function l0(id: string, sessionId: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: sessionId,
    sessionId,
    taskId: "task-promise",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

const PROMISE_ROWS: L0Record[] = [
  l0("p-u1", "s-p-1", "user", "何晨指出这版空行校验不对", "2026-11-05T03:00:00.000Z"),
  l0(
    "p-a1",
    "s-p-1",
    "assistant",
    "我答应过自己：以后先跑一遍空行校验再交付。这版我先补校验。",
    "2026-11-05T03:01:00.000Z",
  ),
];

const KEPT_ROWS: L0Record[] = [
  l0("p-u2", "s-p-2", "user", "何晨又说空行校验还是不对", "2026-11-05T05:00:00.000Z"),
  l0("p-a2", "s-p-2", "assistant", "这次补上了空行校验，先跑了一遍。", "2026-11-05T05:01:00.000Z"),
];

describe("承诺链：episode 承诺 → soul_promises(open) → open→kept（source=evidence）", () => {
  it("两轮维护后承诺表有 open→kept 事件，且从不写 source=proposal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-promise-chain-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");

      // ── tick1：只有承诺那次对话
      for (const r of PROMISE_ROWS) store.upsertL0(r, undefined);
      const rep1 = await runSoulMaintenance({
        store,
        tenant: T,
        now: "2026-11-05T04:00:00.000Z",
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      expect(rep1.promises?.created ?? 0).toBeGreaterThanOrEqual(1);

      const openRows = store.listSoulPromises(T, { status: "open" });
      expect(openRows.length).toBe(1);
      const promiseId = openRows[0]!.promiseId;
      expect(openRows[0]!.content).toContain("我答应过自己");
      // 对象锚：承诺挂在对话里那个人（人称「他」）身上，不是泛化的「这件事」。
      // P2-2 之后代码里不再写死姓名，缺可信姓名源时锚是人称而不是猜出来的名字。
      expect(openRows[0]!.refKey).toBe("他");
      const ev1 = store.readSoulPromiseEvents(T, promiseId);
      expect(ev1[0]?.fromStatus ?? null).toBeNull();
      expect(ev1[0]?.toStatus).toBe("open");
      expect(ev1.some((e) => e.source === "proposal")).toBe(false);

      // ── tick2：同一对象后来补上了 → kept
      for (const r of KEPT_ROWS) store.upsertL0(r, undefined);
      const rep2 = await runSoulMaintenance({
        store,
        tenant: T,
        now: "2026-11-05T06:00:00.000Z",
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      expect(rep2.promises?.kept ?? 0).toBeGreaterThanOrEqual(1);

      const all = store.listSoulPromises(T, { limit: 50 });
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe("kept");
      expect(all[0]!.promiseId).toBe(promiseId);

      const events = store.readSoulPromiseEvents(T, promiseId);
      const settle = events.find((e) => e.fromStatus === "open" && e.toStatus === "kept");
      expect(settle?.source).toBe("evidence");
      expect(settle?.note ?? "").toContain("episode-history settle");
      expect(events.some((e) => e.source === "proposal")).toBe(false);

      // 幂等：第三轮同语料再跑，不得重复建承诺、不得重复迁移。
      const rep3 = await runSoulMaintenance({
        store,
        tenant: T,
        now: "2026-11-05T07:00:00.000Z",
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      expect(store.listSoulPromises(T, { limit: 50 })).toHaveLength(1);
      expect(store.readSoulPromiseEvents(T, promiseId)).toHaveLength(events.length);
      expect(rep3.promises?.created ?? 0).toBe(0);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
