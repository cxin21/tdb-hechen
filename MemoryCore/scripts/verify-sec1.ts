/**
 * SEC-1 同形验证：l1_archive 租户化（补 T12 漏网）。
 *
 * 背景（brief task-sec1-brief）：
 *   l1_archive 只有 record_id/data/archived_at/reason 四列，无租户列——任何 agent
 *   可 archive/list 看到实例级全部归档、restore 无属主校验。修复六步：
 *     1) DDL 幂等迁移（三列 ALTER + data JSON 回填，损坏行 default + loud 打印）
 *     2) archiveL1 INSERT 带三列（从 l1_records 行取）
 *     3) listArchived 消费 isolation（SQL 列过滤；filter 缺省=旧行为）+ 出参带三列
 *     4) restoreL1 属主校验（不匹配 → false，路由 404 宁严勿滥）
 *     5) Panel：BFF 透传 additive 零改 + BlockDetail 归属徽标
 *     6) 本脚本断言 + 回归 verify-p1-t7 / verify-p2-t12 / verify-p2-t14 / verify-t2
 *
 * 断言组（验收契约）：
 *   1. 全新库：建表含租户三列（PRAGMA）；A 归档两条 → B list 看不到、A 自己可见；
 *      B restore A 的归档 → 拒绝；A restore → 成功且租户随 JSON 还原。
 *   2. 存量迁移：legacy 四列库 → init → JSON 三字段回填列；缺字段/损坏行 → default
 *      （loud 打印不静默）；二次 init 幂等不漂移。
 *   3. handler 链路：handleArchiveList 按 deps.requestIsolation 过滤（A/B 互不可见；
 *      /v2 匿名 default 桶见 default 回填行）；handleArchiveRestore 跨租户 → 404。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-sec1.ts
 *
 * 只用自建临时库，不连任何线上资源、不碰生产数据目录；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleArchiveList, handleArchiveRestore } from "../src/gateway/v2-router.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32mOK\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const TENANT_A = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const DEFAULT_TENANT = { teamId: "default", userId: "default", agentId: "default" };

const mkRecord = (id: string, tenant: { teamId: string; userId: string; agentId: string }): MemoryRecord =>
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

function newStore(tmpDir: string, name: string, warns?: string[]): VectorStore {
  const logger = warns
    ? {
        info: () => {}, debug: () => {}, error: () => {},
        warn: (m: string) => warns.push(String(m)),
      }
    : undefined;
  const store = new VectorStore(path.join(tmpDir, `${name}.db`), 0, logger as never);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  return store;
}

function archiveColumns(raw: DatabaseSync): string[] {
  return (raw.prepare("PRAGMA table_info(l1_archive)").all() as Array<{ name: string }>).map((c) => c.name);
}

// ── 断言组 1：全新库 ──────────────────────────────────────────────

function testFreshDb(tmpDir: string): void {
  console.log("\n断言组 1 — 全新库：建表带租户列 + 双租户 list/restore 隔离");
  const store = newStore(tmpDir, "fresh");
  try {
    const cols = archiveColumns(store.getRawDb());
    check("1.1 l1_archive 建表含 team_id/user_id/agent_id",
      cols.includes("team_id") && cols.includes("user_id") && cols.includes("agent_id"), cols.join(","));

    store.upsertL1(mkRecord("ra1", TENANT_A), undefined);
    store.upsertL1(mkRecord("ra2", TENANT_A), undefined);
    store.upsertL1(mkRecord("rb1", TENANT_B), undefined);
    check("1.2 前置：三租户记忆就位并归档",
      store.archiveL1("ra1", "forgetting") && store.archiveL1("ra2", "forgetting") && store.archiveL1("rb1", "forgetting"));

    const aRows = store.getRawDb().prepare("SELECT team_id, user_id, agent_id FROM l1_archive WHERE record_id = 'ra1'").get() as Record<string, string>;
    check("1.3 archiveL1 写入租户三列（从 l1_records 行取）",
      aRows.team_id === "teamA" && aRows.user_id === "userA" && aRows.agent_id === "agentA", JSON.stringify(aRows));

    const aList = store.listArchived(100, 0, TENANT_A);
    const bList = store.listArchived(100, 0, TENANT_B);
    check("1.4 A list 可见自己两条", aList.length === 2 && aList.every((i) => i.team_id === "teamA"), JSON.stringify(aList));
    check("1.5 B list 看不到 A 的归档（只见自己的 rb1）", bList.length === 1 && bList[0].record_id === "rb1", JSON.stringify(bList));
    check("1.6 filter 缺省 = 旧行为（实例级全量，verify/单机兼容）", store.listArchived(100, 0).length === 3);

    check("1.7 B restore A 的归档 → 拒绝", store.restoreL1("ra1", TENANT_B) === false);
    const still = store.getRawDb().prepare("SELECT COUNT(*) AS n FROM l1_archive WHERE record_id = 'ra1'").get() as { n: number };
    check("1.8 拒绝后归档行原封不动", still.n === 1);
    check("1.9 A restore 自己的归档 → 成功", store.restoreL1("ra1", TENANT_A) === true);
    const back = store.getRawDb().prepare("SELECT team_id, user_id, agent_id FROM l1_records WHERE record_id = 'ra1'").get() as Record<string, string>;
    check("1.10 恢复后租户随 JSON 还原", back.team_id === "teamA" && back.user_id === "userA" && back.agent_id === "agentA", JSON.stringify(back));
  } finally {
    store.close();
  }
}

// ── 断言组 2：存量迁移 ────────────────────────────────────────────

function makeLegacyDb(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE l1_archive (
      record_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
  const ins = raw.prepare("INSERT INTO l1_archive (record_id, data, archived_at, reason) VALUES (?, ?, ?, ?)");
  ins.run("leg1", JSON.stringify({ record_id: "leg1", content: "带租户快照", team_id: "teamA", user_id: "userA", agent_id: "agentA" }), "2026-09-01T00:00:00Z", "forgetting");
  ins.run("leg2", JSON.stringify({ record_id: "leg2", content: "无租户快照" }), "2026-09-02T00:00:00Z", "forgetting");
  ins.run("leg3", "{not-json", "2026-09-03T00:00:00Z", "forgetting");
  raw.close();
}

function testLegacyMigration(tmpDir: string): void {
  console.log("\n断言组 2 — 存量迁移：legacy 四列库回填 + 损坏行 loud + 幂等");
  const dbPath = path.join(tmpDir, "legacy.db");
  makeLegacyDb(dbPath);
  const warns: string[] = [];
  const store = newStore(tmpDir, "legacy", warns);
  try {
    const row = (id: string) => store.getRawDb().prepare("SELECT team_id, user_id, agent_id FROM l1_archive WHERE record_id = ?").get(id) as Record<string, string>;
    check("2.1 leg1 按 JSON 三字段回填", JSON.stringify(row("leg1")) === JSON.stringify({ team_id: "teamA", user_id: "userA", agent_id: "agentA" }), JSON.stringify(row("leg1")));
    check("2.2 leg2 缺字段 → default 桶", JSON.stringify(row("leg2")) === JSON.stringify({ team_id: "default", user_id: "default", agent_id: "default" }), JSON.stringify(row("leg2")));
    check("2.3 leg3 损坏 JSON → default 桶", JSON.stringify(row("leg3")) === JSON.stringify({ team_id: "default", user_id: "default", agent_id: "default" }), JSON.stringify(row("leg3")));
    check("2.4 损坏行 loud 打印不静默", warns.some((m) => m.includes("leg3") && m.includes("archive-tenant-migrate")), warns.join(" | "));
    check("2.5 迁移 loud 汇总打印", warns.some((m) => m.includes("archive-tenant-migrate") && m.includes("已租户化")));

    const aList = store.listArchived(100, 0, TENANT_A);
    check("2.6 回填后 A filter 能读到存量归档（不再实例级裸奔）", aList.length === 1 && aList[0].record_id === "leg1", JSON.stringify(aList));
    check("2.7 B filter 读不到 A 的存量归档", store.listArchived(100, 0, TENANT_B).length === 0);

    const before = store.getRawDb().prepare("SELECT record_id, team_id, user_id, agent_id FROM l1_archive ORDER BY record_id").all();
    store.close();
    const store2 = newStore(tmpDir, "legacy");
    const after = store2.getRawDb().prepare("SELECT record_id, team_id, user_id, agent_id FROM l1_archive ORDER BY record_id").all();
    check("2.8 二次 init 幂等：回填值零漂移", JSON.stringify(before) === JSON.stringify(after));
    store2.close();
  } finally {
    try { store.close(); } catch { /* 幂等清理 */ }
  }
}

// ── 断言组 3：handler 链路 ────────────────────────────────────────

function depsFor(store: VectorStore, iso: { teamId?: string; userId: string; agentId: string } | undefined): never {
  return {
    getStore: () => store,
    requestIsolation: iso ? { ...iso, sessionId: "s1" } : undefined,
  } as never;
}

async function testHandlerChain(tmpDir: string): Promise<void> {
  console.log("\n断言组 3 — handler 链路：archive/list|restore 消费 requestIsolation");
  const store = newStore(tmpDir, "handler");
  try {
    // default 桶存量（模拟 /v2 匿名期写入）
    store.upsertL1(mkRecord("rd1", DEFAULT_TENANT), undefined);
    store.upsertL1(mkRecord("ra1", TENANT_A), undefined);
    check("3.1 前置：default + A 各归档一条",
      store.archiveL1("rd1", "forgetting") && store.archiveL1("ra1", "forgetting"));

    const listA = await handleArchiveList({ limit: 100 }, {} as never, "req-sec1-1", depsFor(store, TENANT_A));
    const listB = await handleArchiveList({}, {} as never, "req-sec1-2", depsFor(store, TENANT_B));
    const listAnon = await handleArchiveList({}, {} as never, "req-sec1-3", depsFor(store, { userId: "default", agentId: "default", sessionId: "s1" }));
    check("3.2 A 租户 list 只见 A 的（含归属出参）",
      listA.code === 0 && (listA.data as { items: Array<{ record_id: string; agent_id: string }> }).items.length === 1
      && (listA.data as { items: Array<{ record_id: string; agent_id: string }> }).items[0].agent_id === "agentA",
      JSON.stringify(listA.data));
    check("3.3 B 租户 list 为空（看不到 A/default）", listB.code === 0 && (listB.data as { items: unknown[] }).items.length === 0, JSON.stringify(listB.data));
    check("3.4 /v2 匿名（default 桶）只见 default 回填行（与拍板⑤自洽）",
      listAnon.code === 0 && (listAnon.data as { items: Array<{ record_id: string }> }).items.length === 1
      && (listAnon.data as { items: Array<{ record_id: string }> }).items[0].record_id === "rd1",
      JSON.stringify(listAnon.data));

    const restoreB = await handleArchiveRestore({ id: "ra1" }, {} as never, "req-sec1-4", depsFor(store, TENANT_B));
    check("3.5 B restore A 的归档 → 404（不泄漏存在性）", restoreB.code === 404, JSON.stringify(restoreB));
    const restoreA = await handleArchiveRestore({ id: "ra1" }, {} as never, "req-sec1-5", depsFor(store, TENANT_A));
    check("3.6 A restore 自己的归档 → ok", restoreA.code === 0 && (restoreA.data as { ok: boolean }).ok === true, JSON.stringify(restoreA));
  } finally {
    store.close();
  }
}

// ── main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("SEC-1 l1_archive 租户化 — 同形验证（临时库，跑完自动清理）");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-sec1-"));
  try {
    testFreshDb(tmpDir);
    testLegacyMigration(tmpDir);
    await testHandlerChain(tmpDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 无害 */ }
  }
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main();
