/**
 * #21（I5 descope，p18 遗留项）：存量 active theme 锚 aliases 回填（一次性，可重入）。
 *
 * 背景：#18 给 theme 池加上 aliases 维度（parse/证据 OR 口径/集合级去重），但只对新提案
 *   生效——存量锚 attrs_json 无 aliases，#18 的变体去重与证据 OR 对它们不生效。
 *   本脚本对存量锚用 LLM 提议别名（F19 规范 + 确定性守卫），读改合并写回。
 *
 * 合同：
 * - 目标 = active theme 锚且 attrs_json 无非空 aliases（SQL 侧过滤，见 listAliasTargetsSql）；
 * - 证据 = 锚自身租户过滤（同 backfill-anchor-description.ts 的跨租户污染防线），
 *   无证据行 → 跳过且不调 LLM；
 * - LLM 提议 → 确定性守卫（trim/去空/大小写去重/等于 label 剔除/超 12 字剔除/cap 3）；
 *   守卫后空 → noAlias；回复坏 JSON → skippedBadReply；LLM 异常 → failed（继续其余锚）；
 * - 写回 = 读改合并，只动 aliases + aliasesSource 两个键（F1 教训：attrs_json 全量替换
 *   必须先读后并，绝不丢 description/lastDescRefreshEvidence/role/facts 等既有键）；
 * - aliases 不参与 fired（#18 钉死 label-only）→ 本脚本零行为面变化，仅去重/展示/证据 OR 生效；
 * - 缺省 dry-run（零写）；--write 才落库。可重入：已写 aliases 的锚不再是目标。
 *
 * 用法: node --import tsx scripts/backfill-theme-aliases.ts --db <vectors.db> [--write] [--limit N]
 *   LLM 凭据（ADR-0006）：override（<dataDir>/config-override.json）> gateway yaml llm 段 >
 *   TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL（env 已 deprecated，仅回退）
 */
import { pathToFileURL } from "node:url";
import { VectorStore } from "../src/core/store/sqlite.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import type { LLMRunner } from "../src/core/types.js";
import { readLlmCredential } from "./lib/read-llm-credential.js";

const TAG = "[backfill-theme-aliases]";
const ALIAS_MAX = 12;
const ALIAS_CAP = 3;
const EVIDENCE_CAP = 20;
const EXCERPT_CAP = 120;

export interface AliasBackfillTenant {
  teamId: string;
  userId: string;
  agentId: string;
}

export interface AliasBackfillRow extends AliasBackfillTenant {
  rowid: number;
  value_id: string;
  label: string;
  attrs_json: string;
}

export interface AliasBackfillStore {
  listAliasBackfillTargets(): AliasBackfillRow[];
  sampleEvidence(tenant: AliasBackfillTenant, label: string, cap: number): string[];
  updateAnchorAttrs(rowid: number, attrsJson: string): void;
}

export interface AliasBackfillStats {
  scanned: number;
  proposed: number;
  written: number;
  noAlias: number;
  skippedNoEvidence: number;
  skippedBadReply: number;
  failed: number;
}

export interface AliasBackfillDeps {
  store: AliasBackfillStore;
  llmRunner: Pick<LLMRunner, "run">;
  write: boolean;
  limit?: number;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

// 确定性守卫（#11 同族：LLM 提议、代码裁决）。空/trim 后空/大小写重复/等于 label/超长 → 剔除。
export function sanitizeAliases(raw: unknown, label: string): string[] {
  const labelNorm = label.trim().toLowerCase();
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const a = item.trim();
    if (!a) continue;
    const aNorm = a.toLowerCase();
    if (aNorm === labelNorm) continue;
    if (a.length > ALIAS_MAX) continue;
    if (out.some((x) => x.toLowerCase() === aNorm)) continue;
    out.push(a);
    if (out.length >= ALIAS_CAP) break;
  }
  return out;
}

function parseAliasesReply(raw: string): unknown {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const ALIAS_SYSTEM_PROMPT = `你是记忆系统的别名归一助手。给定一个价值锚标签和若干证据摘录，提出该标签在语料中的常见变体叫法（同义词/简称/英文/缩写）。
规则：
- 只提议语料中有实际出现的变体；宁缺毋滥，最多 3 个；
- 每个不超过 12 个字；不得与标签本身相同；
- 只输出严格 JSON：{"aliases":["…"]}，不要任何解释。`;

function buildAliasPrompt(label: string, excerpts: string[]): string {
  const lines = excerpts.slice(0, 5).map((e, i) => `${i + 1}. ${e.length > EXCERPT_CAP ? e.slice(0, EXCERPT_CAP) : e}`);
  return `锚标签：${label}\n证据摘录：\n${lines.join("\n") || "（无）"}`;
}

export async function runAliasBackfill(deps: AliasBackfillDeps): Promise<AliasBackfillStats> {
  const { store, llmRunner, write, logger } = deps;
  const stats: AliasBackfillStats = { scanned: 0, proposed: 0, written: 0, noAlias: 0, skippedNoEvidence: 0, skippedBadReply: 0, failed: 0 };
  const all = store.listAliasBackfillTargets();
  const rows = deps.limit !== undefined ? all.slice(0, deps.limit) : all;
  for (const a of rows) {
    stats.scanned++;
    const tenant: AliasBackfillTenant = { teamId: a.team_id, userId: a.user_id, agentId: a.agent_id };
    const evidence = store.sampleEvidence(tenant, a.label, EVIDENCE_CAP);
    if (evidence.length === 0) {
      stats.skippedNoEvidence++;
      logger.warn(`${TAG} ${a.label} @ ${a.team_id}/${a.user_id}/${a.agent_id}: 无证据行，跳过（不调 LLM）`);
      continue;
    }
    let raw: string;
    try {
      raw = await llmRunner.run({ prompt: buildAliasPrompt(a.label, evidence), systemPrompt: ALIAS_SYSTEM_PROMPT, taskId: "backfill-theme-aliases", timeoutMs: 120_000, maxTokens: 512 });
    } catch (err) {
      stats.failed++;
      logger.warn(`${TAG} ${a.label}: LLM 失败（${err instanceof Error ? err.message : String(err)}），跳过`);
      continue;
    }
    const parsed = parseAliasesReply(raw);
    const aliases = sanitizeAliases((parsed as { aliases?: unknown } | null)?.aliases, a.label);
    if (aliases.length === 0) {
      if (parsed === null) stats.skippedBadReply++;
      else stats.noAlias++;
      logger.warn(`${TAG} ${a.label}: ${parsed === null ? "回复非 JSON" : "守卫后无有效别名"}，跳过`);
      continue;
    }
    stats.proposed++;
    logger.info(`${TAG} ${a.label} ← [${aliases.join(", ")}]${write ? "" : "（dry-run）"}`);
    if (!write) continue;
    // F1 纪律：读改合并——只动 aliases/aliasesSource，其余键原样保留。
    let attrs: Record<string, unknown> = {};
    try {
      const parsedAttrs = a.attrs_json ? (JSON.parse(a.attrs_json) as unknown) : {};
      if (parsedAttrs && typeof parsedAttrs === "object" && !Array.isArray(parsedAttrs)) attrs = parsedAttrs as Record<string, unknown>;
    } catch {
      attrs = {};
    }
    attrs.aliases = aliases;
    attrs.aliasesSource = "backfill";
    store.updateAnchorAttrs(a.rowid, JSON.stringify(attrs));
    stats.written++;
  }
  logger.info(`${TAG} done: scanned=${stats.scanned} proposed=${stats.proposed} written=${stats.written} noAlias=${stats.noAlias} noEvidence=${stats.skippedNoEvidence} badReply=${stats.skippedBadReply} failed=${stats.failed}${write ? "" : "（dry-run，加 --write 落库）"}`);
  return stats;
}

// ── store 适配（直连 sqlite；与 backfill-anchor-description.ts 同一防线）─────────

const TARGETS_SQL = `
  SELECT rowid, value_id, label, attrs_json, team_id, user_id, agent_id
  FROM core_values
  WHERE state='active' AND node_type='theme'
    AND (CASE
         WHEN attrs_json IS NULL OR attrs_json='' OR attrs_json='{}' THEN 1
         WHEN json_valid(attrs_json)=0 THEN 1
         WHEN json_extract(attrs_json,'$.aliases') IS NULL THEN 1
         WHEN json_extract(attrs_json,'$.aliases')='[]' THEN 1
         ELSE 0 END)=1
  ORDER BY rowid`;

const EVIDENCE_SQL = `
  SELECT content FROM l1_records
  WHERE content LIKE ? ESCAPE '\\'
    AND IFNULL(team_id,'default')=IFNULL(?,'default')
    AND IFNULL(user_id,'default')=IFNULL(?,'default')
    AND IFNULL(agent_id,'default')=IFNULL(?,'default')
  ORDER BY significance DESC, created_time DESC LIMIT ?`;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Db {
  prepare(sql: string): { all(...args: (string | number)[]): unknown[]; run(...args: (string | number)[]): void };
}

function sqliteAliasStore(db: Db): AliasBackfillStore {
  return {
    listAliasBackfillTargets(): AliasBackfillRow[] {
      return db.prepare(TARGETS_SQL).all() as unknown as AliasBackfillRow[];
    },
    sampleEvidence(tenant: AliasBackfillTenant, label: string, cap: number): string[] {
      const rows = db
        .prepare(EVIDENCE_SQL)
        .all(`%${escapeLike(label)}%`, tenant.teamId, tenant.userId, tenant.agentId, cap) as Array<{ content: string }>;
      return rows.map((r) => String(r.content ?? ""));
    },
    updateAnchorAttrs(rowid: number, attrsJson: string): void {
      db.prepare("UPDATE core_values SET attrs_json=? WHERE rowid=?").run(attrsJson, rowid);
    },
  };
}

// ── CLI（tsx 直跑；被 import 时不执行）────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--db" || a === "--limit") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${TAG} 参数 ${a} 缺值`);
      args[a.slice(2)] = v;
    } else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log(`用法：node --import tsx scripts/backfill-theme-aliases.ts --db <vectors.db> [--write] [--limit N]
  默认 dry-run（零写）；--write 真实写库（幂等，可中断重跑）。
  LLM 凭据环境变量：TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL`);
    if (!args.db) process.exitCode = 1;
    return;
  }
  const vs = new VectorStore(String(args.db), 0, console as never);
  await vs.init();
  try {
    const db = (vs as unknown as { db: Db }).db;
    const cred = readLlmCredential();
    if (!cred) throw new Error(`${TAG} LLM 凭据不全（override/yaml/env 均未配齐；ADR-0006：SoT=admin settings config-override.json）`);
    console.error(`${TAG} LLM credSource=${cred.apiKeySource} model=${cred.model}`);
    const llmRunner: LLMRunner = new StandaloneLLMRunner({
      config: { baseUrl: cred.baseUrl, apiKey: cred.apiKey, model: cred.model, maxTokens: 512, timeoutMs: 120_000 },
      logger: console as never,
    });
    const stats = await runAliasBackfill({
      store: sqliteAliasStore(db),
      llmRunner,
      write: args.write === true,
      limit: args.limit !== undefined ? Number(args.limit) : undefined,
      logger: console as never,
    });
    if (args.write === true && (stats.failed > 0 || stats.skippedBadReply > 0)) process.exitCode = 2; // loud：有失败，非全绿
  } finally {
    await vs.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`${TAG} 未捕获异常: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}