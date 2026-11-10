/**
 * /api/v1/chat-memory/soul-versions —— 灵魂快照「版本链 / 漂移审计」读面（task-3，缺口 A 二期）。
 *
 * 为什么单独一个路由文件而不是塞进 chat-memory.ts：
 *   chat-memory.ts 覆盖的是 chat_memory 资产族的 12 个业务动作；灵魂快照链是**运维审计**
 *   读面（只读、无资产授权语义），与资产 CRUD 的关注点不同。按「一个关注点一个文件」
 *   拆出来，也避免继续堆大单文件。
 *
 * 上游：POST 内核 /v3/soul/introspect（MemoryCore/src/gateway/soul-introspect-endpoint.ts:33，
 *   零写入合同：内部强制 snapshotsEnabled=false，不产生新快照）。
 *
 * tenant 轴（按 owner scope，禁跨用户读）：
 *   - teamId ← body.team_id（必填；门控 = caller 必须是该团队成员）
 *   - userId ← **Header 反查出的 caller**，body 里的 userId/user_id 一律忽略（防越权读别人的轴）
 *   - agentId ← body.agent_id（可选；缺省交给内核回落 "default"）
 *
 * 出参收窄（不透传 payload_json —— 那是整段人设原文，面板只需要"变了什么"的摘要）：
 *   { teamId, agentId, userId, soulVersion?, rendered?(≤4000 字，超长截断并在 notes 注明),
 *     renderedTruncated, versions:[{ at, hash, trigger, version?, parentHash?, reasonCode?,
 *     reasonDetail?, lineDiff?, slotDiff? }], notes[] }
 *
 * 旧快照降级：生产库（2026-11-04）soul_snapshots 仍是 ALTER 之前的形态（无 version /
 * parent_hash / reason_detail / slots_json 列，trigger 恒 'render'），内核因此只回
 * { ts, content_hash, trigger }。本路由**不补造**版本号/父子链/原因——缺什么就不出现什么，
 * 由前端按「旧快照」徽标降级呈现（禁编造序号）。
 *
 * 错误口径：400 MISSING_TEAM_ID / 401 INVALID_USER_KEY / 403 NOT_TEAM_MEMBER /
 *   502 UPSTREAM_ERROR / 504 UPSTREAM_TIMEOUT；内核业务码（如 503 soul_introspect_failed）
 *   原样透出并保留后端 message。
 *
 * 同文件第二个读面（2026-11-07）：GET /api/v1/chat-memory/soul-card —— 人格卡只读视图。
 *   上游 Core GET /v3/soul/card（MemoryCore/src/gateway/soul-card-endpoint.ts:40），
 *   纯读（persist:false，零写入、不产生快照）。team/user/agent 三个 query 轴透传，
 *   空/缺省填 "default"（与内核 tenantOf 同口径）；卡文本原样返回，BFF 不改写不截断。
 *   错误口径：Core checkAuth 的 401/403 是纯文本响应，GET 通道按原码透出
 *   （transport-fetch.ts 只对 GET 做这一层辨认）；503 soul_card_unavailable /
 *   soul_card_failed 保留后端 message，不折成 500/502。
 *
 * 同文件第三个读面（2026-11-07，spec §5 表单两栏）：GET /api/v1/chat-memory/soul-trait-state ——
 *   「你设定的 / 它现在」特质两栏。上游 Core GET /v3/soul/trait-state
 *   （MemoryCore/src/gateway/soul-card-endpoint.ts:94），纯读。**上游回裸对象**
 *   （200 {agentId,updatedAt,traits[]}、503 {error}），没有 {code,message,data} 信封，
 *   所以走 kernelHttp.getRaw（transport-fetch.ts executeMetaGetRaw）而不是 getEnvelope：
 *   后者会把裸 200 判成 invalid envelope、把 503 折成 502。
 *   BFF **不编造数值**：只做字段收窄（缺 label 或权重非有限数即丢行），
 *   seedWeight/nowWeight 原样转发，updatedAt 为 null 就回 null（前端据此显示「还没长出来」）。
 *   错误口径：401/403 原码 + 上游文本；503 soul_trait_state_unavailable /
 *   soul_trait_state_failed 原码 + 原 message；网络/超时 502 UPSTREAM_ERROR / 504 UPSTREAM_TIMEOUT。
 */
import type { Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import { toKernelCredentials } from "../../kernel/types.js";
import { KernelFetchError, type RawMetaResponse } from "../../kernel/transport-fetch.js";
import {
  buildCtx,
  okEnvelope,
  readJson,
  requireTeamMember,
  str,
} from "./knowledge/common.js";

/** rendered 全文上限：面板只做"看一眼"，不搬运整段人设（截断必注明）。 */
const RENDERED_LIMIT = 4000;
/** 快照条数夹取区间（与内核 clampInt(snapshotLimit, 1, 200, 20) 对齐）。 */
const SNAPSHOT_LIMIT_MIN = 1;
const SNAPSHOT_LIMIT_MAX = 200;
const SOUL_INTROSPECT_TIMEOUT_MS = 15_000;
const SOUL_INTROSPECT_PATH = "/v3/soul/introspect";

/** 人格卡只读上游（GET，query 走三轴；见文件头注释）。 */
const SOUL_CARD_TIMEOUT_MS = 15_000;
const SOUL_CARD_PATH = "/v3/soul/card";

/** 出参行（版本链一行）；可选字段只在真有值时才出现。 */
export interface SoulVersionRow {
  at: string;
  hash: string;
  trigger: string;
  version?: number;
  parentHash?: string | null;
  reasonCode?: string;
  reasonDetail?: string;
  lineDiff?: { added: number; removed: number };
  slotDiff?: { added: number; removed: number; changed: number; summary: string };
}

/** 内核 /v3/soul/introspect 的 data 形状（只列本文件消费的字段）。 */
interface KernelSoulIntrospectData {
  rendered?: unknown;
  soulVersion?: unknown;
  snapshots?: unknown;
  notes?: unknown;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function intOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
}

/** 单条快照 → 版本链行（payload_json 不在此列，永不外泄）。 */
function narrowSnapshot(raw: unknown): SoulVersionRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const at = nonEmptyString(r.ts);
  const hash = nonEmptyString(r.content_hash);
  if (!at || !hash) return null;

  const row: SoulVersionRow = {
    at,
    hash,
    trigger: nonEmptyString(r.trigger) ?? "",
  };
  // 仅当内核给了版本列（即运行中的 core 已执行幂等 ALTER）才带版本链字段；
  // 旧行一律缺席——UI 据此降级为「旧快照」，不编造序号。
  if (typeof r.version === "number" && Number.isFinite(r.version) && r.version > 0) {
    row.version = Math.floor(r.version);
  }
  if (r.parentHash === null) row.parentHash = null;
  else if (typeof r.parentHash === "string" && r.parentHash.length > 0) row.parentHash = r.parentHash;

  const reasonCode = nonEmptyString(r.reasonCode);
  if (reasonCode) row.reasonCode = reasonCode;
  const reasonDetail = nonEmptyString(r.reasonDetail);
  if (reasonDetail) row.reasonDetail = reasonDetail;

  if (r.diff && typeof r.diff === "object") {
    const d = r.diff as Record<string, unknown>;
    row.lineDiff = { added: intOr(d.addedLines, 0), removed: intOr(d.removedLines, 0) };
  }
  if (r.slotDiff && typeof r.slotDiff === "object") {
    const s = r.slotDiff as Record<string, unknown>;
    row.slotDiff = {
      added: intOr(s.added, 0),
      removed: intOr(s.removed, 0),
      changed: intOr(s.changed, 0),
      summary: nonEmptyString(s.summary) ?? "",
    };
  }
  return row;
}

function narrowNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** 卡的底色标签行（label 为中文特质名；act/gloss 由内核给）。 */
export interface SoulCardLabelRow {
  label: string;
  act: number;
  /** 仅前 2 个标签带 gloss（内核 CARD_GLOSS_TOP_N）。 */
  gloss?: string;
}

/** 与内核 tenantOf（soul-card-endpoint.ts:23）同口径：空/缺省 → "default"。 */
function tenantAxis(raw: string | undefined): string {
  const v = raw?.trim();
  return v && v.length > 0 ? v : "default";
}

/** 标签行的收窄：label+act 缺一即丢（不让半截行流到前端）。 */
function narrowCardLabels(raw: unknown): SoulCardLabelRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulCardLabelRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = nonEmptyString(r.label);
    const act = typeof r.act === "number" && Number.isFinite(r.act) ? r.act : undefined;
    if (!label || act === undefined) continue;
    const row: SoulCardLabelRow = { label, act };
    const gloss = nonEmptyString(r.gloss);
    if (gloss) row.gloss = gloss;
    rows.push(row);
  }
  return rows;
}

/** sources = {blockKey: "declared"|"derived"|"observed"}；只收非空字符串值。 */
function narrowCardSources(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/** 特质两栏上游（GET，裸对象，见文件头注释）。 */
const SOUL_TRAIT_STATE_TIMEOUT_MS = 15_000;
const SOUL_TRAIT_STATE_PATH = "/v3/soul/trait-state";

/** 特质两栏一行：设定值 / 现在值 / 是否已漂移（全部原样来自内核，不在此计算）。 */
export interface SoulTraitStateRow {
  label: string;
  /** 表单里设定的权重（0..1，两位小数）；表单没写为 0。 */
  seedWeight: number;
  /** 当前激活度（0..1，两位小数）；没有任何状态行时为 0。 */
  nowWeight: number;
  /** |now − 设定| 超过单 tick 上限；仅对表单出现过的标签为真。 */
  drifted: boolean;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 行收窄：label 缺失或权重不是有限数的行整行丢弃（不让半截行流到前端）。 */
function narrowTraitRows(raw: unknown): SoulTraitStateRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulTraitStateRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = nonEmptyString(r.label);
    const seedWeight = finiteOrNull(r.seedWeight);
    const nowWeight = finiteOrNull(r.nowWeight);
    if (!label || seedWeight === null || nowWeight === null) continue;
    rows.push({ label, seedWeight, nowWeight, drifted: r.drifted === true });
  }
  return rows;
}


/** 注入健康上游（GET，信封；见文件头注释）。 */
const SOUL_INJECTION_STATS_TIMEOUT_MS = 15_000;
const SOUL_INJECTION_STATS_PATH = "/v3/soul/injection/stats";
/** 窗口小时数的服务端口径：1..8760（与 Core MAX_WINDOW_HOURS 对齐）。 */
const STATS_HOURS_MIN = 1;
const STATS_HOURS_MAX = 8760;

export interface SoulInjectionStatsPayload {
  window: { hours: number; from: string; to: string };
  rows: number;
  lastAt: string | null;
  lastCard: { version: number; hash: string; chars: number } | null;
  lastVolatile: { chars: number; hash: string; skipped: boolean } | null;
  failReasons: { http_status: number; timeout: number; empty: number; parse: number } | null;
  serverRenderOnly: number;
  pairs: { matched: number; charMismatch: number };
  /**
   * 窗口内每轮块（volatile）计数：injected = 真追加进提示词，skipped = 因「近 3 轮同文本」
   * 被去重跳过。**可选**：旧 Core 不返回该字段——缺失即不出现在出参里，
   * 前端按「该字段无数据」处理（不补 0，避免把「没统计」说成「0 次去重」）。
   */
  volatileCounts?: { injected: number; skipped: number };
  note?: "journal_disabled";
}

/** 情绪明细上游（GET，信封；Core: MemoryCore/src/gateway/soul-emotions-endpoint.ts）。 */
const SOUL_EMOTIONS_TIMEOUT_MS = 15_000;
const SOUL_EMOTIONS_PATH = "/v3/soul/emotions";
/** 单页上限：Core 侧 limit ≤ 200，超出按 200 处理（与 Core 同口径）。 */
const EMOTIONS_LIMIT_MIN = 1;
const EMOTIONS_LIMIT_MAX = 200;

/** 漏斗六档：Core 埋点 code → 出参键。顺序即漏斗顺序（逐档收窄）。 */
const EMOTION_FUNNEL_CODES = [
  "emotion:candidate",
  "emotion:object_ok",
  "emotion:appraised",
  "emotion:anchor_hit",
  "emotion:intensity_ok",
  "emotion:committed",
] as const;
type EmotionFunnelCode = (typeof EMOTION_FUNNEL_CODES)[number];

/**
 * 情绪明细单行。**除 at 外全部可缺**：Core 的 agency/confidence/objectPerson 是
 * 阶段 3 才补的三列，旧行与旧 Core 都可能没有——缺就是 null，前端跳过那一段，
 * 不补默认值（补 0 会把「没算出来」说成「强度 0」）。
 */
export interface SoulEmotionRowPayload {
  at: string | null;
  object: string | null;
  objectPerson: string | null;
  label: string | null;
  valence: number | null;
  arousal: number | null;
  dominance: number | null;
  intensity: number | null;
  decayedIntensity: number | null;
  agency: string | null;
  confidence: number | null;
  templateVersion: string | null;
}

export interface SoulEmotionsPayload {
  rows: SoulEmotionRowPayload[];
  /** 漏斗六档计数；上游没给 funnel 时为 null（整段不渲染，不补 0） */
  funnel: Record<EmotionFunnelCode, number> | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
}

/** 小数保留原值（强度/置信度是 0..1 的浮点，不能像计数那样取整）。 */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 注入健康出参收窄：**算不出的字段一律回 null，不补 0**。
 * rows 缺省也有意义（0 行 = 窗口内没有注入），所以 rows 用 intOf ?? 0；
 * 但 lastAt / lastCard / lastVolatile / failReasons 缺字段即 null——
 * 「没有上报」与「上报了 0 次失败」是两件事（见 Core soul-injection-stats-endpoint.ts:349-359）。
 */
function narrowStats(data: Record<string, unknown>): SoulInjectionStatsPayload {
  const win = asRecord(data.window);
  const window = {
    hours: intOf(win.hours) ?? 0,
    from: strOrNull(win.from) ?? "",
    to: strOrNull(win.to) ?? "",
  };

  const card = asRecord(data.lastCard);
  const cardVersion = intOf(card.version);
  const cardHash = strOrNull(card.hash);
  const cardChars = intOf(card.chars);
  const lastCard =
    cardVersion === null || cardHash === null || cardChars === null
      ? null
      : { version: cardVersion, hash: cardHash, chars: cardChars };

  const vol = asRecord(data.lastVolatile);
  const volChars = intOf(vol.chars);
  const volHash = strOrNull(vol.hash);
  const lastVolatile =
    volChars === null || volHash === null
      ? null
      : { chars: volChars, hash: volHash, skipped: vol.skipped === true };

  const failRaw = data.failReasons;
  let failReasons: SoulInjectionStatsPayload["failReasons"] = null;
  if (failRaw && typeof failRaw === "object" && !Array.isArray(failRaw)) {
    const fr = failRaw as Record<string, unknown>;
    failReasons = {
      http_status: intOf(fr.http_status) ?? 0,
      timeout: intOf(fr.timeout) ?? 0,
      empty: intOf(fr.empty) ?? 0,
      parse: intOf(fr.parse) ?? 0,
    };
  }

  const pairs = asRecord(data.pairs);
  const out: SoulInjectionStatsPayload = {
    window,
    rows: intOf(data.rows) ?? 0,
    lastAt: strOrNull(data.lastAt),
    lastCard,
    lastVolatile,
    failReasons,
    serverRenderOnly: intOf(data.serverRenderOnly) ?? 0,
    pairs: {
      matched: intOf(pairs.matched) ?? 0,
      charMismatch: intOf(pairs.charMismatch) ?? 0,
    },
  };
  const vc = asRecord(data.volatileCounts);
  const injected = intOf(vc.injected);
  const volatileSkipped = intOf(vc.skipped);
  if (injected !== null && volatileSkipped !== null) {
    out.volatileCounts = { injected, skipped: volatileSkipped };
  }
  if (data.note === "journal_disabled") out.note = "journal_disabled";
  return out;
}

/**
 * 情绪明细出参收窄：**白名单制**——只放行 rows 里点名的字段，Core 以后加字段不会
 * 自动透到页面（那是产品决定，不是透传副产品）。行内缺字段一律 null，不补 0。
 * funnel 只有六档都在才算数；缺一档就整段 null（半份漏斗比没有更容易被误读）。
 */
function narrowEmotions(data: Record<string, unknown>): SoulEmotionsPayload {
  const rowsRaw = Array.isArray(data.rows) ? data.rows : [];
  const rows: SoulEmotionRowPayload[] = [];
  for (const item of rowsRaw) {
    const r = asRecord(item);
    // 完全空对象不是一条情绪，跳过（避免渲染出整行空白）。
    if (Object.keys(r).length === 0) continue;
    rows.push({
      at: strOrNull(r.at),
      object: strOrNull(r.object),
      objectPerson: strOrNull(r.objectPerson),
      label: strOrNull(r.label),
      valence: numOrNull(r.valence),
      arousal: numOrNull(r.arousal),
      dominance: numOrNull(r.dominance),
      intensity: numOrNull(r.intensity),
      decayedIntensity: numOrNull(r.decayedIntensity),
      agency: strOrNull(r.agency),
      confidence: numOrNull(r.confidence),
      templateVersion: strOrNull(r.templateVersion),
    });
  }

  const funnelRaw = data.funnel;
  let funnel: Record<EmotionFunnelCode, number> | null = null;
  if (funnelRaw && typeof funnelRaw === "object" && !Array.isArray(funnelRaw)) {
    const f = funnelRaw as Record<string, unknown>;
    const counts = EMOTION_FUNNEL_CODES.map((code) => intOf(f[code]));
    if (counts.every((n) => n !== null)) {
      funnel = Object.fromEntries(
        EMOTION_FUNNEL_CODES.map((code, i) => [code, counts[i] as number]),
      ) as Record<EmotionFunnelCode, number>;
    }
  }

  return { rows, funnel };
}

export function registerChatMemorySoulRoutes(api: Hono, deps: PanelDeps): void {
  api.post(
    "/chat-memory/soul-versions",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);

      const teamId = str(body, "team_id");
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
      const agentId = str(body, "agent_id") ?? undefined;

      // 门控 = caller 必须是该团队成员；caller 同时也是 tenant 的 userId 轴来源。
      const gated = await requireTeamMember(deps, c, ctx, teamId);
      if ("error" in gated) return gated.error;

      const rawLimit = body.snapshotLimit;
      const snapshotLimit =
        typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.max(SNAPSHOT_LIMIT_MIN, Math.min(SNAPSHOT_LIMIT_MAX, Math.floor(rawLimit)))
          : undefined;

      const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_INTROSPECT_TIMEOUT_MS });
      let env: MetaEnvelope<KernelSoulIntrospectData>;
      try {
        env = await deps.kernelHttp.postEnvelope<KernelSoulIntrospectData>(
          SOUL_INTROSPECT_PATH,
          {
            teamId,
            // tenant userId 轴只认 Header 反查出的 caller；body 的 userId/user_id 已在此被丢弃。
            userId: gated.userId,
            ...(agentId ? { agentId } : {}),
            ...(snapshotLimit !== undefined ? { snapshotLimit } : {}),
          },
          cred,
        );
      } catch (err) {
        deps.logger.warn("soul-versions upstream failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return respondControlError(c, 502, "UPSTREAM_ERROR");
      }

      if (env.code !== 0) {
        // 保留后端 message（如 503 soul_introspect_failed），不伪装成空版本链。
        const code = env.code >= 400 && env.code < 600 ? env.code : 502;
        return respondControlError(c, code, env.message || "SOUL_INTROSPECT_FAILED");
      }

      const data = (env.data ?? {}) as KernelSoulIntrospectData;
      const notes = narrowNotes(data.notes);

      let rendered = typeof data.rendered === "string" ? data.rendered : undefined;
      let renderedTruncated = false;
      if (rendered !== undefined && rendered.length > RENDERED_LIMIT) {
        const omitted = rendered.length - RENDERED_LIMIT;
        rendered = rendered.slice(0, RENDERED_LIMIT);
        renderedTruncated = true;
        notes.push(`rendered-truncated: omitted ${omitted} chars (limit ${RENDERED_LIMIT})`);
      }

      const versions: SoulVersionRow[] = [];
      if (Array.isArray(data.snapshots)) {
        for (const raw of data.snapshots) {
          const row = narrowSnapshot(raw);
          if (row) versions.push(row);
        }
      }

      return respondEnvelope(c, okEnvelope(c, {
        teamId,
        agentId: agentId ?? null,
        userId: gated.userId,
        ...(typeof data.soulVersion === "string" && data.soulVersion.length > 0
          ? { soulVersion: data.soulVersion }
          : {}),
        ...(rendered !== undefined ? { rendered } : {}),
        renderedTruncated,
        versions,
        notes,
      }));
    },
  );

  /**
   * GET /api/v1/chat-memory/soul-card —— 人格卡只读视图。
   *
   * 与 soul-versions 的差别：上游是 GET（三轴走 query），且卡文本**原样**返回
   * （不做 4000 字截断——卡本体自身受内核预算约束，截断会破坏 [读法] 段与区块结构）。
   * tenant 轴按内核 tenantOf 同口径缺省 "default"；本读面无资产授权语义，
   * 与 POST /soul-versions 的 team 成员门控无关（见文件头注释）。
   */
  api.get(
    "/chat-memory/soul-card",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const query = {
        team: tenantAxis(c.req.query("team")),
        user: tenantAxis(c.req.query("user")),
        agent: tenantAxis(c.req.query("agent")),
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_CARD_TIMEOUT_MS });
      let env: MetaEnvelope<Record<string, unknown>>;
      try {
        env = await deps.kernelHttp.getEnvelope<Record<string, unknown>>(
          SOUL_CARD_PATH,
          query,
          cred,
        );
      } catch (err) {
        deps.logger.warn("soul-card upstream failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return respondControlError(c, 502, "UPSTREAM_ERROR");
      }

      if (env.code !== 0) {
        // 401/403（纯文本鉴权失败）与 503 soul_card_* 都按原码 + 后端 message 透出。
        const code = env.code >= 400 && env.code < 600 ? env.code : 503;
        return respondControlError(c, code, env.message || "SOUL_CARD_FAILED");
      }

      const data = (env.data ?? {}) as Record<string, unknown>;
      if (typeof data.text !== "string") {
        // 契约要求 text 恒为字符串；缺失说明上游形态异常——不伪造空卡。
        deps.logger.warn("soul-card upstream returned no text");
        return respondControlError(c, 503, "soul_card_failed");
      }

      const text = data.text;
      return respondEnvelope(c, okEnvelope(c, {
        version:
          typeof data.version === "number" && Number.isFinite(data.version)
            ? Math.floor(data.version)
            : 0,
        hash: nonEmptyString(data.hash) ?? "",
        text,
        chars:
          typeof data.chars === "number" && Number.isFinite(data.chars)
            ? Math.floor(data.chars)
            : text.length,
        labels: narrowCardLabels(data.labels),
        warnings: narrowNotes(data.warnings),
        sources: narrowCardSources(data.sources),
        dirty: data.dirty === true,
        seeded: data.seeded === true,
      }));
    },
  );

  /**
   * GET /api/v1/chat-memory/soul-trait-state —— 表单「你设定的 / 它现在」两栏。
   *
   * 上游是裸对象（无信封），见文件头注释；三个轴与 soul-card 同口径（空→"default"）。
   * 200 只做收窄与透传：seedWeight/nowWeight/updatedAt **一律原样**，
   * 任何缺字段的行丢弃而不是补 0（补 0 会把「没有这一行」伪装成「设定为 0」）。
   */
  api.get(
    "/chat-memory/soul-trait-state",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const query = {
        team: tenantAxis(c.req.query("team")),
        user: tenantAxis(c.req.query("user")),
        agent: tenantAxis(c.req.query("agent")),
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_TRAIT_STATE_TIMEOUT_MS });
      let upstream: RawMetaResponse;
      try {
        upstream = await deps.kernelHttp.getRaw(SOUL_TRAIT_STATE_PATH, query, cred);
      } catch (err) {
        const timeout = err instanceof KernelFetchError && err.code === 504;
        deps.logger.warn("soul-trait-state upstream failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return timeout
          ? respondControlError(c, 504, "UPSTREAM_TIMEOUT")
          : respondControlError(c, 502, "UPSTREAM_ERROR");
      }

      const raw = upstream.body;
      const body =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};

      if (upstream.status < 200 || upstream.status >= 300) {
        // 401/403（鉴权）与 503 soul_trait_state_* 都按原码 + 上游原文透出，不折成 500/502。
        const message =
          nonEmptyString(body.error) ??
          nonEmptyString(body.message) ??
          (upstream.text.trim() || `soul_trait_state_failed (http ${upstream.status})`);
        const code =
          upstream.status >= 400 && upstream.status < 600 ? upstream.status : 503;
        return respondControlError(c, code, message);
      }

      // 成功路径兼容两种形态：裸对象（当前内核）与 {code:0,data} 包裹（若内核日后统一）。
      let payload: Record<string, unknown> = body;
      if (typeof body.code === "number") {
        if (body.code !== 0) {
          const code = body.code >= 400 && body.code < 600 ? body.code : 503;
          return respondControlError(
            c,
            code,
            nonEmptyString(body.message) ?? "soul_trait_state_failed",
          );
        }
        payload =
          body.data && typeof body.data === "object" && !Array.isArray(body.data)
            ? (body.data as Record<string, unknown>)
            : {};
      }
      if (!Array.isArray(payload.traits)) {
        // 契约要求 traits 恒为数组；缺失说明上游形态异常——不伪造空两栏。
        deps.logger.warn("soul-trait-state upstream returned no traits");
        return respondControlError(c, 503, "soul_trait_state_failed");
      }

      return respondEnvelope(c, okEnvelope(c, {
        agentId: nonEmptyString(payload.agentId) ?? query.agent,
        updatedAt: nonEmptyString(payload.updatedAt) ?? null,
        traits: narrowTraitRows(payload.traits),
      }));
    },
  );

  /**
   * GET /api/v1/soul/injection-stats —— 「注入健康」只读条（P0-D，task-17）。
   *
   * 上游 Core GET /v3/soul/injection/stats（MemoryCore/src/gateway/soul-injection-stats-endpoint.ts:30），
   * 纯读：统计 recall-journal 里近 N 小时真正**注入**了多少轮、最近一次注入的卡/volatile 体积、
   * 以及宿主上报的失败原因计数。team 必填（缺参给 400，不伪造 "default" 轴——
   * 拿错团队的统计比没有更糟）；user/agent 与 soul-card 同口径（空 → "default"）。
   *
   * 三态判定交给前端，BFF 不改写语义：note==='journal_disabled' 或 rows===0 = 无数据；
   * failReasons 非 null 且任一计数 > 0 = 降级；其余为正常。
   * failReasons 为 null 表示「窗口内没有任何失败上报」，**不是**「0 次失败」——
   * 生产当前恒 null（插件失败只 warn 未回传），所以原样回 null 由前端说「暂无失败上报」。
   */
  api.get(
    "/soul/injection-stats",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);

      const team = c.req.query("team")?.trim();
      if (!team) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const query: Record<string, string> = {
        team,
        user: tenantAxis(c.req.query("user")),
        agent: tenantAxis(c.req.query("agent")),
      };
      const hoursRaw = c.req.query("hours")?.trim();
      if (hoursRaw && hoursRaw.length > 0) {
        const hours = Number(hoursRaw);
        // 不合法就 400 而不是悄悄回落 24：拿错窗口会让「无数据」的结论失真。
        if (
          !Number.isFinite(hours) ||
          hours < STATS_HOURS_MIN ||
          hours > STATS_HOURS_MAX
        ) {
          return respondControlError(c, 400, "BAD_HOURS");
        }
        query.hours = String(Math.floor(hours));
      }

      const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_INJECTION_STATS_TIMEOUT_MS });
      let env: MetaEnvelope<Record<string, unknown>>;
      try {
        env = await deps.kernelHttp.getEnvelope<Record<string, unknown>>(
          SOUL_INJECTION_STATS_PATH,
          query,
          cred,
        );
      } catch (err) {
        const timeout = err instanceof KernelFetchError && err.code === 504;
        deps.logger.warn("soul-injection-stats upstream failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return timeout
          ? respondControlError(c, 504, "UPSTREAM_TIMEOUT")
          : respondControlError(c, 502, "UPSTREAM_ERROR");
      }

      if (env.code !== 0) {
        // 401/403/503（journal 不可用）与 500 soul_injection_stats_failed 一律原码透出。
        const code = env.code >= 400 && env.code < 600 ? env.code : 503;
        return respondControlError(c, code, env.message || "SOUL_INJECTION_STATS_FAILED");
      }

      const data = asRecord(env.data);
      if (typeof data.rows !== "number" || !Number.isFinite(data.rows)) {
        // 契约要求 rows 恒为数字；缺失说明上游形态异常——不伪造「0 行 = 无注入」。
        deps.logger.warn("soul-injection-stats upstream returned no rows");
        return respondControlError(c, 503, "soul_injection_stats_failed");
      }

      return respondEnvelope(c, okEnvelope(c, narrowStats(data)));
    },
  );

  /**
   * GET /api/v1/soul/emotions —— 「情绪明细」只读表（阶段 3 / P3-E）。
   *
   * 上游 Core GET /v3/soul/emotions（MemoryCore/src/gateway/soul-emotions-endpoint.ts）：
   * rows 是**已落库**的情绪行（含 decayedIntensity 现场衰减值），funnel 是本次 tick 的六档漏斗计数。
   *
   * 口径与 stats 一致：team 必填（缺参 400，不伪造 "default" 轴）；user/agent 空 → "default"；
   * limit 越界/非法 → 400（不悄悄改成默认 50，否则「为什么只有 50 条」无从追）；
   * since 原样透传（ISO 时间，Core 侧解析失败会给它自己的 400）。
   * 上游非 0 信封一律原码透出（401/403/503 不折 500）；rows 不是数组 = 上游形态异常 → 503。
   */
  api.get(
    "/soul/emotions",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);

      const team = c.req.query("team")?.trim();
      if (!team) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const query: Record<string, string> = {
        team,
        user: tenantAxis(c.req.query("user")),
        agent: tenantAxis(c.req.query("agent")),
      };

      const limitRaw = c.req.query("limit")?.trim();
      if (limitRaw && limitRaw.length > 0) {
        const limit = Number(limitRaw);
        if (
          !Number.isFinite(limit) ||
          limit < EMOTIONS_LIMIT_MIN ||
          limit > EMOTIONS_LIMIT_MAX
        ) {
          return respondControlError(c, 400, "BAD_LIMIT");
        }
        query.limit = String(Math.floor(limit));
      }

      const since = c.req.query("since")?.trim();
      if (since && since.length > 0) query.since = since;

      const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_EMOTIONS_TIMEOUT_MS });
      let env: MetaEnvelope<Record<string, unknown>>;
      try {
        env = await deps.kernelHttp.getEnvelope<Record<string, unknown>>(
          SOUL_EMOTIONS_PATH,
          query,
          cred,
        );
      } catch (err) {
        const timeout = err instanceof KernelFetchError && err.code === 504;
        deps.logger.warn("soul-emotions upstream failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return timeout
          ? respondControlError(c, 504, "UPSTREAM_TIMEOUT")
          : respondControlError(c, 502, "UPSTREAM_ERROR");
      }

      if (env.code !== 0) {
        const code = env.code >= 400 && env.code < 600 ? env.code : 503;
        return respondControlError(c, code, env.message || "SOUL_EMOTIONS_FAILED");
      }

      const data = asRecord(env.data);
      if (!Array.isArray(data.rows)) {
        // rows 是契约必备项；缺失说明上游形态异常——不伪造「0 条情绪」。
        deps.logger.warn("soul-emotions upstream returned no rows array");
        return respondControlError(c, 503, "soul_emotions_failed");
      }

      return respondEnvelope(c, okEnvelope(c, narrowEmotions(data)));
    },
  );
}
