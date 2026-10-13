/**
 * issue #1/#2 本机端到端验证（commit b68d167，2026-10-13）：
 *   ① 召回门「宁缺毋滥」——相关 query 只召回相关行、无关 query 零召回、部分 query 只回命中行；
 *   ② 灵魂行渲染——core_values 锚带 attrs.description 时注入块出现「label(方向)：描述」；
 *   ③ recall journal 观测——performLayeredRecall 返回点落 jsonl（T5 单一源），字段齐全。
 *
 * 数据安全：不写生产 D:\TDB\data\vectors.db —— node:sqlite `VACUUM INTO` 快照到临时目录，
 * 之后全部读写都发生在快照上；运行中的四服务（core/proxy/knowledge/panel）不受影响。
 * 快照目录保留供 backfill-anchor-description.ts 做 --apply 端到端（脚本末尾打印路径）。
 *
 * 用法（MemoryCore 目录下）：node --import tsx scripts/verify-issue2-gates-local.ts
 * 任何断言 FAIL → exit code 1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../src/core/store/sqlite.js";
import { NoopEmbeddingService } from "../src/core/store/embedding.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { performLayeredRecall } from "../src/core/hooks/auto-recall.js";
import type { MemoryTdaiConfig } from "../src/config.js";

const SRC_DB = "D:\\TDB\\data\\vectors.db";
const TENANT = { teamId: "team-gate-test", userId: "user-gate-test", agentId: "agt-gate-test" };

const results: Array<{ group: string; pass: boolean; detail: string }> = [];
const record = (group: string, pass: boolean, detail: string) => {
  results.push({ group, pass, detail });
  console.log(`  [${group}] ${pass ? "PASS" : "FAIL"}: ${detail}`);
};

console.log("=".repeat(72));
console.log("issue #1/#2 本机 E2E：召回门 + 灵魂行 + recall journal");
console.log("=".repeat(72));

// ── 0. 生产库快照（只读源，VACUUM INTO 一致性快照）──────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-issue2-verify-"));
const tmpDb = path.join(tmpDir, "vectors-snapshot.db");
{
  const src = new DatabaseSync(SRC_DB, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${tmpDb.replace(/\\/g, "/")}'`);
  } finally {
    src.close();
  }
}
console.log(`snapshot: ${SRC_DB} -> ${tmpDb}`);

const store = new VectorStore(tmpDb, 2048, {
  debug: () => {},
  info: () => {},
  warn: (msg: string) => console.log(`  [store-warn] ${msg}`),
  error: (msg: string) => console.log(`  [store-error] ${msg}`),
} as unknown as ConstructorParameters<typeof VectorStore>[2]);
const initRes = store.init();
if (store.isDegraded()) {
  console.log(`  [setup] WARN: store init 降级：${initRes.reason} — 结果可能失真`);
}
const embedding = new NoopEmbeddingService();

const nowIso = new Date().toISOString();
const mk = (id: string, content: string, extra: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "issue2-verify",
    source_message_ids: [],
    metadata: {},
    timestamps: [nowIso],
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 0,
    sessionKey: "issue2-verify",
    sessionId: "issue2-verify",
    teamId: TENANT.teamId,
    userId: TENANT.userId,
    agentId: TENANT.agentId,
    ...extra,
  }) as MemoryRecord;

// ── 1. 播种：4 相关 + 5 噪音（全部走 store.upsertL1 = 分词 + l1_fts 双写）──
const RELEVANT = [
  mk("iv_rel_1", "结算精度规则：跨模块金额分摊用双口径核对，尾差按最小币种单位冲回，避免累计精度丢失。"),
  mk("iv_rel_2", "用户拍板：结算尾差一律走暂估冲回流程，先挂暂估再按发票精确金额调整分录。"),
  mk(
    "iv_rel_3",
    "结算精度工作规则：分录金额合计与单据总额差超过0.01元必须人工复核，禁止静默抹平。",
    { type: "work_fact", scene_name: "结算" },
  ),
  // iv_rel_4 含连续短语「尾差冲回」= 裸锚回填的证据句（backfill 证据查询是 content LIKE '%尾差冲回%' 整词子串）
  mk("iv_rel_4", "月结操作规程：尾差冲回必须先挂暂估科目，凭证留痕后方可关账。"),
];
const NOISE = [
  mk("iv_noise_1", "用户喜欢番茄鸡蛋面，周末常自己做早餐。"),
  mk("iv_noise_2", "用户在学吉他，最近在练指弹曲子。"),
  mk("iv_noise_3", "用户家的猫叫团子，三岁橘猫。"),
  mk("iv_noise_4", "用户上周去爬山，天气很好。"),
  mk("iv_noise_5", "用户常用 VSCode 写代码，主题是深色。"),
];
{
  let ok = true;
  for (const r of [...RELEVANT, ...NOISE]) {
    const wrote = store.upsertL1(r, undefined); // embedding=undefined → FTS 路种子（无向量，等同降级形态）
    if (!wrote) ok = false;
  }
  record("setup", ok, `upsertL1 播种 ${RELEVANT.length + NOISE.length} 行（${RELEVANT.length} 相关 + ${NOISE.length} 噪音，tenant=${TENANT.teamId}/${TENANT.agentId}）`);
}

// ── 2. 价值锚：带描述（灵魂行渲染数据源）+ 裸锚（回填 E2E 用）────────
{
  const okDesc = store.upsertValue(
    "jiesuan-jingdu", "结算精度", 0.9, "agent", TENANT,
    undefined, undefined, undefined,
    { description: "结算金额必须双口径核对，尾差按最小币种单位冲回。" },
  );
  const okBare = store.upsertValue("weicha-chonghui", "尾差冲回", 0.8, "agent", TENANT, undefined, undefined, undefined, undefined);
  const values = store.listValues(TENANT);
  const described = values.find((v) => v.value_id === "jiesuan-jingdu");
  const descParsed = described ? (JSON.parse(described.attrs_json || "{}") as { description?: string }) : {};
  record(
    "setup",
    okDesc && okBare && values.length === 2 && !!descParsed.description,
    `upsertValue：描述锚 + 裸锚各一（listValues=${values.length}，描述锚 attrs.description="${descParsed.description ?? ""}"）`,
  );
}

// ── 3. cfg：e3 测试同款最小 recall 配置 + recallJournal 打开 ─────────
const cfg = {
  recall: {
    enabled: true,
    strategy: "hybrid",
    timeoutMs: 5000,
    maxResults: 5,
    scoreThreshold: 0.3,
    coreRefBoost: 0,
    queryEmbeddingCacheTtlMs: 0, // 隔离 E1：embed 计数只反映真实调用
    sessionReuseTtlMs: 300_000,
  },
  recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
} as unknown as MemoryTdaiConfig;

const run = (query: string) =>
  performLayeredRecall({
    userText: query,
    sessionKey: "issue2-verify-session",
    cfg,
    pluginDataDir: tmpDir,
    vectorStore: store,
    embeddingService: embedding,
    isolationFilter: TENANT,
  });

// ── 4. T1 相关 query：只回相关行 + 灵魂行带描述 ─────────────────────
{
  const out = await run("结算精度尾差怎么处理");
  const lines = out.memoryLines.join("\n");
  const hasRelevant = out.memoryLines.some((l) => l.includes("双口径") || l.includes("尾差"));
  const hasNoise = ["猫", "吉他", "番茄", "爬山", "VSCode"].some((w) => lines.includes(w));
  record("T1 精准召回", hasRelevant && !hasNoise, `query=结算精度尾差怎么处理 → ${out.memoryLines.length} 行（含相关=${hasRelevant}，含噪音=${hasNoise}）`);
  const soulOk = !!out.block && out.block.includes("结算精度") && out.block.includes("双口径核对");
  record("T1 灵魂行", soulOk, `block 含「结算精度(方向)：…双口径核对…」=${soulOk}`);
  console.log("  ---- T1 注入块 ----");
  console.log((out.block ?? "(empty)").split("\n").map((l) => `  | ${l}`).join("\n"));
  console.log("  ------------------");
}

// ── 5. T2 无关 query：宁缺毋滥（零召回优于噪音）────────────────────
{
  const out = await run("量子纠错码的表面码原理是什么");
  record("T2 宁缺毋滥", out.memoryLines.length === 0, `query=量子纠错码… → ${out.memoryLines.length} 行（期望 0）`);
}

// ── 6. T3 部分相关 query：只回真正词面命中的那行 ────────────────────
{
  const out = await run("番茄鸡蛋面怎么做");
  const onlyFood = out.memoryLines.length >= 1 && out.memoryLines.every((l) => l.includes("番茄鸡蛋面") || l.includes("早餐"));
  record("T3 部分命中", onlyFood, `query=番茄鸡蛋面怎么做 → ${out.memoryLines.length} 行（期望仅 iv_noise_1）`);
}

// ── 7. T4 journal：租户分文件 + 字段齐全 ────────────────────────────
{
  const journalFile = path.join(tmpDir, "logs", "recall", "recall-journal-team-gate-test-agt-gate-test.jsonl");
  const exists = fs.existsSync(journalFile);
  if (!exists) {
    record("T4 journal", false, `文件不存在：${journalFile}`);
  } else {
    const entries = fs.readFileSync(journalFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const required = ["ts", "query", "strategy", "teamId", "sessionReused", "layered", "conclusionCount", "experienceCount", "searchTiming", "memoryLines"];
    const allFields = entries.every((e) => required.every((k) => k in e));
    const tenantOk = entries.every((e) => e.teamId === TENANT.teamId && e.agentId === TENANT.agentId);
    const gateNote = entries.some((e) => "gates" in e)
      ? "gates 字段出现（native 分支）"
      : "gates 字段缺席 = sqlite fallback（nativeMinRRF 属 native TCVDB 分支，本库形态不适用；单测 memory-search-native-min-rrf.test.ts 6 例覆盖）";
    record("T4 journal", entries.length === 3 && allFields && tenantOk, `${entries.length} 条（期望 3）、必备字段齐全=${allFields}、租户正确=${tenantOk}；${gateNote}`);
    console.log(`  journal: ${journalFile}`);
  }
}

// ── 8. 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log("=".repeat(72));
console.log(`TOTAL: ${results.length - failed.length}/${results.length} PASS${failed.length ? `（FAIL: ${failed.map((f) => f.group).join(", ")}）` : ""}`);
console.log(`KEEP tmpDir（backfill E2E 用）: ${tmpDir}`);
console.log(`  dry-run: node --import tsx scripts/backfill-anchor-description.ts --db="${tmpDb}" --evidence=5`);
console.log(`  apply  : node --import tsx scripts/backfill-anchor-description.ts --db="${tmpDb}" --evidence=5 --apply`);
if (failed.length > 0) process.exit(1);
