/**
 * P2-E 存储面：`soul_episodes.persons_json` 的建表列 + 幂等 ALTER + 读写 roundtrip。
 *
 * 为什么要单测旧库迁移：生产库是先有 `soul_episodes`（56 行）后有这一列的。
 * 只测「新库建表带列」会漏掉「老库打开时必须把列补上」，而补列失败要到第一次
 * 写事件时才暴露。这里把列 DROP 掉再 init，模拟改前 schema。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { SoulEpisode } from "../../soul/types.js";
import type { CoreTenant } from "../types.js";

const TENANT: CoreTenant = { teamId: "t1", userId: "u1", agentId: "a1" };

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-episode-persons-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return store;
}

const raw = (store: VectorStore) =>
  (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } } }).db;

function episode(id: string, persons?: string[]): SoulEpisode {
  return {
    episodeId: id,
    at: "2026-11-08T02:00:00.000Z",
    day: "2026-11-08",
    kind: "correction",
    title: "纠正：门禁",
    object: "门禁",
    participants: ["何晨", "assistant"],
    userStance: "先取证再回话",
    agentStance: "好",
    cost: "",
    outcome: "",
    valence: -0.4,
    arousal: 0.5,
    intensity: 0.4,
    evidenceIds: ["l0-1"],
    sessionId: "s1",
    quote: null,
    affectSource: "none",
    ...(persons === undefined ? {} : { persons }),
  };
}

function columns(store: VectorStore): string[] {
  return (raw(store).prepare("PRAGMA table_info(soul_episodes)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("P2-E soul_episodes.persons_json 存储面", () => {
  it("旧库（无该列）再次 init 会幂等补列，且补列后能读写", async () => {
    const dbPath = tmpDb();
    const first = makeStore(dbPath);
    expect(columns(first)).toContain("persons_json");
    // 模拟 P2-E 之前的库结构。
    raw(first).prepare("ALTER TABLE soul_episodes DROP COLUMN persons_json").run();
    expect(columns(first)).not.toContain("persons_json");
    first.close();

    const second = makeStore(dbPath);
    try {
      expect(columns(second)).toContain("persons_json");
      expect(second.commitSoulEpisodes(TENANT, [episode("ep-1", ["p_name_he"])]).inserted).toBe(1);
      const rows = await second.listSoulEpisodes(TENANT, { limit: 10 });
      expect(rows.find((r) => r.episodeId === "ep-1")?.persons).toEqual(["p_name_he"]);
    } finally {
      second.close();
    }
  });

  it("空名单写 NULL（读回 undefined），重挖时能清掉旧名单", async () => {
    const store = makeStore(tmpDb());
    try {
      store.commitSoulEpisodes(TENANT, [episode("ep-1", ["p_name_he"])]);
      store.commitSoulEpisodes(TENANT, [episode("ep-2")]);
      const rows = await store.listSoulEpisodes(TENANT, { limit: 10 });
      expect(rows.find((r) => r.episodeId === "ep-2")?.persons).toBeUndefined();

      // 同 episodeId 重挖（refresh 路径）：旧名单必须被清空，不能留着当「仍然挂这个人」。
      store.commitSoulEpisodes(TENANT, [episode("ep-1", [])]);
      const again = await store.listSoulEpisodes(TENANT, { limit: 10 });
      expect(again.find((r) => r.episodeId === "ep-1")?.persons).toBeUndefined();
    } finally {
      store.close();
    }
  });
});