/**
 * T6 确定性：同一份 L0 语料、同一时钟，两个独立临时库跑维护，
 * soul_episodes / soul_emotions / soul_persona / soul_state / soul_ledger 行级哈希必须全等。
 *
 * 这不是「生产双库」——生产只有一个库；它证明的是同一输入不会因 Map 顺序、
 * 时间戳或随机 id 漂移，为后续灰度双跑/回滚演练提供可复现基线。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";

const T = { teamId: "t-det", userId: "u-det", agentId: "a-det" };
const NOW = "2026-11-06T12:00:00.000Z";

function l0(id: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: "s-det-1",
    sessionId: "s-det-1",
    taskId: "task-det",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

const ROWS: L0Record[] = [
  l0("u1", "user", "这处不对，是不是你改坏的", "2026-11-05T03:00:00.000Z"),
  l0("a1", "assistant", "不是我造成的：这行代码我这一轮没动过，是上游接口返回了旧数据", "2026-11-05T03:01:00.000Z"),
  l0("u2", "user", "菜单太丑了太丑了，你找的组件库是不是不靠谱啊", "2026-11-05T03:10:00.000Z"),
  l0("a2", "assistant", "我换成 Arco 组件库，按钮按同一轨道重排", "2026-11-05T03:11:00.000Z"),
  l0("u3", "user", "这一列还是不对，你又漏了", "2026-11-05T03:20:00.000Z"),
  l0("a3", "assistant", "我漏了，这就补上", "2026-11-05T03:21:00.000Z"),
  l0("u4", "user", "这次改得好，数对上了，就这么办", "2026-11-05T03:30:00.000Z"),
  l0("a4", "assistant", "好，我按这个收口", "2026-11-05T03:31:00.000Z"),
];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, stable(obj[k])]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

async function runOnce(): Promise<{ hash: string; counts: Record<string, number> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-det-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  try {
    store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级");
    for (const row of ROWS) store.upsertL0(row, undefined);
    await runSoulMaintenance({
      store,
      tenant: T,
      now: NOW,
      config: { enabled: true, episodeWindowDays: 30, updateIntervalHours: 0, minEvidence: 2 },
      trigger: "manual",
      llmCallBudget: 0,
    });
    const episodes = await store.listSoulEpisodes(T, { limit: 500 });
    const emotions = store.listSoulEmotions ? await store.listSoulEmotions(T, { limit: 500 }) : [];
    const persona = await store.listSoulPersona?.(T);
    const state = await store.readSoulState?.(T);
    const ledger = store.listSoulLedger ? await store.listSoulLedger(T, 1000) : [];
    return {
      hash: digest({ episodes, emotions, persona, state, ledger }),
      counts: {
        episodes: episodes.length,
        emotions: emotions.length,
        persona: (persona ?? []).length,
        ledger: ledger.length,
        state: state ? 1 : 0,
      },
    };
  } finally {
    try { store.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("T6 同语料双临时库：soul 行级哈希全等", () => {
  it("同一时钟、同一 L0，两次独立维护的五张表哈希完全一致", async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(a.counts).toEqual(b.counts);
    expect(a.counts.episodes).toBeGreaterThan(0);
    expect(a.counts.emotions).toBeGreaterThan(0);
    expect(a.counts.ledger).toBeGreaterThan(0);
    expect(a.hash).toBe(b.hash);
  }, 30000);
});
