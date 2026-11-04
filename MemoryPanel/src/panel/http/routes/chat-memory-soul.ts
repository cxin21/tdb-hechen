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
 */
import type { Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import { toKernelCredentials } from "../../kernel/types.js";
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
}
