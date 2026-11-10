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
 *   - `failReasons`：注入行带 `failReason` 时按四类计数；**窗口内没有任何行上报过失败信息**
 *     时为 null——因为「没上报」与「没有失败」在数据上不可分辨。
 *   - `serverRenderOnly`：窗口内有 soul 观测、但该 sessionKey 没有任何注入行回传的召回行数
 *     （= 这些轮次只有 Core 侧估算，插件没回报）。
 *   - `pairs.matched`：同时有召回 soul 行与注入行的 sessionKey 数；
 *     `pairs.charMismatch`：这些会话里，可比的（卡 chars / turnChars）至少一处不等的会话数。
 *     注意召回行没有 turn 字段，对账单位是 sessionKey（见 recall-journal.ts 的行结构）。
 *
 * 降级：journal 关闭或目录不存在 → 200 + 全零 + `note:"journal_disabled"`（不 500）。
 * 参数：`team` 必填（缺 → 400 missing_team）；`user` 可选过滤；`agent` 缺省 `default`
 * （与 recallJournalFileName 的兜底一致）；`hours` 缺省 24、必须 1..8760（非法 → 400 bad_hours）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { RecallJournalOpts } from "../core/recall/recall-journal.js";
import { recallJournalFileName } from "../core/recall/recall-journal.js";

export const SOUL_INJECTION_STATS_PATH = "/v3/soul/injection/stats";

/** 与注入端点的四类失败原因同名（插件侧 warn 的分类）。 */
const FAIL_REASONS = ["http_status", "timeout", "empty", "parse"] as const;
type FailReason = (typeof FAIL_REASONS)[number];

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 365;
/** 轮转文件最多看 maxFiles 个；再多就是历史考古，不是健康面。 */
const MAX_FILES_HARD_CAP = 8;
/** 单次请求的读取预算：生产 5MB×5/租户，留足余量又不至于把内存打爆。 */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINES = 300_000;

export interface SoulInjectionStatsRouteDeps {
  /** 与 auto-recall / 注入端点同源：`<dataDir>/logs/recall`。 */
  journalDir: string;
  journalOpts: RecallJournalOpts;
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
    ...(typeof v.failReason === "string" && (FAIL_REASONS as readonly string[]).includes(v.failReason)
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

export interface SoulInjectionStats {
  window: { hours: number; from: string; to: string };
  rows: number;
  lastAt: string | null;
  lastCard: { version: number; hash: string; chars: number } | null;
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
   * 端到端证据（A3）。Core 不持有卡文本，所以不硬判「内容相等」：这里只统计
   * 携带 card.hash 的注入行、其中已是 SHA-256 口径（可与 GET /v3/soul/card 的
   * textHash 对账）的行数，以及被这些行覆盖的会话数。相等性由外部拿两个 hash 比。
   */
  proof: { sectionReadCount: number; textHashMatched: number; sessionsWithProof: number };
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
    proof: { sectionReadCount: 0, textHashMatched: 0, sessionsWithProof: 0 },
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
  if (!deps.journalOpts?.enabled || !dirExists) {
    sendJson(res, 200, { code: 0, data: { ...emptyStats(hours, from, to), note: "journal_disabled" } });
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

    const injections = scan.injections.filter(matchesTenant);
    const recallSouls = scan.recallSouls.filter(matchesTenant);

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
            { http_status: 0, timeout: 0, empty: 0, parse: 0 } as Record<FailReason, number>,
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
      // 可比才算：卡 chars 比卡 chars，turnChars 比 volatile chars；任一处不等就算这一会话对不上。
      const recallInit = recallRows
        .map((row) => row.soul?.sessionInit)
        .filter((init): init is { version: number; hash: string; chars: number } => init !== undefined);
      const recallTurnChars = recallRows
        .map((row) => row.soul?.turnChars)
        .filter((chars): chars is number => typeof chars === "number");
      const injCards = injectionRows.filter((row) => row.card !== undefined).map((row) => row.card!);
      const injVolatiles = injectionRows.filter((row) => row.volatile !== undefined).map((row) => row.volatile!);
      let mismatch = false;
      if (recallInit.length > 0 && injCards.length > 0) {
        const cardChars = injCards[injCards.length - 1]!.chars;
        if (recallInit.some((init) => init.chars !== cardChars)) mismatch = true;
      }
      if (recallTurnChars.length > 0 && injVolatiles.length > 0) {
        const volChars = injVolatiles[injVolatiles.length - 1]!.chars;
        if (recallTurnChars.some((chars) => chars !== volChars)) mismatch = true;
      }
      if (mismatch) charMismatch += 1;
    }
    const pairStrategy: SoulInjectionStats["pairStrategy"] =
      sessionsByTurn > 0 ? "turn" : sessionsByHash > 0 ? "hash" : "chars";
    // 证据面：有 card.hash 的行才算 section-read 证据；其中 64 hex 的可与 GET textHash 对账。
    // 旧行（无 hash / 8 hex）只落进 sectionReadCount，不报错、不进 textHashMatched。
    const cardRows = injections.filter((row) => row.card !== undefined && row.card.hash !== "");
    const shaRows = cardRows.filter((row) => /^[0-9a-f]{64}$/i.test(row.card!.hash));
    const proofSessions = new Set<string>();
    for (const row of shaRows) {
      if (row.sessionKey !== undefined) proofSessions.add(row.sessionKey);
    }
    const proof = {
      sectionReadCount: cardRows.length,
      textHashMatched: shaRows.length,
      sessionsWithProof: proofSessions.size,
    };
    // 没有注入行的会话本来就落在 serverRenderOnly 里，不重复计。
    const serverRenderOnly = recallSouls.filter(
      (row) => row.sessionKey === undefined || !injectionBySession.has(row.sessionKey),
    ).length;
    if (scan.truncated) {
      deps.logger?.warn?.("[soul-injection-stats] journal scan truncated (size/line cap); counts are a lower bound");
    }

    const data: SoulInjectionStats = {
      window: { hours, from, to },
      rows,
      lastAt,
      lastCard: lastCardRow?.card ? { ...lastCardRow.card } : null,
      lastVolatile: lastVolatileRow?.volatile ? { ...lastVolatileRow.volatile } : null,
      volatileCounts,
      failReasons,
      serverRenderOnly,
      pairs: { matched, charMismatch },
      pairStrategy,
      proof,
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
