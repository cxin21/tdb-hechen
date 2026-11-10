/**
 * 端到端（临时库）：hechen 形状的 L0 → runSoulMaintenance → 事件/自我史/关系史/心境，
 * 证明「委屈」这类情绪不是只能靠单测喂假对象，而是从真实对话挖掘、经维护轮次确定性产出。
 * 只用临时 sqlite 文件，不碰生产库；不联网、不调 LLM（llmCallBudget=0）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import { emotionEventFromEpisode } from "../episode.js";
import { resolveSoulConfig } from "../types.js";

const T = { teamId: "t-e2e", userId: "u-e2e", agentId: "a-e2e" };
const NOW = "2026-11-05T12:00:00.000Z";

function l0(id: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: "s-e2e-1",
    sessionId: "s-e2e-1",
    taskId: "task-e2e",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

describe("S10：重生后租户枚举以对话为准", () => {
  it("core_memory / soul_persona 都空时，只有 L0 的租户仍会被枚举", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-tenant-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      expect(store.listCoreTenants()).toEqual([]);
      store.upsertL0(l0("u1", "user", "清库之后的第一句话", "2026-11-07T06:10:00.000Z"), undefined);
      expect(store.listCoreTenants()).toEqual([T]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("端到端：临时库跑一轮维护，长出被错怪的委屈与关系史", () => {
  it("同一轮里：挖掘事件 → 委屈（不是我造成）→ 信任下降 → 修复/冲突落人格", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-e2e-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const rows: L0Record[] = [
        l0("u1", "user", "这处不对，是不是你改坏的", "2026-11-05T03:00:00.000Z"),
        l0("a1", "assistant", "不是我造成的：这行代码我这一轮没动过，是上游接口返回了旧数据", "2026-11-05T03:01:00.000Z"),
        l0("u2", "user", "菜单太丑了太丑了，你找的组件库是不是不靠谱啊", "2026-11-05T03:10:00.000Z"),
        l0("a2", "assistant", "我换成 Arco 组件库，按钮按同一轨道重排", "2026-11-05T03:11:00.000Z"),
        l0("u3", "user", "这一列还是不对，你又漏了", "2026-11-05T03:20:00.000Z"),
        l0("a3", "assistant", "我漏了，这就补上", "2026-11-05T03:21:00.000Z"),
      ];
      for (const r of rows) store.upsertL0(r, undefined);

      const report = await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      expect(report.episodes?.mined ?? 0).toBeGreaterThanOrEqual(2);

      const cfg = resolveSoulConfig({});
      const eps = await store.listSoulEpisodes(T, { since: "2026-10-01T00:00:00.000Z", limit: 50 });
      const labels = eps.map((e) => emotionEventFromEpisode(e, cfg).label);
      expect(labels).toContain("委屈");
      const wronged = eps.find((e) => emotionEventFromEpisode(e, cfg).label === "委屈");
      // 洗清发生在「我对这条追责的回复」上（outcome），不是上一轮那句；上一轮的表态不能拿来
      // 判定这一轮是不是被错怪（2026-11-06 修：此前 u2 因 a1 的举证被误判成委屈）。
      expect(wronged?.outcome ?? "").toContain("不是我造成的");

      const items = await store.listSoulPersona(T);
      const rel = items.filter((i) => i.layer === "relationship").map((i) => i.text);
      expect(rel.some((t) => t.includes("不太放心"))).toBe(true);
      expect(rel.some((t) => t.includes("补上了") || t.includes("只回了"))).toBe(true);
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("端到端：LLM 候选走真实事件准入，情绪欠账把 identity 挡下", () => {
  const rows = (reply: string): L0Record[] => [
    l0("u1", "user", "这处不对，是不是你改坏的", "2026-11-05T03:00:00.000Z"),
    l0("a1", "assistant", reply, "2026-11-05T03:01:00.000Z"),
    l0("u2", "user", "这里还是不对，你又搞错了", "2026-11-05T03:10:00.000Z"),
    l0("a2", "assistant", reply, "2026-11-05T03:11:00.000Z"),
  ];
  const CANDIDATE = {
    layer: "identity" as const,
    text: "我宁可慢一点把账算清，也不拿漂亮的假绿过关。",
  };

  // 两轮：第一轮把事件与心境落库（此时没有 state，情绪判断按旧语料算不出来）；
  // 第二轮才是真实生产形状——库里已有情绪对象与事件史，候选必须过它。
  async function run(reply: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-e2e-gate-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      for (const r of rows(reply)) store.upsertL0(r, undefined);
      const base = {
        store,
        tenant: T,
        config: { episodeWindowDays: 30, updateIntervalHours: 0, minEvidence: 2 },
        trigger: "manual" as const,
        llmCallBudget: 1,
        recentRecords: async () =>
          rows(reply).map((r) => ({ id: r.id, content: r.messageText, occurredAt: r.recordedAt })),
      };
      await runSoulMaintenance({
        ...base,
        now: "2026-11-05T12:00:00.000Z",
        rewriter: async () => [],
      });
      let epIds: string[] = [];
      const report = await runSoulMaintenance({
        ...base,
        now: "2026-11-05T12:30:00.000Z",
        rewriter: async (input) => {
          epIds = (input.episodes ?? [])
            .map((line) => /^(ep-[A-Za-z0-9_-]+)/u.exec(line)?.[1])
            .filter((x): x is string => Boolean(x));
          return [{ ...CANDIDATE, evidenceIds: epIds }];
        },
      });
      const items = await store.listSoulPersona(T);
      return { report, items, epIds };
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("两次同一对象欠着修复 → 情绪门只观测，不再把 identity 候选挡在门外（S5）", async () => {
    const out = await run("我重做了这块，下一轮再跑");
    expect(out.epIds.length).toBeGreaterThanOrEqual(2);
    expect(out.report.rejections.some((r) => r.codes.includes("mood_defer_self"))).toBe(false);
    expect(out.report.mood?.gate?.opened).toBe(true);
    expect(out.report.mood?.gate?.focus).toBe("self");
  });

  it("同一条候选、同一批事件，修复已写进回复 → 仍正常准入（与上一例同一路径）", async () => {
    const out = await run("已按原话重做，补上了");
    expect(out.report.rejections.some((r) => r.codes.includes("mood_defer_self"))).toBe(false);
    expect(out.items.some((i) => i.layer === "identity" && i.text.includes("假绿"))).toBe(true);
  });
});

