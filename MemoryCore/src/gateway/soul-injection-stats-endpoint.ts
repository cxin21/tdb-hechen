/**
 * P0-D（2026-11-07）：GET /v3/soul/injection/stats —— 人格注入健康面（只读）。
 *
 * 为什么需要：注入回报链路（POST /v3/soul/injection）只写 journal，没人读；于是
 * 「这个 agent 最近一次注入是什么时候、成功没有、多少字符」在 Panel 与运维侧都答不出。
 * 本端点把 journal 目录里的两类行（`kind:"injection"` 与召回行）聚合出来，**不新表、
 * 不新增配置、不写任何东西**。
 *
 * 口径（都能从行本身算出来；算不出的给 null，绝不用 0 冒充「没有」）：
 *   - `rows`：窗口内的注入行数（team/agent 精确、user 给了才过滤）。
 *   - `lastAt` / `lastCard` / `lastVolatile`：窗口内最近一条注入行的时间与两条通道的元数据。
 *   - `failReasons`：注入行带 `failReason` 时按五类计数（Round11 起 `section_install_failed` 单列）；**窗口内没有任何行上报过失败信息**
 *     时为 null——因为「没上报」与「没有失败」在数据上不可分辨。
 *   - `serverRenderOnly`：窗口内有 soul 观测、但该 sessionKey 没有任何注入行回传的召回行数
 *     （= 这些轮次只有 Core 侧估算，插件没回报）。
 *   - `pairs.matched`：同时有召回 soul 行与注入行的 sessionKey 数；
 *     `pairs.charMismatch`：这些会话里，尾巴（volatile chars vs 召回 turnChars，两侧同定义）
 *     至少一处不等的会话数。卡侧 chars 定义不同（两段 vs 整卡）不可比，不计入（A5 复核）。
 *     注意召回行没有 turn 字段，对账单位是 sessionKey（见 recall-journal.ts 的行结构）。
 *
 * 降级：journal 关闭或目录不存在 → 200 + 全零 + `note:"journal_disabled"`（不 500）。
 * 参数：`team` 必填（缺 → 400 missing_team）；`user` 可选过滤；`agent` 缺省 `default`
 * （与 recallJournalFileName 的兜底一致）；`hours` 缺省 24、必须 1..8760（非法 → 400 bad_hours）。
 *
 * v2 契约（2026-11-18，Round3 阶段2；新增字段，不保证与旧响应二进制兼容）：
 *   - 默认排除测试身份（team/user/agent 以 `-test` / `-key` 结尾或以 `test-` 开头）的
 *     journal 行，被排除行数进 `excluded.testRows`；`includeTest=1|true` 时不过滤（显式捞回）。
 *     动因：生产 journal 里 `team-test/*` 的 empty 行会掩盖真实故障（A4 复核）。
 *   - 新增 `plugin`：直接聚合插件侧 `persona-injection.jsonl`（含 `.1` 轮转）。
 *     `card-bound-failed` 的 reason 分布在这里可见——旧版 `failReasons` 只覆盖 Core 侧
 *     上报行，插件本地失败行以前完全读不到（A4 缺口①）。
 *   - journal 关闭不再整包短路：`note:"journal_disabled"` 时仍返回 plugin 聚合。
 */
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { RecallJournalOpts } from "../core/recall/recall-journal.js";
import { recallJournalFileName } from "../core/recall/recall-journal.js";

export const SOUL_INJECTION_STATS_PATH = "/v3/soul/injection/stats";

/** 与注入端点的失败原因同名（插件侧 warn 的分类）。 */
const FAIL_REASONS = ["http_status", "timeout", "empty", "parse", "section_install_failed"] as const;
type FailReason = (typeof FAIL_REASONS)[number];
/**
 * A4 Round10/Round11：段注册失败也走同一个上报通道。Round11 起它在 failReasons
 * 里单列一个桶——面板按「五个桶任一 >0」判红，才能看见「人格段根本没进提示词」；
 * Round10 把它并进 other，面板判据会假绿（A4 复核 R1）。
 */
const EXTRA_FAIL_REASONS = ["section_install_failed"] as const;
/**
 * 插件本地日志的 reason 集合：取卡失败四类 + other（段注册失败在插件侧另有事件，
 * 不混进这个键空间——它有自己的 event 与 failReasons 桶）。
 */
type PluginFailReason = "http_status" | "timeout" | "empty" | "parse" | "other";
const PLUGIN_FAIL_REASONS = ["http_status", "timeout", "empty", "parse"] as const;

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 365;
/** 轮转文件最多看 maxFiles 个；再多就是历史考古，不是健康面。 */
const MAX_FILES_HARD_CAP = 8;
/** 单次请求的读取预算：生产 5MB×5/租户，留足余量又不至于把内存打爆。 */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINES = 300_000;
/** 插件证据日志的读取预算：2MB×2 轮转，留 4 倍余量。 */
const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;

export interface SoulInjectionStatsRouteDeps {
  /** 与 auto-recall / 注入端点同源：`<dataDir>/logs/recall`。 */
  journalDir: string;
  journalOpts: RecallJournalOpts;
  /**
   * 插件侧证据日志（v2）。缺省 = journalDir 的兄弟文件 `persona-injection.jsonl`；
   * 插件可用 TDB_PERSONA_LOG 改路径，所以服务端允许显式覆盖。
   */
  pluginLogPath?: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

interface InjectionRowLike {
  kind: "injection";
  ts: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  sessionKey?: string;
  turn?: number | null;
  card?: { version: number; hash: string; chars: number };
  volatile?: { chars: number; hash: string; skipped: boolean };
  /** 前向兼容：插件若上报失败原因，落在这一键上（当前版本不写）。 */
  failReason?: string;
  failStatus?: number;
  usage?: { matchedLines: number; totalLines: number; overlapPct: number };
}

interface RecallSoulRowLike {
  ts: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  sessionKey?: string;
  soul?: {
    sessionInit?: { version: number; hash: string; chars: number };
    turnChars?: number;
    source?: "plugin" | "server-render";
    failReason?: string;
  };
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return undefined;
  return trimmed;
}

function asFiniteCount(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function asInjectionRow(value: unknown): InjectionRowLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== "injection") return undefined;
  const ts = asString(v.ts, 64);
  if (ts === undefined) return undefined;
  const cardRaw = v.card as Record<string, unknown> | undefined;
  const volRaw = v.volatile as Record<string, unknown> | undefined;
  const card =
    cardRaw && typeof cardRaw === "object"
      ? {
          version: asFiniteCount(cardRaw.version) ?? 0,
          hash: asString(cardRaw.hash, 128) ?? "",
          chars: asFiniteCount(cardRaw.chars) ?? 0,
        }
      : undefined;
  const usageRaw = v.usage as Record<string, unknown> | undefined;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? {
          matchedLines: asFiniteCount(usageRaw.matchedLines) ?? 0,
          totalLines: asFiniteCount(usageRaw.totalLines) ?? 0,
          overlapPct: typeof usageRaw.overlapPct === "number" && Number.isFinite(usageRaw.overlapPct) ? usageRaw.overlapPct : 0,
        }
      : undefined;
  const volatile =
    volRaw && typeof volRaw === "object"
      ? {
          chars: asFiniteCount(volRaw.chars) ?? 0,
          hash: asString(volRaw.hash, 128) ?? "",
          skipped: volRaw.skipped === true,
        }
      : undefined;
  return {
    kind: "injection",
    ts,
    teamId: asString(v.teamId, 128),
    userId: asString(v.userId, 128),
    agentId: asString(v.agentId, 128),
    sessionKey: asString(v.sessionKey, 400),
    turn: typeof v.turn === "number" && Number.isFinite(v.turn) ? Math.floor(v.turn) : null,
    ...(card ? { card } : {}),
    ...(volatile ? { volatile } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof v.failReason === "string" &&
    ((FAIL_REASONS as readonly string[]).includes(v.failReason) ||
      (EXTRA_FAIL_REASONS as readonly string[]).includes(v.failReason))
      ? { failReason: v.failReason }
      : {}),
    ...(typeof v.failStatus === "number" && Number.isFinite(v.failStatus) ? { failStatus: v.failStatus } : {}),
  };
}

function asRecallSoulRow(value: unknown): RecallSoulRowLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "injection") return undefined;
  const ts = asString(v.ts, 64);
  if (ts === undefined) return undefined;
  const soulRaw = v.soul;
  if (!soulRaw || typeof soulRaw !== "object") return undefined;
  const s = soulRaw as Record<string, unknown>;
  const initRaw = s.sessionInit as Record<string, unknown> | undefined;
  const sessionInit =
    initRaw && typeof initRaw === "object"
      ? {
          version: asFiniteCount(initRaw.version) ?? 0,
          hash: asString(initRaw.hash, 128) ?? "",
          chars: asFiniteCount(initRaw.chars) ?? 0,
        }
      : undefined;
  const source =
    s.source === "plugin" || s.source === "server-render" ? (s.source as "plugin" | "server-render") : undefined;
  return {
    ts,
    teamId: asString(v.teamId, 128),
    userId: asString(v.userId, 128),
    agentId: asString(v.agentId, 128),
    sessionKey: asString(v.sessionKey, 400),
    soul: {
      ...(sessionInit ? { sessionInit } : {}),
      ...(typeof s.turnChars === "number" && Number.isFinite(s.turnChars)
        ? { turnChars: Math.floor(s.turnChars as number) }
        : {}),
      ...(source ? { source } : {}),
    },
  };
}

/** 当前文件 + 已轮转的历史文件（`stem.<k>.jsonl`）；只看存在的。 */
function journalFilesOf(dir: string, teamId: string, agentId: string, maxFiles: number): string[] {
  const base = recallJournalFileName({ teamId, agentId });
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  const limit = Math.max(1, Math.min(maxFiles, MAX_FILES_HARD_CAP));
  const names = [base];
  for (let i = 1; i < limit; i++) names.push(`${stem}.${i}.jsonl`);
  return names
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

interface ScanResult {
  injections: InjectionRowLike[];
  recallSouls: RecallSoulRowLike[];
  truncated: boolean;
}

function scanJournalFiles(files: string[], fromMs: number): ScanResult {
  const injections: InjectionRowLike[] = [];
  const recallSouls: RecallSoulRowLike[] = [];
  let budget = MAX_BYTES;
  let lines = 0;
  let truncated = false;
  for (const file of files) {
    if (budget <= 0 || lines >= MAX_LINES) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      const size = fs.statSync(file).size;
      if (size > budget) {
        truncated = true;
        break;
      }
      text = fs.readFileSync(file, "utf8");
      budget -= size;
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      if (++lines > MAX_LINES) {
        truncated = true;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = (parsed as { ts?: unknown })?.ts;
      const tsMs = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs < fromMs) continue;
      const injection = asInjectionRow(parsed);
      if (injection) {
        injections.push(injection);
        continue;
      }
      const recall = asRecallSoulRow(parsed);
      if (recall) recallSouls.push(recall);
    }
  }
  return { injections, recallSouls, truncated };
}

function latestTs(rows: Array<{ ts: string }>): number {
  return rows.reduce((max, row) => Math.max(max, Date.parse(row.ts) || 0), 0);
}

/** 测试身份：`team-test` / `user-test` / `agent-test` / `usr-key` / `test-xxx`。 */
const TEST_IDENTITY_RE = /^(?:test-)|(?:-test$)|(?:-key$)/;

/**
 * v2：默认把测试身份的 journal 行挡在聚合之外。
 * 生产里 `team-test/*` 的 empty 行会掩盖真实故障（A4 复核），所以过滤是默认行为，
 * 且被挡掉的行数必须报出来——不能让「过滤」看起来像「没有」。
 */
export function isTestIdentity(...parts: Array<string | undefined>): boolean {
  return parts.some((part) => typeof part === "string" && part !== "" && TEST_IDENTITY_RE.test(part));
}

/** Round28（r28c-a4）：sectionCardHash* 是 proof 的内部载体，不能出现在响应里（Map 会序列化成 {}）。 */
type PublicPluginAgg = Omit<PluginFailureAgg, "sectionCardHashCount" | "sectionCardHashBySession">;

function publicPlugin(agg: PluginFailureAgg): PublicPluginAgg {
  const { sectionCardHashCount: _count, sectionCardHashBySession: _map, ...rest } = agg;
  return rest;
}

interface PluginFailureAgg {
  path: string;
  rows: number;
  cardBound: number;
  /** v7：绑定成功但注入 0 字符（无 identity/空段）——不计进 cardBound，避免「零字节成功」。 */
  cardBoundEmpty: number;
  /** Round20：插件报的 card-empty（空卡）——与 card-bound chars=0 同归 cardBoundEmpty 桶。 */
  cardEmpty: number;
  /** Round20：带身份但不是计账事件（turn-append / bind-probe / card-inherited / turn-skip）的行，单列，不进 rows。 */
  otherRows: number;
  /**
   * Round26：会话开始时用户选了「本次不关联」（card-cleared）的清卡行。
   * 这是用户的决定，不是注入故障——既不进 rows，也不进 cardBoundEmpty，单列出来才不会被
   * 当成「拿不到卡」。这些行天然没有 identity，所以只给集群级读数。
   */
  unassociated: number;
  /** Round26（r26e-a1）：同一 event 的另一半——身份没配上的清卡，与「用户拒绝」分开计。 */
  unconfigured: number;
  cardBoundFailed: number;
  byReason: Record<PluginFailReason, number>;
  lastFailureAt: string | null;
  lastFailure: { reason: string; identity?: string; keptVersion?: number; sessionId?: string } | null;
  excludedTestRows: number;
  /** Round30：本次查询是否要求「把测试身份行取回」。默认 false——测试行不进任何租户计数。 */
  includeTest: boolean;
  /** Round30：includeTest=1 时被取回的测试身份行（独立桶，永不进租户 rows / unattributed）。 */
  testRows: {
    rows: number;
    sectionRead: number;
    cardBound: number;
    cardBoundEmpty: number;
    cardBoundFailed: number;
    cleared: number;
    otherRows: number;
  };
  /** v7：没有 identity 三元组的旧行——不归属任何租户，单独计数而不是摊到每个租户。 */
  noIdentityRows: number;
  /** v8（A4 Round7 CP5）：**本租户**的 section-read 总量与「本就没东西可注入」的分因计数。 */
  sectionRead: number;
  sectionReadNoCard: number;
  sectionReadEmptySegment: number;
  sectionReadNoSession: number;
  /**
   * v9（A5 Round10 P0）：没有 identity、无法归属租户的 section-read 行。
   * 只在这里给出集群级读数，**绝不**摊进任何租户的 sectionRead*——否则任意租户
   * （甚至不存在的租户）都能读到全集群数字，面板会显示本租户从未发生的失败。
   */
  unattributed: {
    sectionRead: number;
    noCard: number;
    emptySegment: number;
    noSession: number;
    /** Round25：无身份行的绑定/失败计数与分因（集群级，绝不摊进任何租户）。 */
    cardBound: number;
    cardBoundEmpty: number;
    cardBoundFailed: number;
    byReason: Record<PluginFailReason, number>;
    lastFailureAt: string | null;
    /** Round26（r26e-a1）：没有身份的清卡行——集群级，绝不摊进任何租户。 */
    cleared: number;
    unconfiguredCleared: number;
    /** Round28（r28c-a4）：既不属上面任何一类、也没有身份的行。有了它，noIdentityRows 与各桶之和才是可断言的恒等式。 */
    other: number;
  };
  /** Round28：section-read 里带整卡 hash 的行数与按会话的 hash 集合（proof 用）。 */
  sectionCardHashCount: number;
  sectionCardHashBySession: Map<string, Set<string>>;
}

/**
 * 读插件侧证据日志（`persona-injection.jsonl` + `.1`）。
 *
 * 只认元数据：event / reason / identity / keptVersion / sessionId / ts。日志里没有正文，
 * 所以这里也不会把正文带进返回值。失败原因按四类归并，未知原因落 `other`（不丢）。
 * 租户过滤靠 identity 三元组（team/user/agent）：没有 identity 的旧行仍计入全局聚合。
 */
function readPluginInjectionLog(
  file: string,
  fromMs: number,
  scope: { teamId: string; userId?: string; agentId: string; includeTest: boolean },
): PluginFailureAgg {
  const agg: PluginFailureAgg = {
    path: file,
    rows: 0,
    cardBound: 0,
    cardBoundEmpty: 0,
    cardEmpty: 0,
    otherRows: 0,
    unassociated: 0,
    unconfigured: 0,
    cardBoundFailed: 0,
    byReason: { http_status: 0, timeout: 0, empty: 0, parse: 0, other: 0 },
    lastFailureAt: null,
    lastFailure: null,
    excludedTestRows: 0,
    includeTest: scope.includeTest,
    testRows: {
      rows: 0,
      sectionRead: 0,
      cardBound: 0,
      cardBoundEmpty: 0,
      cardBoundFailed: 0,
      cleared: 0,
      otherRows: 0,
    },
    noIdentityRows: 0,
    sectionRead: 0,
    sectionReadNoCard: 0,
    sectionReadEmptySegment: 0,
    sectionReadNoSession: 0,
    unattributed: {
      sectionRead: 0,
      noCard: 0,
      emptySegment: 0,
      noSession: 0,
      cardBound: 0,
      cardBoundEmpty: 0,
      cardBoundFailed: 0,
      byReason: { http_status: 0, timeout: 0, empty: 0, parse: 0, other: 0 },
      lastFailureAt: null,
      cleared: 0,
      unconfiguredCleared: 0,
      other: 0,
    },
    sectionCardHashCount: 0,
    sectionCardHashBySession: new Map(),
  };
  if (file === "") return agg;
  const files = [file, `${file}.1`].filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  let budget = MAX_PLUGIN_BYTES;
  for (const current of files) {
    let text: string;
    try {
      const size = fs.statSync(current).size;
      if (size > budget) break;
      text = fs.readFileSync(current, "utf8");
      budget -= size;
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = (parsed ?? {}) as Record<string, unknown>;
      const ts = asString(ev.ts, 64);
      const tsMs = ts === undefined ? Number.NaN : Date.parse(ts);
      if (!Number.isFinite(tsMs) || tsMs < fromMs) continue;
      const identity = asString(ev.identity, 400);
      const sessionId = asString(ev.sessionId, 400);
      const parts = identity === undefined ? [] : identity.split("/");
      if (isTestIdentity(...parts)) {
        // 计数与过滤分开：includeTest 只决定「要不要算进聚合」，不改变「有多少测试行」这个事实。
        agg.excludedTestRows += 1;
        if (!scope.includeTest) continue;
        // Round30（r30b 自检）：查的租户自己就是测试身份时，测试行应当**当正常行**计账（否则
        // 「显式取回」永远只能取到别人的行，本人的测试租户反而恒 0）。
        const matchesTestScope =
          parts.length >= 3 && parts[0] === scope.teamId && parts[2] === scope.agentId &&
          (scope.userId === undefined || parts[1] === scope.userId);
        if (matchesTestScope) {
          // 交给下游的正常计账路径，不在这里 continue。
        } else {
        // 旧实现 includeTest=1 只是不 continue，随后仍被下面那道租户比较
        // （parts[0]!==teamId / parts[2]!==agentId）静默丢弃 ——「显式可取回」名不副实。
        // 现在测试行只落进独立的 testRows 桶：既不进租户 rows，也不进 unattributed，取回量可断言。
        const testEvent = asString(ev.event, 64);
        const testCounted =
          testEvent === "section-read" || testEvent === "card-bound" ||
          testEvent === "card-bound-failed" || testEvent === "card-empty";
        if (testCounted) agg.testRows.rows += 1;
        if (testEvent === "section-read") agg.testRows.sectionRead += 1;
        else if (testEvent === "card-bound") {
          const testChars = typeof ev.chars === "number" && Number.isFinite(ev.chars) ? ev.chars : 0;
          if (testChars > 0) agg.testRows.cardBound += 1;
          else agg.testRows.cardBoundEmpty += 1;
        } else if (testEvent === "card-bound-failed") agg.testRows.cardBoundFailed += 1;
        else if (testEvent === "card-cleared") agg.testRows.cleared += 1;
        else agg.testRows.otherRows += 1;
        continue;
        }
      }
      const sectionReason = asString(ev.reason, 64);
      const sectionSidNone = asString(ev.sidSource, 32) === "none";
      // Round26：清卡事件先记集群级事实（它通常没有 identity，走不到下面的租户分支）。
      const rawEventName = asString(ev.event, 64);
      // Round28（r28c-a4）：三元组必须是三个非空段。旧实现只查 parts.length < 3，
      // team//agent、team/user/ 这类缺段行会穿过租户比较，让任意客户端伪造「本租户」rows。
      // 缺段一律按「没有身份」处理，绝不摊进租户。
      if (parts.length < 3 || parts.slice(0, 3).some((part) => part === "")) {
        // 没有身份的行无法归属租户：计入 noIdentityRows 后跳过，
        // 否则同一批行会被算进每个 team 的指标（A4 复核：70 个无身份 session 污染所有租户）。
        agg.noIdentityRows += 1;
        // A5 Round10 P0：这些行确实存在（插件拿不到 identity），但不能消失，也不能算给某个租户。
        // 归到一个显式的集群级桶里，租户视角永远读不到不属于自己的数字。
        if (ev.event === "section-read") {
          agg.unattributed.sectionRead += 1;
          if (sectionReason === "no-card") agg.unattributed.noCard += 1;
          else if (sectionReason === "empty-segment") agg.unattributed.emptySegment += 1;
          else if (sectionSidNone) agg.unattributed.noSession += 1;
        }
        // Round25（判据6）：真实会话的失败行大多没有 identity。旧实现只把无身份 section-read 分因
        // 集群级报出来，card-bound-failed 一律沉进 noIdentityRows → 真租户的 byReason 恒为 0，
        // 「失败逐个归因」在面板上永远看不见。这里同样只给集群级读数，不摊进任何租户。
        if (ev.event === "card-bound") {
          const charsUn = typeof ev.chars === "number" && Number.isFinite(ev.chars) ? ev.chars : 0;
          if (charsUn > 0) agg.unattributed.cardBound += 1;
          else agg.unattributed.cardBoundEmpty += 1;
        }
        if (ev.event === "card-bound-failed") {
          agg.unattributed.cardBoundFailed += 1;
          const rawUn = asString(ev.reason, 64) ?? "other";
          const keyUn: PluginFailReason = (PLUGIN_FAIL_REASONS as readonly string[]).includes(rawUn)
            ? (rawUn as PluginFailReason)
            : "other";
          agg.unattributed.byReason[keyUn] += 1;
          const atUn = Date.parse(agg.unattributed.lastFailureAt ?? "") || 0;
          if (agg.unattributed.lastFailureAt === null || tsMs >= atUn) agg.unattributed.lastFailureAt = ts ?? null;
        }
        if (rawEventName === "card-cleared") {
          agg.unattributed.cleared += 1;
          if (asString(ev.reason, 64) === "unconfigured") agg.unattributed.unconfiguredCleared += 1;
        }
        // Round28（r28c-a4）：无身份行里有一批既不入桶也不解释（生产 1988 行），
        // 「noIdentityRows = 各桶之和」因此是假等式。显式归到 other，等式才可断言。
        if (
          rawEventName !== "section-read" &&
          rawEventName !== "card-bound" &&
          rawEventName !== "card-bound-failed" &&
          rawEventName !== "card-cleared"
        ) {
          agg.unattributed.other += 1;
        }
        continue;
      }
      if (parts[0] !== scope.teamId || parts[2] !== scope.agentId) continue;
      if (scope.userId !== undefined && parts[1] !== scope.userId) continue;
      // Round20（A4 复核）：rows 只数计账事件。历史上 rows 数所有带身份行，靠「只有 section-read 与
      // card-bound(-failed) 带 identity」这条偶然事实才等于下面四个桶之和；turn-append 等一旦带身份，
      // rowsIdentity 就被撑破。现在把非计账事件单列到 otherRows，等式恒成立。
      const eventName = asString(ev.event, 64);
      const countedEvent =
        eventName === "section-read" ||
        eventName === "card-bound" ||
        eventName === "card-bound-failed" ||
        eventName === "card-empty";
      if (countedEvent) agg.rows += 1;
      else agg.otherRows += 1;
      // v8/v9（A4 Round7 CP5 + A5 Round10）：section-read 分因计数只对本租户累加——
      // 放在租户过滤之后，才和 rows/cardBound 用同一个分母。
      // A4 Round24：桶判定一律用上面 trim 过的 eventName，避免「进了 rows 却没进任何桶」把恒等式打破。
      if (eventName === "section-read") {
        agg.sectionRead += 1;
        // Round28（r28c-a4）：段行记的是「这一段」的 sha256，而注入/快照记的是整卡 hash。
        // 两者天然不可比，所以段行额外带 cardHash（= 整卡 textHash）。proof 用它和同会话的
        // 绑定 hash 对齐，才可能真的证到「Core 渲染的这张卡被取走并注入」。
        const sectionCardHash = asString(ev.cardHash, 128);
        if (sectionCardHash !== undefined && /^[0-9a-f]{64}$/u.test(sectionCardHash) && sessionId !== undefined) {
          agg.sectionCardHashCount += 1;
          const bucket = agg.sectionCardHashBySession.get(sessionId) ?? new Set<string>();
          bucket.add(sectionCardHash);
          agg.sectionCardHashBySession.set(sessionId, bucket);
        }
        if (sectionReason === "no-card") agg.sectionReadNoCard += 1;
        else if (sectionReason === "empty-segment") agg.sectionReadEmptySegment += 1;
        else if (sectionSidNone) agg.sectionReadNoSession += 1;
      }
      if (eventName === "card-bound") {
        // 零字节绑定不是成功：单独一桶，cardBound 只数真的注入了字符的绑定。
        const chars = typeof ev.chars === "number" && Number.isFinite(ev.chars) ? ev.chars : 0;
        if (chars > 0) agg.cardBound += 1;
        else agg.cardBoundEmpty += 1;
      }
      if (eventName === "card-empty") {
        // Round28（r28c-a4）：原来同时 +cardEmpty 与 +cardBoundEmpty，四桶和比 rows 多出
        // cardEmpty 条，等式只是「生产恰好 cardEmpty=0」的幸存巧合。空卡不是零字节绑定，
        // 只进 cardEmpty。恒等式是五桶：rows = sectionRead + cardBound + cardBoundEmpty + cardEmpty + cardBoundFailed。
        agg.cardEmpty += 1;
      }
      // Round26（r26e-a1）：带身份的清卡只算本租户，并按 reason 分开。
      if (eventName === "card-cleared") {
        if (asString(ev.reason, 64) === "unconfigured") agg.unconfigured += 1;
        else agg.unassociated += 1;
      }
      if (eventName !== "card-bound-failed") continue;
      agg.cardBoundFailed += 1;
      const rawReason = asString(ev.reason, 64) ?? "other";
      const key: PluginFailReason = (PLUGIN_FAIL_REASONS as readonly string[]).includes(rawReason)
        ? (rawReason as PluginFailReason)
        : "other";
      agg.byReason[key] += 1;
      const at = Date.parse(agg.lastFailureAt ?? "") || 0;
      if (agg.lastFailureAt === null || tsMs >= at) {
        const keptVersion = typeof ev.keptVersion === "number" && Number.isFinite(ev.keptVersion)
          ? Math.floor(ev.keptVersion)
          : undefined;
        // Round25：failStatus 原来解析后就被丢掉，「http_status 失败」看不出是 429 还是 500。
        const failStatus = typeof ev.failStatus === "number" && Number.isFinite(ev.failStatus)
          ? Math.floor(ev.failStatus)
          : undefined;
        agg.lastFailureAt = ts ?? null;
        agg.lastFailure = {
          reason: rawReason,
          ...(failStatus !== undefined ? { status: failStatus } : {}),
          ...(identity !== undefined ? { identity } : {}),
          ...(keptVersion !== undefined ? { keptVersion } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        };
      }
    }
  }
  return agg;
}

export interface SoulInjectionStats {
  window: { hours: number; from: string; to: string };
  rows: number;
  lastAt: string | null;
  /** Round30（r30a-a4）：chars = 插件实际注入的字符数（identity+anchor 两段之和），**不是**卡字数；
   * 同一张卡对照 GET /v3/soul/card 时，card.chars（整卡）与 lastCard.chars 恒不相等，别当不一致报警。 */
  lastCard: { version: number; textHash: string; chars: number } | null;
  lastVolatile: { chars: number; hash: string; skipped: boolean } | null;
  /**
   * 窗口内每轮块的去重统计（P0-D）：injected=真正追加进上下文，skipped=近 3 轮同文本被插件跳过。
   * 面板「去重跳过 N 次」直接读这里——`lastVolatile.skipped` 只是最后一次的布尔，给不出 N。
   */
  volatileCounts: { injected: number; skipped: number };
  failReasons: Record<FailReason, number> | null;
  serverRenderOnly: number;
  pairs: { matched: number; charMismatch: number };
  /** 对账档位（A3）：turn（同轮次）→ hash（卡文本 SHA-256 相等）→ chars（只比长度）。 */
  pairStrategy: "turn" | "hash" | "chars";
  /**
   * 卡/尾巴对账辅助计数（A3；A5 复核修正口径）——proof **不是**段级/端到端交付证据。
   * Core 不持有卡文本，不硬判「内容相等」。
   * sectionReadCount = 携带非空 card.hash 的注入行数（八位十六进制也算，不是段级）。
   * textHashMatched = 同会话中 card.hash 与召回 sessionInit.hash 逐字相等的行数；
   * 两者定义不同（卡 hash=sha256(整卡 text)，召回 hash=sha256(material)），生产应为 0。
   * 段级交付证据只能拿插件 section-read.hash 比 GET /v3/soul/card 的 identity/anchor.hash。
   */
  /** Round28：sectionCardHashCount = 带整卡 hash 的 section-read 行数（跨会话累计）。 */
  proof: { sectionReadCount: number; textHashMatched: number; sessionsWithProof: number; sectionCardHashCount: number };
  /** v2：被测试身份过滤掉的 journal 行数（includeTest=true 时仍报真实被跳过的量）。 */
  excluded: { testRows: number };
  /** v2：插件证据日志的 card-bound-failed 聚合（journal 关闭时也照读）。 */
  plugin: {
    path: string;
    rows: number;
    cardBound: number;
    /** v7：绑定成功但 0 字符（无 identity/空段）。Round20 起也含 card-empty。 */
    cardBoundEmpty: number;
    /** Round20：插件报的 card-empty（空卡），与 cardBoundEmpty 分开计但都算零字节。 */
    cardEmpty: number;
    /** Round20：带身份但不是计账事件的行（turn-append 等），不进 rows。 */
    otherRows: number;
    /** Round26：用户主动「本次不关联」的清卡行（card-cleared）。集群级；不进 rows/cardBoundEmpty。 */
    unassociated: number;
    /** Round26（r26e-a1）：清卡的另一半——身份没配上，不是用户的决定。 */
    unconfigured: number;
    /** v7：无 identity 三元组、无法归属租户的行数。 */
    noIdentityRows: number;
    /** v8（A4 Round7 CP5）：**本租户**的 section-read 总量；下面三列是「本就没东西可注入」的分因计数。 */
    sectionRead: number;
    sectionReadNoCard: number;
    sectionReadEmptySegment: number;
    sectionReadNoSession: number;
    /** v9（A5 Round10 P0）：无 identity、无法归属租户的 section-read 行（集群级，不计入租户指标）。 */
    /** Round25：同一桶再补 card-bound-failed 计数与分因 + 最后一次失败时刻（判据6 的失败归因入口）。 */
    unattributed: {
      sectionRead: number;
      noCard: number;
      emptySegment: number;
      noSession: number;
      cardBound: number;
      cardBoundEmpty: number;
      cardBoundFailed: number;
      byReason: Record<PluginFailReason, number>;
      lastFailureAt: string | null;
      /** Round26（r26e-a1）：无身份的清卡（集群级）。 */
      cleared: number;
      unconfiguredCleared: number;
      /** Round28（r28c-a4）：无身份且不属任何已知类别的行——让恒等式有落点。 */
      other: number;
    };
    cardBoundFailed: number;
    byReason: Record<PluginFailReason, number>;
    lastFailureAt: string | null;
    lastFailure: { reason: string; identity?: string; keptVersion?: number; sessionId?: string; status?: number } | null;
    excludedTestRows: number;
    /** Round30：默认 false；includeTest=1 时下面 testRows 才有数。 */
    includeTest: boolean;
    /** Round30：被排除且（includeTest=1 时）可取回的测试身份行。 */
    testRows: {
      rows: number;
      sectionRead: number;
      cardBound: number;
      cardBoundEmpty: number;
      cardBoundFailed: number;
      cleared: number;
      otherRows: number;
    };
  };
  /**
   * v3（Round5）：回复侧写照聚合。usage 行是插件回合结束后补报的词面重合探针
   * （人格原文行被助手输出以 4-gram 覆盖 ≥50% 的行数 / 人格行数），
   * 只回答「注入了却完全没人用」的最坏情况，不证明因果。
   */
  usage: {
    rows: number;
    sessions: number;
    withOverlap: number;
    avgOverlapPct: number;
    maxOverlapPct: number;
    lastAt: string | null;
  };
  note?: "journal_disabled";
}

function emptyStats(hours: number, from: string, to: string): SoulInjectionStats {
  return {
    window: { hours, from, to },
    rows: 0,
    lastAt: null,
    lastCard: null,
    lastVolatile: null,
    volatileCounts: { injected: 0, skipped: 0 },
    failReasons: null,
    serverRenderOnly: 0,
    pairs: { matched: 0, charMismatch: 0 },
    pairStrategy: "chars",
    proof: { sectionReadCount: 0, textHashMatched: 0, sessionsWithProof: 0, sectionCardHashCount: 0 },
    excluded: { testRows: 0 },
    usage: { rows: 0, sessions: 0, withOverlap: 0, avgOverlapPct: 0, maxOverlapPct: 0, lastAt: null },
    plugin: {
      path: "",
      rows: 0,
      cardBound: 0,
      cardBoundEmpty: 0,
      cardEmpty: 0,
      otherRows: 0,
      unassociated: 0,
      unconfigured: 0,
      noIdentityRows: 0,
      sectionRead: 0,
      sectionReadNoCard: 0,
      sectionReadEmptySegment: 0,
      sectionReadNoSession: 0,
      cardBoundFailed: 0,
      byReason: { http_status: 0, timeout: 0, empty: 0, parse: 0, other: 0 },
      lastFailureAt: null,
      lastFailure: null,
      excludedTestRows: 0,
      includeTest: false,
      testRows: {
        rows: 0,
        sectionRead: 0,
        cardBound: 0,
        cardBoundEmpty: 0,
        cardBoundFailed: 0,
        cleared: 0,
        otherRows: 0,
      },
      unattributed: {
        sectionRead: 0,
        noCard: 0,
        emptySegment: 0,
        noSession: 0,
        cardBound: 0,
        cardBoundEmpty: 0,
        cardBoundFailed: 0,
        byReason: { http_status: 0, timeout: 0, empty: 0, parse: 0, other: 0 },
        lastFailureAt: null,
        cleared: 0,
        unconfiguredCleared: 0,
        other: 0,
      },
    },
  };
}

export async function handleSoulInjectionStatsRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulInjectionStatsRouteDeps,
): Promise<boolean> {
  if (url.pathname !== SOUL_INJECTION_STATS_PATH) return false;
  if (method !== "GET") {
    sendJson(res, 405, { code: 405, message: "method_not_allowed" });
    return true;
  }
  const teamId = asString(url.searchParams.get("team"), 128);
  if (!teamId) {
    sendJson(res, 400, { code: 400, message: "missing_team" });
    return true;
  }
  const userId = asString(url.searchParams.get("user"), 128);
  const agentId = asString(url.searchParams.get("agent"), 128) ?? "default";
  // v2：默认排除测试身份；显式 includeTest=1 才捞回（面板/运维需要看「被过滤了多少」时仍读 excluded）。
  const includeTestRaw = url.searchParams.get("includeTest");
  const includeTest = includeTestRaw === "1" || includeTestRaw === "true";
  const hoursRaw = url.searchParams.get("hours");
  let hours = DEFAULT_WINDOW_HOURS;
  if (hoursRaw !== null && hoursRaw.trim() !== "") {
    const parsed = Number(hoursRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_WINDOW_HOURS) {
      sendJson(res, 400, { code: 400, message: "bad_hours" });
      return true;
    }
    hours = Math.floor(parsed);
  }

  const now = deps.now?.() ?? new Date();
  const fromDate = new Date(now.getTime() - hours * 3600 * 1000);
  const from = fromDate.toISOString();
  const to = now.toISOString();

  // 降级先判：journal 关掉时目录可能根本不存在，这不是 500。
  const dirExists = (() => {
    try {
      return fs.statSync(deps.journalDir).isDirectory();
    } catch {
      return false;
    }
  })();
  const pluginLogPath = deps.pluginLogPath ?? path.join(path.dirname(deps.journalDir), "persona-injection.jsonl");
  const plugin = readPluginInjectionLog(pluginLogPath, fromDate.getTime(), {
    teamId,
    ...(userId !== undefined ? { userId } : {}),
    agentId,
    includeTest,
  });
  if (!deps.journalOpts?.enabled || !dirExists) {
    sendJson(res, 200, { code: 0, data: { ...emptyStats(hours, from, to), plugin: publicPlugin(plugin), note: "journal_disabled" } });
    return true;
  }

  try {
    const maxFiles =
      Number.isFinite(deps.journalOpts.maxFiles) && deps.journalOpts.maxFiles > 0
        ? Math.floor(deps.journalOpts.maxFiles)
        : 5;
    const files = journalFilesOf(deps.journalDir, teamId, agentId, maxFiles);
    const scan = scanJournalFiles(files, fromDate.getTime());

    const matchesTenant = (row: { teamId?: string; userId?: string; agentId?: string }): boolean => {
      if (row.teamId !== undefined && row.teamId !== teamId) return false;
      if (row.agentId !== undefined && row.agentId !== agentId) return false;
      if (userId !== undefined && row.userId !== undefined && row.userId !== userId) return false;
      return true;
    };

    let excludedTestRows = 0;
    const keep = (row: { teamId?: string; userId?: string; agentId?: string }): boolean => {
      if (!matchesTenant(row)) return false;
      if (isTestIdentity(row.teamId, row.userId, row.agentId)) {
        excludedTestRows += 1;
        return includeTest;
      }
      return true;
    };
    const injectionsAll = scan.injections.filter(keep);
    // usage 写照行不是注入行：单独聚合，不参与 rows/pairs/serverRenderOnly（A4 复核 M1）。
    const injections = injectionsAll.filter(
      (row) =>
        !(
          row.usage !== undefined &&
          row.card === undefined &&
          row.volatile === undefined &&
          row.failReason === undefined
        ),
    );
    const usageRows = injectionsAll.filter((row) => row.usage !== undefined);
    const recallSouls = scan.recallSouls.filter(keep);

    const rows = injections.length;
    const withAnyRow = rows > 0;
    const lastRowTs = withAnyRow ? latestTs(injections) : 0;
    const lastAt = withAnyRow ? new Date(lastRowTs).toISOString() : null;

    const lastCardRow = injections.filter((row) => row.card !== undefined).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    const lastVolatileRow = injections
      .filter((row) => row.volatile !== undefined)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];

    // 每轮块的去重统计：插件被「近 3 轮同文本」跳过时报 skipped=true 且 chars=0，
    // 所以这里数的是**上报过的每一轮**，不是 journal 行数。
    const volatileRows = injections.filter((row) => row.volatile !== undefined);
    const volatileCounts = {
      injected: volatileRows.filter((row) => row.volatile!.skipped !== true).length,
      skipped: volatileRows.filter((row) => row.volatile!.skipped === true).length,
    };

    // 失败原因：只有真被上报过才能计数；一行都没有时报 null，别拿 0 冒充「没有失败」。
    const reportedFailures = injections.filter((row) => row.failReason !== undefined);
    const failReasons =
      reportedFailures.length === 0
        ? null
        : FAIL_REASONS.reduce(
            (acc, reason) => {
              acc[reason] = reportedFailures.filter((row) => row.failReason === reason).length;
              return acc;
            },
            { http_status: 0, timeout: 0, empty: 0, parse: 0, section_install_failed: 0 } as Record<FailReason, number>,
          );

    // sessionKey 级对账：召回行没有 turn 字段（见 RecallJournalEntry），所以只按会话比。
    const injectionBySession = new Map<string, InjectionRowLike[]>();
    for (const row of injections) {
      if (row.sessionKey === undefined) continue;
      const list = injectionBySession.get(row.sessionKey) ?? [];
      list.push(row);
      injectionBySession.set(row.sessionKey, list);
    }
    const recallBySession = new Map<string, RecallSoulRowLike[]>();
    for (const row of recallSouls) {
      if (row.sessionKey === undefined) continue;
      const list = recallBySession.get(row.sessionKey) ?? [];
      list.push(row);
      recallBySession.set(row.sessionKey, list);
    }

    let matched = 0;
    let charMismatch = 0;
    let sessionsByTurn = 0;
    let sessionsByHash = 0;
    for (const [sessionKey, recallRows] of recallBySession) {
      const injectionRows = injectionBySession.get(sessionKey);
      if (!injectionRows || injectionRows.length === 0) continue;
      matched += 1;
      // 档位判定顺序（A3）：turn → hash → chars。召回行今天没有 turn 字段，
      // 所以 turn 这一档是防御性的：等它真带上 turn，同轮次就能压过 hash。
      const rowTurns = injectionRows
        .map((row) => row.turn)
        .filter((turn): turn is number => typeof turn === "number");
      const recallTurns = recallRows
        .map((row) => (row as { turn?: unknown }).turn)
        .filter((turn): turn is number => typeof turn === "number");
      const injHashes = injectionRows
        .filter((row) => row.card !== undefined && row.card.hash !== "")
        .map((row) => row.card!.hash);
      const recallHashes = recallRows
        .map((row) => row.soul?.sessionInit?.hash)
        .filter((hash): hash is string => typeof hash === "string" && hash !== "");
      if (recallTurns.some((turn) => rowTurns.includes(turn))) {
        sessionsByTurn += 1;
      } else if (injHashes.some((hash) => recallHashes.includes(hash))) {
        sessionsByHash += 1;
      }
      // 只比尾巴：turnChars 与 volatile chars 两侧同定义；卡侧 chars 定义不同（见下），不参与。
      const recallTurnChars = recallRows
        .map((row) => row.soul?.turnChars)
        .filter((chars): chars is number => typeof chars === "number");
      const injVolatiles = injectionRows.filter((row) => row.volatile !== undefined).map((row) => row.volatile!);
      let mismatch = false;
      // 卡侧 chars 不可比：注入行的 card.chars = identity+anchor 两段之和（插件只交两段），
      // 召回行的 sessionInit.chars = 整卡（含卡尾注释与未注入块）。把两套定义直接比大小，
      // 会让每个会话都被判成 charMismatch（A5 复核）。只有尾巴（volatile chars vs turnChars）
      // 两侧同定义，才参与对账；卡侧不参与 chars 对账，另由 proof 单独计数（proof 不是段级/端到端证据）。
      if (recallTurnChars.length > 0 && injVolatiles.length > 0) {
        const volChars = injVolatiles[injVolatiles.length - 1]!.chars;
        if (recallTurnChars.some((chars) => chars !== volChars)) mismatch = true;
      }
      if (mismatch) charMismatch += 1;
    }
    const pairStrategy: SoulInjectionStats["pairStrategy"] =
      sessionsByTurn > 0 ? "turn" : sessionsByHash > 0 ? "hash" : "chars";
    // 辅助计数面：有 card.hash 的行才计入 proof（非段级证据）；64 hex 本身不等于交付证明。
    // 旧行（无 hash / 8 hex）只落进 sectionReadCount，不报错、不进 textHashMatched。
    // 只把「同一会话里 card.hash 与 recall sessionInit.hash 逐字相等」的行记成 textHashMatched：
    // 卡 hash = sha256(整卡 text)、召回 hash = sha256(material)，天然不同，64 hex 本身不是证据（A4 复核）。
    const cardRows = injections.filter((row) => row.card !== undefined && row.card.hash !== "");
    const proofSessions = new Set<string>();
    let textHashMatched = 0;
    // Round28（r28c-a4）：旧证明拿「插件报的整卡 hash」比「召回行的 sessionInit.hash」，
    // 两者分别是 sha256(整卡) 与 sha256(实际注入的 material)，定义不同，结构性永不相等——
    // 于是唯一声称端到端的那一栏恒 0，注释还写着「相等即证明进提示词」。现在改成同定义对账：
    // 段行自带的整卡 cardHash 必须等于同会话绑定行的 card.hash（都来自同一张卡的 textHash）。
    for (const row of cardRows) {
      if (row.sessionKey === undefined) continue;
      const sectionHashes = plugin.sectionCardHashBySession.get(row.sessionKey);
      if (sectionHashes === undefined || !sectionHashes.has(row.card!.hash)) continue;
      textHashMatched += 1;
      proofSessions.add(row.sessionKey);
    }
    const proof = {
      sectionReadCount: cardRows.length,
      textHashMatched,
      sectionCardHashCount: plugin.sectionCardHashCount,
      sessionsWithProof: proofSessions.size,
    };
    // 没有注入行的会话本来就落在 serverRenderOnly 里，不重复计。
    const serverRenderOnly = recallSouls.filter(
      (row) => row.sessionKey === undefined || !injectionBySession.has(row.sessionKey),
    ).length;
    if (scan.truncated) {
      deps.logger?.warn?.("[soul-injection-stats] journal scan truncated (size/line cap); counts are a lower bound");
    }

    const usageSessions = new Set(usageRows.map((row) => row.sessionKey ?? ""));
    usageSessions.delete("");
    const overlapValues = usageRows.map((row) => row.usage!.overlapPct);
    const usage = {
      rows: usageRows.length,
      sessions: usageSessions.size,
      withOverlap: usageRows.filter((row) => row.usage!.matchedLines > 0).length,
      avgOverlapPct:
        overlapValues.length === 0
          ? 0
          : Math.round((overlapValues.reduce((sum, value) => sum + value, 0) / overlapValues.length) * 10) / 10,
      maxOverlapPct: overlapValues.length === 0 ? 0 : Math.max(...overlapValues),
      lastAt: usageRows.length === 0 ? null : new Date(latestTs(usageRows)).toISOString(),
    };

    const data: SoulInjectionStats = {
      window: { hours, from, to },
      rows,
      lastAt,
      // R29：改名 textHash —— 插件记的是 sha256(卡正文)，而 GET /v3/soul/card 的 hash 是
      // material hash，同名不同义（r28e-a4 就此踩过一次）。
      lastCard: lastCardRow?.card
        ? { version: Number(lastCardRow.card.version), textHash: String(lastCardRow.card.hash), chars: Number(lastCardRow.card.chars) }
        : null,
      lastVolatile: lastVolatileRow?.volatile ? { ...lastVolatileRow.volatile } : null,
      volatileCounts,
      failReasons,
      serverRenderOnly,
      pairs: { matched, charMismatch },
      pairStrategy,
      proof,
      excluded: { testRows: excludedTestRows },
      plugin: publicPlugin(plugin),
      usage,
    };
    sendJson(res, 200, { code: 0, data });
    return true;
  } catch (err) {
    // 聚合失败不冒充 0：显式 500，免得健康面把「读不出来」显示成「一切正常」。
    deps.logger?.warn?.(
      `[soul-injection-stats] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 500, { code: 500, message: "soul_injection_stats_failed" });
    return true;
  }
}
