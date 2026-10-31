/**
 * task-83（生产 L0 测试数据卫生 · B 段）—— 探针会话清理工具（**缺省 dry-run，--yes 才动库**）。
 *
 * 票面红线（cxin21/tdb-hechen，lead m02082）：
 *  - 生产 L0 现状 128 行 / 23 会话 / 905,703 字符，**一行都不许删**，除非用户明确授权；
 *  - 本工具的 `--yes` 只在自建自毁的隔离实例上验证；生产执行由 Lead 在拿到用户授权后跑；
 *  - 删除必须走服务端 `POST /v3/conversation/delete`（复用级联清 l0_fts/l0_vec），不直删 sqlite；
 *  - 删前必须全量导出可回滚的 jsonl（全列 + sha256），导出失败即中止。
 *
 * 安全设计：
 *  - 缺省 `--patterns=probe-,session-probe-`（与 A 段抽取闸同一事实源 session-ignore.ts）；
 *    未命中模式的行只出现在「保留」表里，永不进删除计划；
 *  - `l0_conversations.session_id` 列缺省值是字面量 'default'，把它当删除 id 会命中该身份
 *    全部缺省会话 ⇒ 本工具绝不把 'default' 或空串送进接口（见 l0-testdata-plan.ts）；
 *  - 目标是 D:/TDB/data 下的生产库时必须额外给 `--allow-production-db`；
 *  - base-url 不是本机回环时必须额外给 `--allow-remote`。
 *
 * 用法：
 *   # 干跑（默认，零写）：打印会话读数 + 三处计数
 *   node --import tsx scripts/l0-testdata-clean.ts --db <vectors.db> \
 *     [--patterns=probe-,session-probe-] [--sessions=probe-a,probe-b]
 *
 *   # 真删（必须先 dry-run 看读数）
 *   node --import tsx scripts/l0-testdata-clean.ts --db <vectors.db> --yes \
 *     --base-url http://127.0.0.1:8495 --api-key <key> \
 *     [--export-dir <dir>] [--service-id default] [--team-id default] \
 *     [--user-id default] [--agent-id default] [--allow-production-db] [--allow-remote]
 *
 * 退出码：0 = 成功（dry-run 亦为 0）；1 = 删除后计数未归零（有残留）；2 = 参数/导出/接口失败。
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildDeleteSessionIds,
  groupKeyOf,
  selectL0Sessions,
  validatePlan,
  DEFAULT_SESSION_ID,
  type L0RowLike,
} from "../src/utils/l0-testdata-plan.js";
import { DEFAULT_IGNORE_SESSION_PATTERNS } from "../src/utils/session-ignore.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROD_DATA_PREFIX = path.resolve(process.env.TDB_DATA_ROOT ?? "D:/TDB/data");
const DEFAULT_EXPORT_DIR = path.join(REPO_ROOT, "docs", "ops", "archive");
const ID_CHUNK = 100;

export interface Args {
  db: string;
  patterns: string[];
  sessions: string[];
  yes: boolean;
  baseUrl: string;
  apiKey: string;
  exportDir: string;
  serviceId: string;
  teamId: string;
  userId: string;
  agentId: string;
  allowProductionDb: boolean;
  allowRemote: boolean;
  allowUnmatchedSessions: boolean;
  timeoutMs: number;
}

function usage(): string {
  return [
    "用法: node --import tsx scripts/l0-testdata-clean.ts --db <vectors.db> [--yes] [...]",
    "",
    "  --db=<path>                    必填，vectors.db 路径（只读打开做读数）",
    "  --patterns=<a,b>               缺省 probe-,session-probe-；显式 --patterns= 表示不按模式选",
    "  --sessions=<a,b>               显式点名会话（session_key 或 session_id）",
    "  --yes                          真删（缺省 dry-run，零写）",
    "  --base-url=<url>               缺省 http://127.0.0.1:8420",
    "  --api-key=<key>                缺省取 env TDAI_API_KEY / TDAI_GATEWAY_APIKEY",
    "  --export-dir=<dir>             缺省 <repo>/docs/ops/archive",
    "  --service-id/--team-id/--user-id/--agent-id  身份四头，均缺省 default",
    "  --allow-production-db          允许对生产数据目录下的库执行 --yes",
    "  --allow-remote                 允许非回环 base-url",
    "  --allow-unmatched-sessions     允许删除未命中模式的显式会话",
    "  --timeout-ms=<n>               单次 HTTP 超时，缺省 60000",
  ].join("\n");
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseArgs(argv: readonly string[]): Args | { help: true } {
  const get = (name: string): string | undefined => {
    const flag = `--${name}`;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i]!;
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      if (a === flag) {
        // `--db /path` 形态：取下一个非 flag 值；下一位是另一个 flag 时视为空串
        const next = argv[i + 1];
        return next && !next.startsWith("--") ? next : "";
      }
    }
    return undefined;
  };
  const has = (name: string): boolean => argv.some((a) => a === `--${name}`);
  if (has("help") || argv.includes("-h")) return { help: true };

  const db = (get("db") ?? "").trim();
  if (!db) throw new Error("缺少 --db=<vectors.db>（见 --help）");

  const patternsRaw = get("patterns");
  return {
    db,
    patterns:
      patternsRaw === undefined ? [...DEFAULT_IGNORE_SESSION_PATTERNS] : splitList(patternsRaw),
    sessions: splitList(get("sessions") ?? ""),
    yes: has("yes"),
    baseUrl: (get("base-url") ?? "http://127.0.0.1:8420").trim().replace(/\/+$/, ""),
    apiKey: (get("api-key") ?? process.env.TDAI_API_KEY ?? process.env.TDAI_GATEWAY_APIKEY ?? "").trim(),
    exportDir: (get("export-dir") ?? DEFAULT_EXPORT_DIR).trim(),
    serviceId: (get("service-id") ?? "default").trim(),
    teamId: (get("team-id") ?? "default").trim(),
    userId: (get("user-id") ?? "default").trim(),
    agentId: (get("agent-id") ?? "default").trim(),
    allowProductionDb: has("allow-production-db"),
    allowRemote: has("allow-remote"),
    allowUnmatchedSessions: has("allow-unmatched-sessions"),
    timeoutMs: Number(get("timeout-ms") ?? 60000) || 60000,
  };
}

/** 三处计数：主表 + FTS + 向量。后两者可能不存在（vec 扩展未加载 / 老库）⇒ 报 unavailable。 */
export function countL0(db: DatabaseSync): { conversations: number; fts: number | null; vec: number | null } {
  const count = (table: string): number | null => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
      return typeof row?.n === "number" ? row.n : Number(row?.n ?? 0);
    } catch {
      return null;
    }
  };
  return { conversations: count("l0_conversations") ?? 0, fts: count("l0_fts"), vec: count("l0_vec") };
}

/** 只读全表（含全部列，导出用它）。 */
export function readAllL0(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM l0_conversations").all() as Array<Record<string, unknown>>;
}

/** 指定会话键的剩余行数（删后断言用；口径与 v2-router.ts:1397 一致）。 */
export function countRowsForIds(db: DatabaseSync, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM l0_conversations WHERE session_key IN (${ph}) OR session_id IN (${ph})`)
      .get(...chunk, ...chunk) as { n?: number } | undefined;
    total += Number(row?.n ?? 0);
  }
  return total;
}

function isoLocal(ts: string | null): string {
  return ts ?? "-";
}

function printPlan(res: ReturnType<typeof selectL0Sessions>, args: Args): void {
  console.log("\n=== 将被删除的会话（命中模式或显式列出） ===");
  if (res.selected.length === 0) {
    console.log("(无)");
  } else {
    console.log("session_key".padEnd(34) + "rows".padStart(6) + "chars".padStart(10) + "  " + "first".padEnd(21) + "last".padEnd(21) + "命中");
    for (const g of res.selected) {
      const hit =
        g.matchedBy?.kind === "pattern"
          ? `pattern:${g.matchedBy.pattern}(${g.matchedBy.matchedOn})`
          : g.matchedBy?.kind === "explicit"
            ? "explicit"
            : "-";
      console.log(
        g.key.padEnd(34) +
          String(g.rows).padStart(6) +
          String(g.chars).padStart(10) +
          "  " +
          isoLocal(g.firstSeen).padEnd(21) +
          isoLocal(g.lastSeen).padEnd(21) +
          hit,
      );
    }
  }
  console.log(
    `合计: ${res.selected.length} 会话 / ${res.selectedRows} 行 / ${res.selectedChars} 字符；送删除接口的 id 数 = ${buildDeleteSessionIds(res.selected).length}`,
  );

  console.log("\n=== 保留的会话（未命中，永不进删除计划） ===");
  if (res.kept.length === 0) {
    console.log("(无)");
  } else {
    for (const g of res.kept.slice(0, 40)) {
      console.log(`  ${g.key.padEnd(34)} ${String(g.rows).padStart(5)} 行  ${String(g.chars).padStart(9)} 字符`);
    }
    if (res.kept.length > 40) console.log(`  … 另有 ${res.kept.length - 40} 个会话未显示`);
  }
  console.log(`保留合计: ${res.kept.length} 会话 / ${res.keptRows} 行 / ${res.keptChars} 字符`);
  console.log(`\npatterns = ${JSON.stringify(args.patterns)}  sessions = ${JSON.stringify(args.sessions)}`);
}

function exportRows(rows: Array<Record<string, unknown>>, args: Args): { file: string; sha256: string } {
  mkdirSync(args.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(args.exportDir, `probe-l0-${stamp}.jsonl`);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  writeFileSync(file, body, "utf8");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, "utf8");
  if (rows.length === 0) throw new Error("导出 0 行：拒绝继续（导出失败即中止）");
  return { file, sha256 };
}

async function postDelete(ids: readonly string[], args: Args): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const res = await fetch(`${args.baseUrl}/v3/conversation/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
        "x-tdai-service-id": args.serviceId,
        "x-tdai-team-id": args.teamId,
        "x-tdai-user-id": args.userId,
        "x-tdai-agent-id": args.agentId,
      },
      body: JSON.stringify({ session_ids: chunk }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`删除失败 HTTP ${res.status}: ${text.slice(0, 400)}`);
    let parsed: { data?: { deleted_count?: number } } = {};
    try {
      parsed = JSON.parse(text) as { data?: { deleted_count?: number } };
    } catch {
      throw new Error(`删除响应不是 JSON: ${text.slice(0, 200)}`);
    }
    deleted += Number(parsed.data?.deleted_count ?? 0);
  }
  return deleted;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: Args | { help: true };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`参数错误: ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    return 2;
  }
  if ("help" in parsed) {
    console.log(usage());
    return 0;
  }
  const args = parsed;

  const dbPath = path.resolve(args.db);
  const before = countL0DbFile(dbPath);
  if (!before) {
    console.error(`找不到数据库文件: ${dbPath}`);
    return 2;
  }

  console.log(`库: ${dbPath}`);
  console.log(`计数（前）: l0_conversations=${before.conversations} l0_fts=${fmt(before.fts)} l0_vec=${fmt(before.vec)}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = readAllL0(db); // 句柄留到删后复查（readOnly，不写）
  const plan = selectL0Sessions(rows as L0RowLike[], { patterns: args.patterns, sessions: args.sessions });
  printPlan(plan, args);

  const ids = buildDeleteSessionIds(plan.selected);
  const planErrors = validatePlan(plan, { allowUnmatched: args.allowUnmatchedSessions });
  if (planErrors.length > 0) {
    console.error("\n[计划被拒]");
    for (const e of planErrors) console.error(`  - ${e}`);
  }

  if (!args.yes) {
    console.log(
      `\nDRY-RUN（零写）：真实删除请加 --yes，并确认这些会话确属测试污染。` +
        (planErrors.length === 0 ? "" : "\n注意：当前计划会被 --yes 直接拒绝（见上），先修正参数。"),
    );
    db.close();
    return 0;
  }

  // ---- 以下都是有写的路径（仅 --yes）----
  if (planErrors.length > 0) {
    db.close();
    return 2;
  }
  const isProd = dbPath.startsWith(PROD_DATA_PREFIX + path.sep) || dbPath === PROD_DATA_PREFIX;
  if (isProd && !args.allowProductionDb) {
    console.error(`\n拒绝：${dbPath} 位于生产数据目录 ${PROD_DATA_PREFIX}，执行 --yes 需额外 --allow-production-db`);
    db.close();
    return 2;
  }
  const host = new URL(args.baseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !args.allowRemote) {
    console.error(`\n拒绝：base-url ${args.baseUrl} 不是本机回环，需额外 --allow-remote`);
    db.close();
    return 2;
  }
  if (!args.apiKey) {
    console.error("\n拒绝：缺少 --api-key（或 env TDAI_API_KEY）");
    db.close();
    return 2;
  }

  const selectedKeys = new Set(plan.selected.map((g) => g.key));
  const rowsToExport = rows.filter((r) => selectedKeys.has(groupKeyOf(r as L0RowLike)));
  let exported: { file: string; sha256: string };
  try {
    exported = exportRows(rowsToExport, args);
  } catch (err) {
    console.error(`\n[中止] 导出失败，未做任何删除: ${err instanceof Error ? err.message : String(err)}`);
    db.close();
    return 2;
  }
  console.log(`\n已导出 ${rowsToExport.length} 行 → ${exported.file}`);
  console.log(`sha256 = ${exported.sha256}`);

  let deleted = 0;
  try {
    deleted = await postDelete(ids, args);
  } catch (err) {
    console.error(`\n[中止] 删除请求失败（已导出，可回滚）: ${err instanceof Error ? err.message : String(err)}`);
    db.close();
    return 2;
  }
  console.log(`接口返回 deleted_count = ${deleted}（含级联）`);

  const remaining = countRowsForIds(db, ids);
  const after = countL0(db);
  db.close();
  console.log(`计数（后）: l0_conversations=${after.conversations} l0_fts=${fmt(after.fts)} l0_vec=${fmt(after.vec)}`);
  console.log(`目标会话残留行数 = ${remaining}`);

  if (remaining !== 0) {
    console.error("\n[失败] 删除后目标会话仍有残留行：请检查 scope 身份头（team/user/agent）是否与行上的归属一致");
    return 1;
  }
  console.log("\n[成功] 目标会话已清零；回滚可用导出的 jsonl 重放 POST /v3/conversation/add");
  return 0;
}

function fmt(n: number | null): string {
  return n === null ? "unavailable" : String(n);
}

function countL0DbFile(dbPath: string): { conversations: number; fts: number | null; vec: number | null } | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return countL0(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /l0-testdata-clean\.(ts|mts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
