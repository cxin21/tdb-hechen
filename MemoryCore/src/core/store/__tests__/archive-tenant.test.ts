/**
 * SEC-1（安全级）：l1_archive 租户化 —— 补 T12 漏网。
 *
 * 根因：l1_archive 只有 record_id/data/archived_at/reason 四列，无租户列；
 * archive/list 实例级全量出、restore 无属主校验 —— 任何 agent 可见/恢复他人归档。
 *
 * 修法（brief 六步，T12/T14 模式照抄）：
 *   1) DDL 幂等迁移：三列 ALTER + 存量行 data JSON 回填（损坏行 → default + loud 打印）
 *   2) archiveL1 INSERT 带三列（从 l1_records 行取）
 *   3) listArchived 消费 IsolationFilter（SQL 列过滤，T14 同形——filter 缺省=旧行为）+ 出参带三列
 *   4) restoreL1 属主校验（filter 传入时不匹配 → false，宁严勿松）
 *   5) 路由/面板消费见 v2-router / BlockDetail（本文件锁 store 层契约）
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const TENANT_A = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B = { teamId: "teamB", userId: "userB", agentId: "agentB" };

function makeStore(name: string, logger?: ConstructorParameters<typeof VectorStore>[2]): { store: VectorStore; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sec1-${name}-`));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0, logger);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${JSON.stringify(initRes)}`);
  return { store, dir, dbPath };
}

const mkRecord = (id: string, tenant: Partial<{ teamId: string; userId: string; agentId: string }>): MemoryRecord =>
  ({
    id,
    content: `归档样本 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    ...tenant,
  }) as MemoryRecord;

function archiveTenantRows(raw: DatabaseSync): Array<{ record_id: string; team_id: string; user_id: string; agent_id: string }> {
  return raw.prepare("SELECT record_id, team_id, user_id, agent_id FROM l1_archive ORDER BY record_id").all() as Array<{
    record_id: string;
    team_id: string;
    user_id: string;
    agent_id: string;
  }>;
}

describe("SEC-1 archiveL1 写入侧：INSERT 带租户三列（从 l1_records 行取）", () => {
  it("归档后 l1_archive 行的 team_id/user_id/agent_id 与被归档记忆一致", () => {
    const { store, dir } = makeStore("write");
    try {
      store.upsertL1(mkRecord("ra1", TENANT_A), undefined);
      store.upsertL1(mkRecord("rb1", TENANT_B), undefined);
      expect(store.archiveL1("ra1", "forgetting")).toBe(true);
      expect(store.archiveL1("rb1", "forgetting")).toBe(true);
      const rows = archiveTenantRows(store.getRawDb());
      const a = rows.find((r) => r.record_id === "ra1");
      const b = rows.find((r) => r.record_id === "rb1");
      expect(a).toMatchObject({ team_id: "teamA", user_id: "userA", agent_id: "agentA" });
      expect(b).toMatchObject({ team_id: "teamB", user_id: "userB", agent_id: "agentB" });
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("SEC-1 listArchived 租户过滤（T14 同形：filter 缺省=旧行为）", () => {
  it("A 归档两条 → A filter 可见 2 条；B filter 看不到；出参带三列归属", () => {
    const { store, dir } = makeStore("list");
    try {
      store.upsertL1(mkRecord("ra1", TENANT_A), undefined);
      store.upsertL1(mkRecord("ra2", TENANT_A), undefined);
      store.upsertL1(mkRecord("rb1", TENANT_B), undefined);
      store.archiveL1("ra1", "forgetting");
      store.archiveL1("ra2", "forgetting");
      store.archiveL1("rb1", "forgetting");

      const aItems = store.listArchived(100, 0, TENANT_A);
      const bItems = store.listArchived(100, 0, TENANT_B);
      expect(aItems.map((i) => i.record_id).sort()).toEqual(["ra1", "ra2"]);
      // B 只见自己的 rb1，看不到 A 的两条（SEC-1 核心断言）
      expect(bItems.map((i) => i.record_id)).toEqual(["rb1"]);
      // 出参带归属（面板徽标消费）
      expect(aItems[0]).toMatchObject({ team_id: "teamA", user_id: "userA", agent_id: "agentA" });
      // filter 缺省 = 旧行为（实例级全量，单机/verify 调用方兼容）
      expect(store.listArchived(100, 0).length).toBe(3);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("SEC-1 restoreL1 属主校验（宁严勿松）", () => {
  it("B 恢复 A 的归档 → 拒绝（行不动）；A 自己恢复 → 成功且租户随 JSON 还原", () => {
    const { store, dir } = makeStore("restore");
    try {
      store.upsertL1(mkRecord("ra1", TENANT_A), undefined);
      store.archiveL1("ra1", "forgetting");

      // 跨租户恢复：拒绝（false），归档行原封不动
      expect(store.restoreL1("ra1", TENANT_B)).toBe(false);
      const still = store.getRawDb().prepare("SELECT COUNT(*) AS n FROM l1_archive WHERE record_id = 'ra1'").get() as { n: number };
      expect(still.n).toBe(1);

      // 属主恢复：成功，恢复进 l1_records 且租户字段不丢
      expect(store.restoreL1("ra1", TENANT_A)).toBe(true);
      const back = store.getRawDb().prepare("SELECT team_id, user_id, agent_id FROM l1_records WHERE record_id = 'ra1'").get() as { team_id: string; user_id: string; agent_id: string };
      expect(back).toMatchObject({ team_id: "teamA", user_id: "userA", agent_id: "agentA" });
      // filter 缺省 = 旧行为（内部补偿/verify 调用方）
      store.upsertL1(mkRecord("rb2", TENANT_B), undefined);
      store.archiveL1("rb2", "forgetting");
      expect(store.restoreL1("rb2")).toBe(true);
    } finally {
      try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

describe("SEC-1 存量回填（幂等迁移，T12 模式）", () => {
  function makeLegacyDb(dbPath: string): DatabaseSync {
    const raw = new DatabaseSync(dbPath);
    // T12 漏网形态：只有四列，无租户列
    raw.exec(`
      CREATE TABLE l1_archive (
        record_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT ''
      )
    `);
    const rowWithTenant = JSON.stringify({
      record_id: "leg1", content: "带租户快照", team_id: "teamA", user_id: "userA", agent_id: "agentA",
    });
    const rowNoTenant = JSON.stringify({ record_id: "leg2", content: "无租户快照" });
    raw.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason) VALUES (?, ?, ?, ?)")
      .run("leg1", rowWithTenant, "2026-09-01T00:00:00Z", "forgetting");
    raw.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason) VALUES (?, ?, ?, ?)")
      .run("leg2", rowNoTenant, "2026-09-02T00:00:00Z", "forgetting");
    // 损坏 JSON：回填 default + loud 打印，不炸 init
    raw.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason) VALUES (?, ?, ?, ?)")
      .run("leg3", "{not-json", "2026-09-03T00:00:00Z", "forgetting");
    return raw;
  }

  it("legacy 库 init 后：JSON 三字段回填列、缺省/损坏行回 default、二次 init 幂等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec1-legacy-"));
    const dbPath = path.join(dir, "legacy.db");
    const warns: string[] = [];
    try {
      makeLegacyDb(dbPath);
      const store = new VectorStore(dbPath, 0, {
        warn: (m: string) => warns.push(String(m)),
        info: () => {}, debug: () => {}, error: () => {},
      } as never);
      store.init();
      const rows = archiveTenantRows(store.getRawDb());
      expect(rows.find((r) => r.record_id === "leg1")).toMatchObject({ team_id: "teamA", user_id: "userA", agent_id: "agentA" });
      expect(rows.find((r) => r.record_id === "leg2")).toMatchObject({ team_id: "default", user_id: "default", agent_id: "default" });
      expect(rows.find((r) => r.record_id === "leg3")).toMatchObject({ team_id: "default", user_id: "default", agent_id: "default" });
      // 损坏行 loud 打印，不静默
      expect(warns.some((m) => m.includes("leg3"))).toBe(true);

      // 二次 init 幂等：列不炸、回填值不漂移
      store.close();
      const store2 = new VectorStore(dbPath, 0);
      store2.init();
      const rows2 = archiveTenantRows(store2.getRawDb());
      expect(rows2).toEqual(rows);
      store2.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("回填后 A filter 能读到存量归档行、B 读不到（存量数据不再实例级裸奔）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec1-legacy2-"));
    const dbPath = path.join(dir, "legacy.db");
    try {
      makeLegacyDb2(dbPath);
      const store = new VectorStore(dbPath, 0);
      store.init();
      const aItems = store.listArchived(100, 0, TENANT_A);
      const bItems = store.listArchived(100, 0, TENANT_B);
      expect(aItems.map((i) => i.record_id)).toEqual(["leg1"]);
      expect(bItems).toEqual([]);
      store.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});

function makeLegacyDb2(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE l1_archive (
      record_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
  raw.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason) VALUES (?, ?, ?, ?)")
    .run("leg1", JSON.stringify({ record_id: "leg1", content: "A 的存量归档", team_id: "teamA", user_id: "userA", agent_id: "agentA" }), "2026-09-01T00:00:00Z", "forgetting");
  raw.close();
}
