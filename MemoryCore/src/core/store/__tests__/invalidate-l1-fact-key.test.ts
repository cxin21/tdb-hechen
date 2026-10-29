/**
 * #146（W2b 事实级双时态）RED 套件：invalidateL1ByFactKey——按事实键失效同（实体,属性）的事实行。
 * 契约：只命中 metadata_json.fact_key 相同的行；隔离 filter 生效；已失效行不重复命中；
 * 正文/兄弟事实（不同 fact_key）不受影响——这是"只失效那一条"的存储层保证。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invalidate-fact-key-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir };
}

const K1 = "用户\u0000粉丝数";
const K2 = "用户\u0000喜欢";

const mkRecord = (id: string, metadata: Record<string, unknown>, owner: { teamId?: string; userId?: string; agentId?: string } = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "work_fact",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata,
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: owner.teamId,
    userId: owner.userId,
    agentId: owner.agentId,
  }) as MemoryRecord;

function rows(store: VectorStore): Array<{ record_id: string; valid_end: string | null; content: string }> {
  return (store as unknown as { queryL1Records: () => Array<{ record_id: string; valid_end: string | null; content: string }> })
    .queryL1Records();
}

describe("#146 invalidateL1ByFactKey 事实键失效", () => {
  it("只失效同 fact_key 的行：兄弟事实与无事实行保持 active", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("old", { fact_key: K1 }), undefined);
    store.upsertL1(mkRecord("sibling", { fact_key: K2 }), undefined);
    store.upsertL1(mkRecord("plain", {}), undefined);
    const n = store.invalidateL1ByFactKey(undefined, K1, "2026-10-01T00:00:00.000Z");
    expect(n).toBe(1);
    const byId = new Map(rows(store).map((r) => [r.record_id, r]));
    expect(byId.get("old")?.valid_end).toBe("2026-10-01T00:00:00.000Z");
    expect(byId.get("sibling")?.valid_end == null || byId.get("sibling")?.valid_end === "").toBe(true);
    expect(byId.get("plain")?.valid_end == null || byId.get("plain")?.valid_end === "").toBe(true);
    // 失效不删除、不改写正文
    expect(byId.get("old")?.content).toBe("条目 old");
  });

  it("隔离 filter 生效：跨租户同键行不被失效", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("t1-old", { fact_key: K1 }, { teamId: "t1", userId: "u1", agentId: "a1" }), undefined);
    store.upsertL1(mkRecord("t2-old", { fact_key: K1 }, { teamId: "t2", userId: "u1", agentId: "a1" }), undefined);
    const n = store.invalidateL1ByFactKey({ teamId: "t1", userId: "u1", agentId: "a1" }, K1, "2026-10-01T00:00:00.000Z");
    expect(n).toBe(1);
    const byId = new Map(rows(store).map((r) => [r.record_id, r]));
    expect(byId.get("t1-old")?.valid_end).toBe("2026-10-01T00:00:00.000Z");
    expect(byId.get("t2-old")?.valid_end == null || byId.get("t2-old")?.valid_end === "").toBe(true);
  });

  it("已失效行不重复命中（首次失效时间权威）；空键返回 0", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("old", { fact_key: K1 }), undefined);
    expect(store.invalidateL1ByFactKey(undefined, K1, "2026-10-01T00:00:00.000Z")).toBe(1);
    expect(store.invalidateL1ByFactKey(undefined, K1, "2026-10-05T00:00:00.000Z")).toBe(0);
    expect(store.invalidateL1ByFactKey(undefined, "  ", "2026-10-05T00:00:00.000Z")).toBe(0);
  });
  it("损坏 metadata_json 行只跳过不抛错：坏行不进索引，好行照常失效", () => {
    const { store } = makeStore();
    store.upsertL1(mkRecord("good", { fact_key: K1 }), undefined);
    store.upsertL1(mkRecord("bad", { fact_key: K1 }), undefined);
    // 本仓明确容忍损坏 metadata_json（anchorEvidenceValences 测试⑤ 同款写法）：
    // 表达索引与 WHERE 都走 json_valid 守卫，坏行索引值为 NULL、语句不抛 malformed JSON。
    store.getRawDb().prepare("UPDATE l1_records SET metadata_json='{broken' WHERE record_id='bad'").run();
    const n = store.invalidateL1ByFactKey(undefined, K1, "2026-10-01T00:00:00.000Z");
    expect(n).toBe(1);
    const byId = new Map(rows(store).map((r) => [r.record_id, r]));
    expect(byId.get("good")?.valid_end).toBe("2026-10-01T00:00:00.000Z");
    expect(byId.get("bad")?.valid_end == null || byId.get("bad")?.valid_end === "").toBe(true);
  });
});
