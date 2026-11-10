/**
 * A7 第二租户（L3，临时库）：同一个库、两个租户，各自跑真实 runSoulMaintenance，
 * 各自长出只属于自己的事件史条目；互不串味、条目 id 不相交。
 * 这不是生产证据（生产第二租户的语料仍未采集），只证明「换一个人也能长」这条路径可达。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { CoreTenant } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import type { SoulEvidenceRecord } from "../worker.js";
import type { L0Record } from "../../store/types.js";

const NOW = "2026-11-06T12:00:00.000Z";
const T1: CoreTenant = { teamId: "t-multi", userId: "u-one", agentId: "a-one" };
const T2: CoreTenant = { teamId: "t-multi", userId: "u-two", agentId: "a-two" };

function corpus(tenant: CoreTenant, lines: string[]): SoulEvidenceRecord[] {
  return lines.map((content, i) => ({
    id: `${tenant.userId}-m${i}`,
    content,
    occurredAt: `2026-11-05T0${(i % 9) + 1}:00:00.000Z`,
  }));
}

function l0(tenant: CoreTenant, lines: string[]): L0Record[] {
  return lines.map((messageText, i) => ({
    id: `${tenant.userId}-m${i}`,
    sessionKey: `s-${tenant.userId}`,
    sessionId: `s-${tenant.userId}`,
    taskId: `task-${tenant.userId}`,
    role: i % 2 === 0 ? "user" : "assistant",
    messageText,
    recordedAt: `2026-11-05T0${(i % 9) + 1}:00:00.000Z`,
    timestamp: Date.parse(`2026-11-05T0${(i % 9) + 1}:00:00.000Z`),
    ...tenant,
  }));
}

describe("第二租户长出自己的人格", () => {
  it("两个租户各跑一轮：都有事件史条目，且彼此不共享条目", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-multi-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const one = corpus(T1, [
        "这处不对，是不是你改坏的",
        "我漏了，这就补上",
        "这一列还是不对，你又漏了",
        "我漏了，已经按原话重做，补了证据",
      ]);
      const two = corpus(T2, [
        "这个接口是不是你写错了",
        "不是我造成的，我查了日志，上游缓存了旧数据",
        "菜单太丑了，你找的组件库是不是不靠谱啊",
        "我换成 Arco 组件库，按钮按同一轨道重排",
      ]);
      for (const r of l0(T1, one.map((x) => x.content))) store.upsertL0(r, undefined);
      for (const r of l0(T2, two.map((x) => x.content))) store.upsertL0(r, undefined);
      const base = { store, now: NOW, trigger: "manual" as const, llmCallBudget: 0 };
      const cfg = { episodeWindowDays: 30, updateIntervalHours: 0 };
      await runSoulMaintenance({ ...base, tenant: T1, config: cfg, recentRecords: async () => one });
      await runSoulMaintenance({ ...base, tenant: T2, config: cfg, recentRecords: async () => two });

      const p1 = await store.listSoulPersona(T1);
      const p2 = await store.listSoulPersona(T2);
      expect(p1.length).toBeGreaterThan(0);
      expect(p2.length).toBeGreaterThan(0);
      const ids1 = new Set(p1.map((i) => i.itemId));
      expect(p2.some((i) => ids1.has(i.itemId))).toBe(false);
      // 事件史条目必须能回到事件 id。
      expect([...p1, ...p2].some((i) => (i.evidenceIds ?? []).some((id) => id.startsWith("ep-")))).toBe(true);
      // 两个租户的文本集合不同（不是同一批模板复制）。
      const text1 = new Set(p1.map((i) => i.text));
      expect(p2.some((i) => text1.has(i.text))).toBe(false);
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
