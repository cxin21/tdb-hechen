/**
 * S6 择机 parked 清零同形验证（阶段二批 B，七项）。
 *
 * 来源（账本 parked + 审查登记）：
 *   1. summarizer 重复注释块删除（S3 审计 M-1）——源码钉死：同一 C4 注释块只出现一次
 *   2. 401 提示补双 env 名（S3 审计 M-2）——源码钉死：提示文案同时含主用名
 *      TDAI_GATEWAY_APIKEY 与存量名 TDAI_GATEWAY_API_KEY
 *   3. verify-s3 断言错位修正（S3 审计 M-3）——实跑 verify-s3：c/d 拆开后输出含
 *      "d. metadata 全负"独立断言且全过
 *   4. verify-s3 dirname 兼容（S3 审计 M-4）——源码钉死：不用 import.meta.dirname
 *      （需 Node≥20.11），改 fileURLToPath(new URL(".", import.meta.url))（Node 20.6 兼容）
 *   5. 非 default 租户价值锚读时兜底（§6.4 #9，裁决：只读回退，写仍落本租户）——
 *      真实临时库行为断言
 *   6. restore 循环事务化（C2 fix1 复审 Low 1；brief 内 "restoreL1" 为笔误，
 *      实际目标=restoreValueValences 快照恢复循环，"尾部行 NULL 且快照丢弃"仅与该
 *      循环吻合）——真实临时库 + trigger 注入中途失败：重抛 + ROLLBACK 无半态
 *   7. reset SQL 失败可观测（C2 fix1 复审 Low 2）——真实临时库 + DROP TABLE 注入：
 *      reset 抛错、handler 503；空快照（无值可重置）仍合法 code=0
 *   8. verify-p3-t15 [4b] 负断言收紧（T15 复审；brief 内 "verify-p0-t2" 为笔误，
 *      [4b] 断言实际在 verify-p3-t15.ts:317）——源码钉死前缀级判断 + 实跑全过
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-s6.ts
 *
 * 纯本地验证（临时库 + mock LLM + trigger/DROP TABLE 注入），不连任何线上资源、
 * 不碰生产数据目录；跑完自动清理。自身不用 import.meta.dirname（与第 4 项同款，Node 20.6）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { VectorStore } from "../src/core/store/sqlite.js";
import { handleCoreMemoryValuesDerive } from "../src/gateway/v2-router.js";
import type { CoreTenant } from "../src/core/store/types.js";
import type { LLMRunner } from "../src/types.js";

// Node 20.6 兼容：不用 import.meta.dirname（S6 第 4 项同款模式）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

type RawDb = ReturnType<VectorStore["getRawDb"]>;

async function withStore(
  label: string,
  fn: (store: VectorStore, rawDb: RawDb, tmpDir: string) => Promise<void> | void,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-s6-${label}-`));
  const store = new VectorStore(path.join(tmpDir, "vectors.db"), 64, console as never);
  await store.init();
  try {
    if (store.isDegraded?.()) {
      check(`[${label}] 前置`, false, "临时库初始化降级（环境问题，非行为断言）");
      return;
    }
    await fn(store, store.getRawDb(), tmpDir);
  } finally {
    try { store.close(); } catch { /* Windows 句柄时序 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

const TENANT_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const TENANT_T: CoreTenant = { teamId: "teamT", userId: "userT", agentId: "agentT" };
const TENANT_C: CoreTenant = { teamId: "teamC", userId: "userC", agentId: "agentC" };
const TENANT_D: CoreTenant = { teamId: "teamD", userId: "userD", agentId: "agentD" };
const ISO_C = { teamId: "teamC", userId: "userC", agentId: "agentC", sessionId: "s-c" };
const ISO_D = { teamId: "teamD", userId: "userD", agentId: "agentD", sessionId: "s-d" };
const AUTH = {} as never;

function mockLlm(reply: string): LLMRunner {
  return { run: async () => reply } as never;
}

interface Deps { llm?: LLMRunner }
function depsFor(store: unknown, iso: unknown, extra: Deps = {}): Parameters<typeof handleCoreMemoryValuesDerive>[3] {
  return {
    getStore: () => store,
    logger: console as never,
    requestIsolation: iso,
    getValueValenceLlmRunner: () => extra.llm,
  } as never;
}

function runVerifyScript(rel: string): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", rel], { cwd: ROOT, encoding: "utf-8", timeout: 180_000 });
  return { status: r.status, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── 断言组 1：summarizer 重复注释块删除（S3 审计 M-1，源码钉死）──────────

function testM1DuplicateComment(): void {
  section("[1] summarizer.ts C4 注释块唯一（S3 审计 M-1）");
  const src = fs.readFileSync(path.join(HERE, "../src/core/lifecycle/consolidation/summarizer.ts"), "utf-8");
  const n = src.split("C4 策略统一（spec §5）").length - 1;
  check("1. 同一 C4 注释块只出现一次", n === 1, `occurrences=${n}`);
}

// ── 断言组 2：401 提示补双 env 名（S3 审计 M-2，源码钉死）────────────────

function testM2DualEnvCopy(): void {
  section("[2] gateway/server.ts 401 提示含双 env 名（S3 审计 M-2）");
  const src = fs.readFileSync(path.join(HERE, "../src/gateway/server.ts"), "utf-8");
  const dualLine = src.split("\n").find((l) => l.includes("TDAI_GATEWAY_API_KEY") && l.includes("TDAI_GATEWAY_APIKEY"));
  check("2. 存在同时含主用名 APIKEY 与存量名 API_KEY 的提示行", !!dualLine, dualLine?.trim() ?? "（未找到）");
}

// ── 断言组 3：verify-s3 断言错位修正（S3 审计 M-3，实跑）──────────────────

function testM3VerifyS3Fix(): void {
  section("[3] verify-s3 c/d 拆分：metadata 全负 → 0 独立断言（S3 审计 M-3）");
  const r = runVerifyScript("scripts/verify-s3.ts");
  check("3a. verify-s3 全过（exit=0）", r.status === 0, `exit=${r.status}`);
  check("3b. 输出含独立断言 d. metadata 全负 → 0", r.stdout.includes("d. metadata 全负"), "（c/d 合并组无此独立断言）");
}

// ── 断言组 4：verify-s3 dirname 兼容（S3 审计 M-4，源码钉死）──────────────

function testM4DirnameCompat(): void {
  section("[4] verify-s3 不用 import.meta.dirname（S3 审计 M-4，Node 20.6 底线）");
  const src = fs.readFileSync(path.join(HERE, "verify-s3.ts"), "utf-8");
  check("4a. 不再使用 import.meta.dirname（需 Node≥20.11）", !src.includes("import.meta.dirname"));
  check("4b. 改用 fileURLToPath(new URL(\".\", import.meta.url)) 模式", src.includes('new URL(".", import.meta.url)'));
}

// ── 断言组 5：listValues 严格无兜底（PA 推翻 §5.1 裁决 2 / 原 §6.4 #9 断言反转）────

async function testReadFallback(): Promise<void> {
  section("[5] listValues 严格无兜底（PA）：B 租户空桶 → []（不回退 default 桶锚）；写仍落本租户");
  await withStore("fallback", (store) => {
    // default 桶锚（无 tenant = default）
    check("5-前置. default 桶 upsert", store.upsertValue("honesty", "诚信", 0.9, "manual", undefined, 1));

    // 5a. B 租户空桶 → 严格返回 []（PA：读时兜底分支已移除，default 锚不再回退可见）
    const b0 = store.listValues(TENANT_B);
    check("5a. B 空桶 → 严格空 []（无兜底）", b0.length === 0,
      `got=[${b0.map((v) => v.value_id).join(",")}]`);

    // 5b. B 写自己的锚 → 只见自己的
    check("5b-前置. B 自锚 upsert", store.upsertValue("b-anchor", "B自锚", 0.8, "manual", TENANT_B, -1));
    const b1 = store.listValues(TENANT_B);
    check("5b. B 有自己的锚 → 只见自己的", b1.length === 1 && b1[0]?.value_id === "b-anchor",
      `got=[${b1.map((v) => v.value_id).join(",")}]`);

    // 5c. B 删自己的锚 → 空桶（原"回到兜底"断言随 PA 作废）
    check("5c-前置. B 自锚删除", store.deleteValue("b-anchor", TENANT_B));
    const b2 = store.listValues(TENANT_B);
    check("5c. 删后空桶 → 严格空 []（无兜底）", b2.length === 0,
      `got=[${b2.map((v) => v.value_id).join(",")}]`);
    // 5c+. default 桶自身读面不受影响（honesty 仍在 default 桶）
    check("5c+. default 桶锚不受 B 桶变化影响", store.listValues().length === 1 && store.listValues()[0]?.value_id === "honesty");
  });

  await withStore("fallback-empty", (store) => {
    // 5d. 双空 → []（不变）
    const b = store.listValues(TENANT_B);
    check("5d. 双空 → [] 不造数据", b.length === 0, `got=${b.length}`);
  });
}

// ── 断言组 6：restore 循环事务化（C2 fix1 复审 Low 1，行为断言 + 注入）──────

async function testRestoreTransaction(): Promise<void> {
  section("[6] restoreValueValences 循环事务化：中途抛错 → ROLLBACK + 重抛（Low 1）");
  await withStore("restore-tx", (store, rawDb) => {
    for (const [id, label, w, val] of [
      ["v1", "锚一", 0.9, 1],
      ["v2", "锚二", 0.8, -1],
      ["v3", "锚三", 0.7, 0],
    ] as const) {
      check(`6-前置. upsert ${id}`, store.upsertValue(id, label, w, "manual", TENANT_T, val));
    }
    const snapshot = store.resetValueValences(TENANT_T);
    check("6-前置. reset 快照 3 行且置 NULL", snapshot.length === 3 &&
      store.listValues(TENANT_T).every((v) => v.valence === null), `snapshot=${snapshot.length}`);

    // 注入：v2 行 UPDATE 时 RAISE(ABORT)（模拟恢复循环中途抛错）
    rawDb.exec(
      "CREATE TRIGGER s6_inject BEFORE UPDATE ON core_values FOR EACH ROW " +
      "WHEN OLD.value_id = 'v2' BEGIN SELECT RAISE(ABORT, 's6-injected'); END;",
    );

    let threw = false;
    let returned: number | undefined;
    try { returned = store.restoreValueValences(TENANT_T, snapshot); }
    catch { threw = true; }

    // 6a. 失败重抛（不再静默吞成部分计数）
    check("6a. restore 中途抛错 → 重抛", threw, threw ? "threw" : `silently returned ${returned}`);

    // 6b. ROLLBACK：无半态（首行恢复+尾部行 NULL 的旧缺陷被事务消除）
    const vals = store.listValues(TENANT_T).map((v) => v.valence);
    check("6b. ROLLBACK → 快照行全部保持 NULL（无首行半态）", vals.length === 3 && vals.every((v) => v === null),
      `vals=[${vals.join(",")}]`);

    // 解除注入 → 正常路径不损伤
    rawDb.exec("DROP TRIGGER s6_inject");
    let restored = 0;
    let threw2 = false;
    try { restored = store.restoreValueValences(TENANT_T, snapshot); }
    catch { threw2 = true; }
    const vals2 = store.listValues(TENANT_T).map((v) => v.valence);
    check("6c. 解除注入后 restore 正常恢复全部（事务不伤正常路径）",
      !threw2 && restored === 3 && vals2.every((v) => v !== null), `restored=${restored} vals=[${vals2.join(",")}]`);
  });
}

// ── 断言组 7：reset SQL 失败可观测（C2 fix1 复审 Low 2，行为断言 + 注入）────

async function testResetObservable(): Promise<void> {
  section("[7] resetValueValences SQL 失败 → 抛错 / handler 503；空快照合法（Low 2）");

  await withStore("reset-throw", async (store, rawDb) => {
    check("7-前置. upsert 2 行", store.upsertValue("c1", "锚C1", 0.9, "manual", TENANT_C, 1) &&
      store.upsertValue("c2", "锚C2", 0.8, "manual", TENANT_C, -1));

    // 注入 SQL 失败面
    rawDb.exec("DROP TABLE core_values");

    // 7a. store 层：reset SQL 失败 → 抛错（不再静默 []）
    let threw = false;
    let returned: unknown;
    try { returned = store.resetValueValences(TENANT_C); }
    catch { threw = true; }
    check("7a. reset SELECT 失败 → 抛错", threw, threw ? "threw" : `silently returned ${JSON.stringify(returned)}`);

    // 7b. handler 层：catch → 503（不再以 code=0 {0,0} 假成功）
    let code = -1;
    try {
      const env = await handleCoreMemoryValuesDerive({}, AUTH, "req-s6-7b", depsFor(store, ISO_C, { llm: mockLlm('{"valences":[]}') }));
      code = env.code;
    } catch (err) {
      check("7b. handler 不抛透（catch → 503 envelope）", false, `uncaught: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    check("7b. reset SQL 失败 → handler 503", code === 503, `code=${code}`);
  });

  await withStore("reset-empty", async (store) => {
    // 7c. 空快照（无值可重置）仍合法：code=0 {derived:0,...}
    const env = await handleCoreMemoryValuesDerive({}, AUTH, "req-s6-7c", depsFor(store, ISO_D, { llm: mockLlm('{"valences":[]}') }));
    const body = env.data as { derived?: number; skipped?: number };
    check("7c. 空快照 → 合法 code=0 {0,0}", env.code === 0 && body?.derived === 0, `code=${env.code} body=${JSON.stringify(body)}`);
  });
}

// ── 断言组 8：verify-p3-t15 [4b] 负断言收紧（T15 复审）────────────────────

function testT15PrefixAssertion(): void {
  section("[8] verify-p3-t15 [4b] 前缀级负断言（T15 复审）");
  const src = fs.readFileSync(path.join(HERE, "verify-p3-t15.ts"), "utf-8");
  const b4Line = src.split("\n").find((l) => l.includes("[4b]") || l.includes("4b]"));
  const b4Assert = src.split("\n").find((l) => l.includes("formattedVec") && l.includes("degraded"));
  // S7 第 6 项（S6 审查 M-5）：8a 正则抗变体——匹配"子串级 degraded 判定"的语义而非写法
  // 形态。旧正则 /formattedVec\s*&&.*includes\("degraded"\)/ 只钉一种写法；回归者换成
  // 单引号/反引号、indexOf(...) !== -1 / >= 0、.match(/degraded/) 均可绕过。以下任一
  // 形态出现在 formattedVec 判定行即判 FAIL：
  const SUBSTR_LEVEL_RES: RegExp[] = [
    /includes\(\s*['"`]degraded/,                                        // includes("degraded") / '...' / `...`
    /indexOf\(\s*['"`]degraded['"`]\s*\)\s*(?:===?|!==?|<=?|>=?)\s*-?\d/, // indexOf(...) === -1 / >= 0 / ...
    /\.match\(\s*\/degraded/,                                            // .match(/degraded/)
  ];
  const vecLines = src.split("\n").filter((l) => l.includes("formattedVec"));
  const substrLevelHit = vecLines.find((l) => SUBSTR_LEVEL_RES.some((re) => re.test(l)));
  check("8a. [4b] 负断言无子串级 degraded 判定（抗变体：includes/indexOf/match 全形态）",
    substrLevelHit === undefined,
    substrLevelHit?.trim() ?? "（无子串级判定）");
  check("8b. [4b] 改为前缀级判断（[degraded 标记行级）", /startsWith\("\[degraded/.test(src),
    b4Line?.trim() ?? "");
  const r = runVerifyScript("scripts/verify-p3-t15.ts");
  check("8c. verify-p3-t15 全过（exit=0）", r.status === 0, `exit=${r.status}`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== S6 择机 parked 清零同形验证 ===");
  testM1DuplicateComment();
  testM2DualEnvCopy();
  testM3VerifyS3Fix();
  testM4DirnameCompat();
  await testReadFallback();
  await testRestoreTransaction();
  await testResetObservable();
  testT15PrefixAssertion();

  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
