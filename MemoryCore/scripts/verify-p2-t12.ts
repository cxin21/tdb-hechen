/**
 * P2-T12 同形验证：core 租户化（K1 + 拍板⑤）。
 *
 * 背景：
 *   core_memory（slot PK, content, source, version, updated_at）与 core_values
 *   （value_id PK, label, weight, created_by）无任何归属列 —— 全 agent 共享身份小本本。
 *   修复：
 *     T12-A：两表加 team_id/user_id/agent_id 三列（新库 DDL 直带；存量库幂等迁移+回填
 *            DEFAULT_ISOLATION_ID="default"，拍板⑤：存量 7 行归属当前租户=default 桶）；
 *            唯一索引 (slot, team_id, user_id, agent_id) 代替单列 PK（存量库 slot PK
 *            阻塞跨租户并存，迁移时轻量重建解除 —— 表仅 1+6 行，成本可忽略）。
 *     T12-B：upsertCore/readCore/upsertValue/listValues 增 tenant 三元组过滤。
 *     T12-C：handler 消费 requestIsolation（照抄 T14 neighbors 模式）；/v2 匿名 →
 *            default 桶（与回填自洽）；K9 顺手修：审计 version 取刚写槽而非 readCore()[0]。
 *
 * 断言组（验收契约）：
 *   1. 全新库：建表含租户列（PRAGMA）；A 租户写 → A 读回 ✓、B 读不到 ✓。
 *   2. 存量迁移：模拟旧 5 列 core_memory（slot PK）+ 塞 2 行 → init/迁移 → 三列存在、
 *      回填值正确（default 家族）、同 slot 同租户 upsert 幂等（version 递增）、
 *      同 slot 不同租户并存 ✓。
 *   3. handler 链路：经 handleCoreMemoryWrite 带 A 租户写 → B 租户 readCore 为空；
 *      /v2 匿名（default 桶）读 default 回填行自洽。
 *   4. upsert 冲突目标：同 (slot,tenant) 二次写 → version+1 不插新行；
 *      不同租户同 slot → 两行并存。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p2-t12.ts
 *
 * 只用自建临时库，不连任何线上资源、不碰生产数据目录；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleCoreMemoryRead, handleCoreMemoryWrite } from "../src/gateway/v2-router.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { CoreTenant } from "../src/core/store/types.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const TENANT_A: CoreTenant = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const DEFAULT_TENANT: CoreTenant = { teamId: "default", userId: "default", agentId: "default" };

const CORE_CFG = {
  writeEnabled: true,
  allowedSlots: ["identity", "strict_rule", "core_value"],
  maxContentLength: 4096,
} as never;

function newStore(tmpDir: string, name: string): VectorStore {
  const store = new VectorStore(path.join(tmpDir, `${name}.db`), 0);
  const res = store.init();
  if (store.isDegraded()) {
    throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  }
  return store;
}

function coreColumns(rawDb: DatabaseSync, table: string): string[] {
  const info = rawDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.map((c) => c.name);
}

// ── 断言组 1：全新库 —— 租户列 + 双租户写读隔离 ─────────────────────────

async function testFreshDb(tmpDir: string): Promise<void> {
  console.log("\n断言组 1 — 全新库：建表含租户列（PRAGMA）+ 双租户写读隔离");
  const store = newStore(tmpDir, "fresh");

  const memCols = coreColumns(store.getRawDb(), "core_memory");
  const valCols = coreColumns(store.getRawDb(), "core_values");
  check("1a core_memory 含 team_id/user_id/agent_id 三列", ["team_id", "user_id", "agent_id"].every((c) => memCols.includes(c)), JSON.stringify(memCols));
  check("1b core_values 含 team_id/user_id/agent_id 三列", ["team_id", "user_id", "agent_id"].every((c) => valCols.includes(c)), JSON.stringify(valCols));

  store.upsertCore("identity", "A 的身份小本本", "manual", TENANT_A);
  store.upsertValue("honesty", "诚实第一", 0.9, "verify", TENANT_A);

  const aCore = store.readCore(TENANT_A);
  check("1c A 写 → A 读回 ✓", aCore.length === 1 && aCore[0].slot === "identity" && aCore[0].content === "A 的身份小本本", JSON.stringify(aCore));
  const bCore = store.readCore(TENANT_B);
  check("1d A 写 → B 读不到 ✓", bCore.length === 0, JSON.stringify(bCore));
  const bValues = store.listValues(TENANT_B);
  // PA（推翻 spec §5.1 裁决 2）：S6 读时兜底已移除——B 空桶 → 严格空 []（不回退
  // default 桶锚）。原"只见 default 锚"形态随 PA 作废；本库 l1_records 无记忆，
  // 扇出迁移也不产生任何副本。
  check("1e A 写 value → B 空桶严格空 []（PA 无兜底）/不见 A 锚",
    bValues.length === 0 && !bValues.some((v) => v.value_id === "honesty"),
    JSON.stringify(bValues));
  const aValues = store.listValues(TENANT_A);
  check("1f A 写 value → A 读回 ✓", aValues.length === 1 && aValues[0].value_id === "honesty", JSON.stringify(aValues));

  // 写入行实际落了租户列（存储级实证，不是读路径假象）
  const row = store.getRawDb().prepare("SELECT team_id, user_id, agent_id FROM core_memory WHERE slot='identity'").get() as { team_id: string; user_id: string; agent_id: string };
  check("1g 落库行带 A 三元组", row.team_id === "teamA" && row.user_id === "userA" && row.agent_id === "agentA", JSON.stringify(row));

  store.close();
}

// ── 断言组 2：存量迁移 —— 旧 5 列库 → 三列 + 回填 + 并存 ─────────────────

function createLegacyDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  // 生产 DDL 实况（T12 前）：core_memory(slot PK, content, source, version, updated_at)
  db.exec(`
    CREATE TABLE core_memory (
      slot TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE core_values (
      value_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      weight REAL NOT NULL DEFAULT 0.5,
      created_by TEXT NOT NULL DEFAULT ''
    )
  `);
  db.prepare("INSERT INTO core_memory (slot, content, source, version, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("identity", "存量身份行", "seed", 3, "2026-09-01T00:00:00Z");
  db.prepare("INSERT INTO core_memory (slot, content, source, version, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("strict_rule", "存量规则行", "seed", 2, "2026-09-02T00:00:00Z");
  db.prepare("INSERT INTO core_values (value_id, label, weight, created_by) VALUES (?, ?, ?, ?)")
    .run("honesty", "诚实第一", 0.9, "seed");
  db.close();
}

async function testLegacyMigration(tmpDir: string): Promise<void> {
  console.log("\n断言组 2 — 存量迁移：旧 slot PK 库 → 租户列 + 回填 + 跨租户并存");
  const dbPath = path.join(tmpDir, "legacy.db");
  createLegacyDb(dbPath);

  const store = new VectorStore(dbPath, 0);
  const res = store.init();
  if (store.isDegraded()) {
    throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  }

  const memCols = coreColumns(store.getRawDb(), "core_memory");
  check("2a 迁移后 core_memory 含三租户列", ["team_id", "user_id", "agent_id"].every((c) => memCols.includes(c)), JSON.stringify(memCols));

  const backfilled = store.readCore(DEFAULT_TENANT);
  check(
    "2b 存量 2 行回填 default 桶且内容/version 保留",
    backfilled.length === 2
      && backfilled.some((r) => r.slot === "identity" && r.content === "存量身份行" && r.version === 3)
      && backfilled.some((r) => r.slot === "strict_rule"),
    JSON.stringify(backfilled),
  );
  check("2c 存量 1 行 core_values 回填 default 桶", store.listValues(DEFAULT_TENANT).length === 1, JSON.stringify(store.listValues(DEFAULT_TENANT)));

  // 同 slot 同租户 upsert 幂等（version 递增，不插新行）
  store.upsertCore("identity", "存量身份行 v4", "api", DEFAULT_TENANT);
  const afterUpsert = store.getRawDb().prepare("SELECT COUNT(*) AS n FROM core_memory WHERE slot='identity' AND team_id='default'").get() as { n: number };
  const v4 = store.readCore(DEFAULT_TENANT).find((r) => r.slot === "identity");
  check("2d 同 (slot,tenant) 二次写 → 仍 1 行且 version 3→4", afterUpsert.n === 1 && v4?.version === 4, `rows=${afterUpsert.n} version=${v4?.version}`);

  // 同 slot 不同租户并存（存量 slot PK 必须已被解除）
  store.upsertCore("identity", "B 的身份小本本", "manual", TENANT_B);
  const total = store.getRawDb().prepare("SELECT COUNT(*) AS n FROM core_memory WHERE slot='identity'").get() as { n: number };
  const bView = store.readCore(TENANT_B);
  check("2e 同 slot 不同租户并存（两行）", total.n === 2, `rows=${total.n}`);
  check("2f B 只读到自己那行", bView.length === 1 && bView[0].content === "B 的身份小本本", JSON.stringify(bView));
  check("2g default 桶视图不被 B 写污染", store.readCore(DEFAULT_TENANT).find((r) => r.slot === "identity")?.content === "存量身份行 v4", JSON.stringify(store.readCore(DEFAULT_TENANT)));

  store.close();

  // 幂等：对已迁移库重复 init 不炸不重复回填
  const store2 = new VectorStore(dbPath, 0);
  store2.init();
  check("2h 重复 init 幂等（default 桶仍 2 行，无重复回填）", store2.readCore(DEFAULT_TENANT).length === 2, JSON.stringify(store2.readCore(DEFAULT_TENANT)));
  store2.close();
}

// ── 断言组 3：handler 链路 —— requestIsolation 消费 + /v2 匿名自洽 ────────

async function testHandlerChain(tmpDir: string): Promise<void> {
  console.log("\n断言组 3 — handler 消费 requestIsolation（A 写 → B 读空）+ /v2 匿名 default 桶自洽");
  // 复用断言组 2 的存量库（default 桶已有回填行，正好验证匿名自洽）
  const dbPath = path.join(tmpDir, "legacy.db");
  const store = new VectorStore(dbPath, 0);
  store.init();

  const depsFor = (tenant: { teamId?: string; userId: string; agentId: string }) => ({
    getStore: () => store,
    config: { memory: { coreMemory: CORE_CFG } },
    requestIsolation: { teamId: tenant.teamId, userId: tenant.userId, agentId: tenant.agentId, sessionId: "s1" },
  }) as never;

  const writeRes = await handleCoreMemoryWrite(
    { slot: "identity", content: "A 经 handler 写入的身份", source: "verify" },
    {} as never,
    "req-t12-3a",
    depsFor(TENANT_A),
  );
  check("3a A 租户 handler 写 → 200/code=0", (writeRes as { code?: number }).code === 0, JSON.stringify(writeRes));

  const readB = await handleCoreMemoryRead({} as never, {} as never, "req-t12-3b", depsFor(TENANT_B));
  const slotsB = ((readB as { data?: { slots?: unknown[] } }).data?.slots ?? []);
  check("3b B 租户读 → 不见 A 写入（含存量行也不见）", slotsB.length === 1 && JSON.stringify(slotsB).includes("B 的身份小本本"), JSON.stringify(slotsB));

  const readA = await handleCoreMemoryRead({} as never, {} as never, "req-t12-3c", depsFor(TENANT_A));
  const slotsA = ((readA as { data?: { slots?: Array<{ slot: string; content: string }> } }).data?.slots ?? []);
  check("3c A 租户读 → 见自己 handler 写入的行", slotsA.some((s) => s.content === "A 经 handler 写入的身份"), JSON.stringify(slotsA));
  // PA（推翻 spec §5.1 裁决 2）：读时兜底已移除——A 桶空 → values 严格 []，
  // default 桶存量锚 honesty 不再泄漏进 A 的读面（原 S6 第 5 项断言作废）。
  const valuesA = ((readA as { data?: { values?: Array<{ value_id: string }> } }).data?.values ?? []);
  check("3d A 读的 values 严格空（A 桶空 → []，PA 无兜底）",
    valuesA.length === 0, JSON.stringify(valuesA));

  // /v2 匿名（缺 team/user/agent → default 桶）与回填自洽：读得到存量行
  const anonDeps = { getStore: () => store, config: { memory: { coreMemory: CORE_CFG } }, requestIsolation: { userId: "default", agentId: "default", sessionId: "s1" } } as never;
  const readAnon = await handleCoreMemoryRead({} as never, {} as never, "req-t12-3e", anonDeps);
  const slotsAnon = ((readAnon as { data?: { slots?: Array<{ slot: string }> } }).data?.slots ?? []);
  check("3e /v2 匿名 → default 桶（读到回填的存量行）", slotsAnon.some((s) => s.slot === "identity" && s.content === "存量身份行 v4"), JSON.stringify(slotsAnon));

  // K9：审计 version 取刚写槽（B 桶 identity 的下一版），而非 readCore()[0]
  //（default 桶排序首行 —— 修复前正是取它导致版本失真，RED 期实测 version=7）。
  store.upsertCore("identity", "B 槽 v1", "manual", TENANT_B);
  const bVersionBefore = store.readCore(TENANT_B).find((s) => s.slot === "identity")?.version ?? 0;
  const defaultTopVersionBefore = store.readCore(DEFAULT_TENANT).find((s) => s.slot === "identity")?.version ?? 0;
  await handleCoreMemoryWrite({ slot: "identity", content: "B 槽 v2", source: "verify" }, {} as never, "req-t12-3f", depsFor(TENANT_B));
  const auditRows = store.getRawDb().prepare("SELECT record_id, version FROM memory_audit ORDER BY rowid DESC LIMIT ?").all(1) as Array<{ record_id: string; version: number }>;
  check("3f 审计落了一条 core 更新", auditRows.length === 1 && auditRows[0].record_id === "core:identity", JSON.stringify(auditRows));
  check(
    "3g 审计 version = 刚写槽（B 桶）的下一版，且 ≠ default 桶首行 version（K9 失真模式不复现）",
    auditRows[0]?.version === bVersionBefore + 1 && auditRows[0]?.version !== defaultTopVersionBefore,
    `audit=${auditRows[0]?.version} bBefore=${bVersionBefore} defaultTop=${defaultTopVersionBefore}`,
  );

  store.close();
}

// ── 断言组 4：upsert 冲突目标 —— 复合唯一索引语义 ────────────────────────

async function testConflictTarget(tmpDir: string): Promise<void> {
  console.log("\n断言组 4 — upsert 冲突目标：同 (slot,tenant) version+1；不同租户两行并存");
  const store = newStore(tmpDir, "conflict");

  store.upsertCore("identity", "v1", "manual", TENANT_A);
  store.upsertCore("identity", "v2", "manual", TENANT_A);
  store.upsertCore("identity", "B-v1", "manual", TENANT_B);

  const rows = store.getRawDb().prepare("SELECT slot, team_id, version FROM core_memory ORDER BY team_id").all() as Array<{ slot: string; team_id: string; version: number }>;
  check("4a 同 (slot,tenant) 二次写 → version+1 不插新行", rows.length === 2 && rows.find((r) => r.team_id === "teamA")?.version === 2, JSON.stringify(rows));
  check("4b 不同租户同 slot → 两行并存", rows.filter((r) => r.slot === "identity").length === 2, JSON.stringify(rows));

  store.upsertValue("honesty", "诚实 v1", 0.8, "verify", TENANT_A);
  store.upsertValue("honesty", "诚实 v2", 0.9, "verify", TENANT_A);
  store.upsertValue("honesty", "B 诚实", 0.7, "verify", TENANT_B);
  const aVals = store.listValues(TENANT_A);
  const bVals = store.listValues(TENANT_B);
  check("4c core_values 同 (value_id,tenant) 幂等 + 不同租户并存", aVals.length === 1 && aVals[0].weight === 0.9 && bVals.length === 1 && bVals[0].weight === 0.7, `A=${JSON.stringify(aVals)} B=${JSON.stringify(bVals)}`);

  // 唯一索引存在性
  const idx = store.getRawDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='core_memory' AND name='idx_core_memory_tenant'").get();
  check("4d idx_core_memory_tenant 唯一索引存在", !!idx, JSON.stringify(idx));

  store.close();
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== P2-T12 同形验证 ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p2-t12-"));
  let hardFail = false;
  try {
    // 每组独立 try：一组崩溃（如缺列 SQL 错）不吞掉其余组的 RED/GREEN 证据
    const groups: Array<[string, (d: string) => Promise<void>]> = [
      ["fresh", testFreshDb],
      ["legacy", testLegacyMigration],
      ["handler", testHandlerChain],
      ["conflict", testConflictTarget],
    ];
    for (const [name, fn] of groups) {
      try {
        await fn(tmpDir);
      } catch (err) {
        hardFail = true;
        console.error(`verify script crashed in group "${name}":`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
    }
  }
  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
  if (fail > 0 || hardFail) process.exit(1);
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
