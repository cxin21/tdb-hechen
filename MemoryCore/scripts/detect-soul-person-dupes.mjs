#!/usr/bin/env node
/**
 * 同名人物只读检测（spec docs/specs/2026-11-10-soul-person-dedupe-spec.md §2）。
 *
 * 用法：
 *   node scripts/detect-soul-person-dupes.mjs --db <path>                    # 全库只读扫描
 *   node scripts/detect-soul-person-dupes.mjs --db <path> --tenant t/u/a     # 只看一个租户（可重复）
 *   node scripts/detect-soul-person-dupes.mjs --db <path> --json             # 末尾打印一行机器可读 JSON
 *
 * 安全边界：
 *   - --db 必填，没有「默认库」；始终以 readOnly 打开，一个字节都不写；
 *   - 只输出「候选 + 分级 + 墓碑健康」，不做任何合并；合并按 spec §4 人工执行；
 *   - 判据与代码同源：归一化函数直接 import src/core/person/resolve.ts，不手抄。
 *
 * 退出码：0 = 扫描完成；2 = 参数错误；3 = 执行错误。
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__DETECT_SOUL_PERSON_DUPES_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [TSX_ENV]: "1" } },
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { DatabaseSync } = await import("node:sqlite");
const { scanSoulPersonDupes } = await import("../src/core/person/dupes.ts");

const TAG = "[soul-person-dupes]";
const USAGE = [
  "用法：node scripts/detect-soul-person-dupes.mjs --db <path> [--tenant team/user/agent] [--json]",
  "  --db <path>        必填：要扫描的 sqlite 库（只读打开）",
  "  --tenant t/u/a     只看该租户（team_id/user_id/agent_id），可重复",
  "  --json             末尾额外打印一行机器可读 JSON",
].join("\n");

function die(code, message) {
  console.error(TAG + " " + message);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { db: "", tenants: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") out.db = argv[++i] ?? "";
    else if (arg === "--tenant") out.tenants.push(argv[++i] ?? "");
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else die(2, "未知参数 " + arg + "\n" + USAGE);
  }
  if (!out.db) die(2, "缺少 --db\n" + USAGE);
  if (!fs.existsSync(out.db)) die(2, "库不存在：" + out.db);
  for (const t of out.tenants) {
    const parts = t.split("/");
    if (parts.length !== 3) die(2, "--tenant 需要 team/user/agent 三段：" + t);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db;
const db = new DatabaseSync(dbPath, { readOnly: true });

let scan;
try {
  scan = scanSoulPersonDupes(db);
} catch (error) {
  die(3, "扫描失败：" + (error instanceof Error ? error.message : String(error)));
}

const matchesTenant = (g) =>
  args.tenants.length === 0 ||
  args.tenants.some((t) => {
    const [team, user, agent] = t.split("/");
    return g.teamId === team && g.userId === user && g.agentId === agent;
  });

const groups = scan.groups.filter(matchesTenant);
const aliasCandidates = scan.aliasCandidates.filter((c) => matchesTenant(c));

console.log(TAG + " 库：" + dbPath + "（只读）");
console.log(
  TAG +
    " 人物 " +
    scan.persons +
    " 行：存活 " +
    scan.alive +
    "，墓碑 " +
    scan.tombstones +
    "；同租户同名候选组 " +
    groups.length +
    "，别名候选 " +
    aliasCandidates.length +
    "，墓碑残留数据行 " +
    scan.leakedTotal,
);

if (groups.length === 0) {
  console.log(TAG + " 同一租户内没有同名多行，无需合并");
} else {
  for (const group of groups) {
    console.log(
      TAG +
        " [" +
        group.level +
        "] " +
        group.name +
        " · " +
        group.teamId +
        "/" +
        group.userId +
        "/" +
        group.agentId +
        "：" +
        group.reason,
    );
    for (const row of group.rows) {
      console.log(
        TAG +
          "    " +
          row.personKey +
          " platform=" +
          (row.platform || "-") +
          " platform_id=" +
          (row.platformId || "-") +
          " created=" +
          row.createdAt,
      );
    }
  }
  const byLevel = { A: 0, B: 0, C: 0 };
  for (const group of groups) byLevel[group.level] += 1;
  console.log(TAG + " 分级：A " + byLevel.A + " 组（可直接合并，执行前重跑检查） · B " + byLevel.B + " 组（人工确认后合并） · C " + byLevel.C + " 组（只登记，不合并）");
}

if (aliasCandidates.length > 0) {
  for (const c of aliasCandidates) {
    console.log(
      TAG +
        " [B·别名] " +
        c.fromKey +
        " 的别名「" +
        c.alias +
        "」命中存活行 " +
        c.targetKey +
        " · " +
        c.teamId +
        "/" +
        c.userId +
        "/" +
        c.agentId,
    );
  }
}

const leaked = scan.tombstoneHealth.filter(
  (h) => h.relSubj + h.relObj + h.state + h.stateEvents + h.personaHuman + h.episodes > 0,
);
if (leaked.length === 0) {
  console.log(TAG + " 墓碑健康：所有墓碑键上 0 条关系/状态/状态事件/human 人格/事件归属");
} else {
  for (const h of leaked) {
    console.log(
      TAG +
        " 墓碑残留 " +
        h.personKey +
        " -> " +
        h.mergedInto +
        "：出边 " +
        h.relSubj +
        " 入边 " +
        h.relObj +
        " 状态 " +
        h.state +
        " 状态事件 " +
        h.stateEvents +
        " human 人格 " +
        h.personaHuman +
        " 事件归属 " +
        h.episodes,
    );
  }
  console.log(TAG + " 结论：墓碑上还有数据，说明合并只立了指针没改键（spec §4 S3–S6）");
}

db.close();

if (args.json) {
  console.log(
    JSON.stringify({
      db: dbPath,
      persons: scan.persons,
      alive: scan.alive,
      tombstones: scan.tombstones,
      groups,
      aliasCandidates,
      tombstoneHealth: scan.tombstoneHealth,
      leakedTotal: scan.leakedTotal,
    }),
  );
}
