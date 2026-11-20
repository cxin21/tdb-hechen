/**
 * 标签退役的条件写（Round18）：soul_trait_label 按 (tenant_id, label) 存、同队多 agent 共享。
 * 退役只该改「仍然 admitted 且 last_seen 很旧」的行；整行 upsert 会把别的 agent 刚复活的行
 * 改回 dormant 并倒退 last_seen——这里把那条跨 writer 的保证钉在存储层。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../sqlite.js";

const TEAM = "team-label";
const TENANT = { teamId: TEAM, userId: "u1", agentId: "a1" };
const NOW = "2026-11-19T00:00:00.000Z";

function makeStore(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-label-dormant-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(res)}`);
  return store;
}

function seed(store: VectorStore): void {
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
  const stmt = db.prepare(
    "INSERT INTO soul_trait_label (tenant_id, label, status, first_seen, last_seen) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)",
  );
  stmt.run(TEAM, "旧标签", "admitted", "2026-08-01T00:00:00.000Z");
  stmt.run(TEAM, "新标签", "admitted", "2026-11-18T00:00:00.000Z");
  stmt.run(TEAM, "种子", "seed", "2020-01-01T00:00:00.000Z");
  stmt.run(TEAM, "已退役", "dormant", "2020-01-01T00:00:00.000Z");
}

function statuses(store: VectorStore): Record<string, string> {
  const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>> } } }).db;
  const rows = db.prepare("SELECT label, status FROM soul_trait_label WHERE tenant_id = ? ORDER BY label").all(TEAM);
  return Object.fromEntries(rows.map((r) => [String(r.label), String(r.status)]));
}

describe("dormantSoulTraitLabels：条件写", () => {
  it("只退 admitted 且过期的行；幂等；种子与已 dormant 不动", () => {
    const store = makeStore();
    seed(store);
    const first = store.dormantSoulTraitLabels(TENANT as never, ["旧标签", "新标签", "种子", "已退役"], { now: NOW, idleDays: 60 });
    expect(first.retired).toBe(1);
    expect(statuses(store)).toEqual({ 旧标签: "dormant", 新标签: "admitted", 种子: "seed", 已退役: "dormant" });
    const second = store.dormantSoulTraitLabels(TENANT as never, ["旧标签"], { now: NOW, idleDays: 60 });
    expect(second.retired).toBe(0);
  });

  it("别的 agent 刚复活的行不会被这次退役整行覆盖（跨 writer 保证）", () => {
    const store = makeStore();
    seed(store);
    store.dormantSoulTraitLabels(TENANT as never, ["旧标签"], { now: NOW, idleDays: 60 });
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    // 模拟同队另一个 agent 用新证据复活了同一行（lastSeen 刚写）
    db.prepare("UPDATE soul_trait_label SET status = 'admitted', last_seen = ? WHERE tenant_id = ? AND label = '旧标签'").run("2026-11-18T23:00:00.000Z", TEAM);
    const res = store.dormantSoulTraitLabels(TENANT as never, ["旧标签"], { now: NOW, idleDays: 60 });
    expect(res.retired).toBe(0);
    expect(statuses(store)["旧标签"]).toBe("admitted");
  });

  it("时间不可解析 / 空列表 → 不动", () => {
    const store = makeStore();
    seed(store);
    expect(store.dormantSoulTraitLabels(TENANT as never, ["旧标签"], { now: "not-a-date" }).retired).toBe(0);
    expect(store.dormantSoulTraitLabels(TENANT as never, [], { now: NOW }).retired).toBe(0);
    expect(statuses(store)["旧标签"]).toBe("admitted");
  });
});
