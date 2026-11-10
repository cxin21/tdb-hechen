/**
 * /api/v1/soul/persons、/api/v1/soul/person —— 人物档案只读读面（人格 v4 阶段 2 P2-H）。
 *
 * 为什么单独一个路由文件而不是塞进 chat-memory-soul.ts：
 *   那边覆盖的是灵魂快照链 / 人格卡 / 特质两栏 / 情绪明细 / 注入健康；人物档案是
 *   「按人看记忆」的读面（P2 按人过滤的延伸），关注点不同。按「一个关注点一个文件」
 *   拆出来，也避免继续堆大单文件。
 *
 * 上游（只读，零写入）：
 *   - GET /v3/soul/persons?team&user&agent      → {ok:true,data:{persons[],edges[]}}
 *   - GET /v3/soul/person?team&user&agent&key=p_xxx → {ok:true,data:{person,fields[],relations[]}}
 *   （MemoryCore/src/gateway/soul-person-endpoint.ts）
 *   两者都是**裸对象**（{ok,data}，不是 {code,message,data} 信封），所以走
 *   kernelHttp.getRaw：getEnvelope 会把裸 200 判成 invalid envelope、把 503 折成 502。
 *
 * tenant 轴：team 必填（缺参 400 MISSING_TEAM_ID —— 拿错团队的人物档案比没有更糟，
 *   不伪造 "default"）；user/agent 空/缺省填 "default"（与 Core tenantOf 同口径）。
 *
 * 出参收窄：只留面板要渲染的列，不搬运 Core 内部附加字段。
 *   - 人物行 key 或 displayName 缺失即丢行（不让半截行流到前端）；
 *     counts 缺省按 0（计数 0 是有效值，不是「没数据」）。
 *   - fields 按 Core 给的九字段顺序原样保序；evidence 只留 recordId/at/quote。
 *   - 关系行的 objKey 可能为 null（对方只有名字、还不是已登记的人），原样保留 null，
 *     由前端用 objName 显示 —— BFF 不补造 key。
 *
 * 错误口径：400 MISSING_TEAM_ID / 400 person_key_required / 502 UPSTREAM_ERROR /
 *   504 UPSTREAM_TIMEOUT；Core 的 400 person_key_required / 404 person_not_found /
 *   503 soul_person_unavailable / soul_persons_failed / soul_person_failed
 *   一律按**原码 + 上游 message** 透出，不折成 500/502。
 */
import type { Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import { toKernelCredentials } from "../../kernel/types.js";
import { KernelFetchError, type RawMetaResponse } from "../../kernel/transport-fetch.js";
import { buildCtx, okEnvelope } from "./knowledge/common.js";

/** 人物档案上游（GET，裸对象，见文件头注释）。 */
const SOUL_PERSONS_TIMEOUT_MS = 15_000;
const SOUL_PERSONS_PATH = "/v3/soul/persons";
const SOUL_PERSON_PATH = "/v3/soul/person";

/** 人物列表一行：面板左栏要显示的字段。 */
export interface SoulPersonRow {
  key: string;
  displayName: string;
  aliases: string[];
  platform: string;
  platformId: string | null;
  /** 已提炼出的字段数（0 是常态：依据不足就还没提炼）。 */
  fieldCount: number;
  /** 关系度数（0 是常态）。 */
  relationCount: number;
  updatedAt: string | null;
}

/** 关系边一行：objKey 为 null 表示对方只有名字、还不是已登记的人。 */
export interface SoulPersonEdgeRow {
  relId: string;
  subjKey: string;
  subjName: string | null;
  pred: string;
  objKey: string | null;
  objName: string | null;
  direction: "out" | "mutual";
  quote: string;
  recordId: string;
  validFrom: string | null;
}

/** 档案字段一行的证据：只留面板可展示的原话与定位。 */
export interface SoulProfileEvidenceRow {
  recordId: string;
  at: string | null;
  quote: string;
}

/** 九字段里的一条；text 为空说明提炼不出内容（前端按「还没有依据」显示）。 */
export interface SoulProfileFieldRow {
  field: string;
  label: string;
  text: string;
  evidence: SoulProfileEvidenceRow[];
  updatedAt: string | null;
  /** 依据已过期（气泡说明，不当错误）。 */
  stale: boolean;
}

/**
 * 详情页的关系行。direction="in" 时 objName 是**被读的那个人自己**的名字，
 * 对方名要从 persons 列表按 counterpartKey 反查 —— BFF 原文透传，不在这里改写语义。
 */
export interface SoulProfileRelationRow {
  relId: string;
  pred: string;
  objKey: string | null;
  objName: string | null;
  direction: "out" | "in" | "mutual";
  counterpartKey: string | null;
  quote: string;
  recordId: string;
  validFrom: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function nullOrString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function intOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** 与内核 tenantOf 同口径：空/缺省 → "default"。 */
function tenantAxis(raw: string | undefined): string {
  const v = raw?.trim();
  return v && v.length > 0 ? v : "default";
}

function narrowPersons(raw: unknown): SoulPersonRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulPersonRow[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const key = nonEmptyString(r.key);
    // key 是唯一标识（关系边要靠它连节点），缺了才真的没法展示；
    // displayName 只是标签——旧版这里 `!displayName` 也跳过，于是「先有身份、后知道名字」
    // 的人整条不出现在档案列表和关系图里（生产实测 7 个 platform 行全空名，面板上看不见人）。
    // 缺名时给出稳定占位（key 尾 6 位），让人至少能点进去看到字段与关系。
    if (!key) continue;
    const displayName = nonEmptyString(r.displayName) ?? fallbackDisplayName(key);
    rows.push({
      key,
      displayName,
      aliases: stringArray(r.aliases),
      platform: nonEmptyString(r.platform) ?? "",
      platformId: nullOrString(r.platformId),
      fieldCount: intOr(r.fieldCount, 0),
      relationCount: intOr(r.relationCount, 0),
      updatedAt: nullOrString(r.updatedAt),
    });
  }
  return rows;
}

/** 空名占位：`p_b38a137ab63b` → `未命名·ab63b`。稳定（同 key 同结果），不冒充真名。 */
function fallbackDisplayName(key: string): string {
  const tail = key.replace(/[^0-9a-zA-Z]/gu, "").slice(-5);
  return tail.length > 0 ? `未命名·${tail}` : "未命名";
}

function narrowEdges(raw: unknown): SoulPersonEdgeRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulPersonEdgeRow[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const relId = nonEmptyString(r.relId);
    const subjKey = nonEmptyString(r.subjKey);
    const pred = nonEmptyString(r.pred);
    if (!relId || !subjKey || !pred) continue;
    rows.push({
      relId,
      subjKey,
      subjName: nullOrString(r.subjName),
      pred,
      objKey: nullOrString(r.objKey),
      objName: nullOrString(r.objName),
      direction: r.direction === "mutual" ? "mutual" : "out",
      quote: nonEmptyString(r.quote) ?? "",
      recordId: nonEmptyString(r.recordId) ?? "",
      validFrom: nullOrString(r.validFrom),
    });
  }
  return rows;
}

function narrowEvidence(raw: unknown): SoulProfileEvidenceRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulProfileEvidenceRow[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const quote = nonEmptyString(r.quote);
    if (!quote) continue;
    rows.push({
      recordId: nonEmptyString(r.recordId) ?? "",
      at: nullOrString(r.at),
      quote,
    });
  }
  return rows;
}

function narrowFields(raw: unknown): SoulProfileFieldRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulProfileFieldRow[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const field = nonEmptyString(r.field);
    const label = nonEmptyString(r.label);
    if (!field || !label) continue;
    rows.push({
      field,
      label,
      text: nonEmptyString(r.text) ?? "",
      evidence: narrowEvidence(r.evidence),
      updatedAt: nullOrString(r.updatedAt),
      stale: r.stale === true,
    });
  }
  return rows;
}

function narrowPersonRelations(raw: unknown): SoulProfileRelationRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SoulProfileRelationRow[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const relId = nonEmptyString(r.relId);
    const pred = nonEmptyString(r.pred);
    if (!relId || !pred) continue;
    const direction =
      r.direction === "in" ? "in" : r.direction === "mutual" ? "mutual" : "out";
    rows.push({
      relId,
      pred,
      objKey: nullOrString(r.objKey),
      objName: nullOrString(r.objName),
      direction,
      counterpartKey: nullOrString(r.counterpartKey),
      quote: nonEmptyString(r.quote) ?? "",
      recordId: nonEmptyString(r.recordId) ?? "",
      validFrom: nullOrString(r.validFrom),
    });
  }
  return rows;
}

/**
 * 上游非 2xx / 网络失败统一出口：原码 + 上游 message 透出；只有网络/超时折成 502/504。
 * 返回 null 表示上游 2xx（调用方继续走成功路径）。
 */
function forwardUpstreamFailure(
  c: Parameters<typeof respondControlError>[0],
  deps: PanelDeps,
  label: string,
  upstream: RawMetaResponse,
): Response | null {
  if (upstream.status >= 200 && upstream.status < 300) return null;
  const body = asRecord(upstream.body);
  const message =
    nonEmptyString(body.error) ??
    nonEmptyString(body.message) ??
    (upstream.text.trim() || `${label}_failed (http ${upstream.status})`);
  const code = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 503;
  return respondControlError(c, code, message);
}

export interface SoulPersonsPayload {
  persons: SoulPersonRow[];
  edges: SoulPersonEdgeRow[];
}

export interface SoulPersonDetailPayload {
  person: { key: string; displayName: string; aliases: string[] };
  fields: SoulProfileFieldRow[];
  relations: SoulProfileRelationRow[];
}

export function registerSoulPersonsRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * GET /api/v1/soul/persons —— 人物列表 + 全员关系边（一次取回，关系图不二次请求）。
   *
   * 生产首屏就是「4 个人、0 条边」：persons 非空即 200，edges 空数组由前端画空态，
   * 这里**不**把「没有边」当错误。
   */
  api.get("/soul/persons", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const team = c.req.query("team")?.trim();
    if (!team) return respondControlError(c, 400, "MISSING_TEAM_ID");

    const query = {
      team,
      user: tenantAxis(c.req.query("user")),
      agent: tenantAxis(c.req.query("agent")),
    };
    const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_PERSONS_TIMEOUT_MS });

    let upstream: RawMetaResponse;
    try {
      upstream = await deps.kernelHttp.getRaw(SOUL_PERSONS_PATH, query, cred);
    } catch (err) {
      const timeout = err instanceof KernelFetchError && err.code === 504;
      deps.logger.warn("soul-persons upstream failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return timeout
        ? respondControlError(c, 504, "UPSTREAM_TIMEOUT")
        : respondControlError(c, 502, "UPSTREAM_ERROR");
    }

    const failure = forwardUpstreamFailure(c, deps, "soul_persons", upstream);
    if (failure) return failure;

    const data = asRecord(asRecord(upstream.body).data);
    if (!Array.isArray(data.persons)) {
      // 契约要求 persons 恒为数组；缺失说明上游形态异常 —— 不伪造空列表。
      deps.logger.warn("soul-persons upstream returned no persons array");
      return respondControlError(c, 503, "soul_persons_failed");
    }

    const payload: SoulPersonsPayload = {
      persons: narrowPersons(data.persons),
      edges: narrowEdges(data.edges),
    };
    return respondEnvelope(c, okEnvelope(c, payload));
  });

  /**
   * GET /api/v1/soul/person?key=p_xxx —— 单人档案：九字段（已提炼的那几条）+ 关系行。
   *
   * key 只校验非空：形状（p_ 前缀）交给 Core 判，Core 的 400 person_key_required
   * 原码透出，避免两处规则各自漂移。
   */
  api.get("/soul/person", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const team = c.req.query("team")?.trim();
    if (!team) return respondControlError(c, 400, "MISSING_TEAM_ID");
    const key = c.req.query("key")?.trim();
    if (!key) return respondControlError(c, 400, "person_key_required");

    const query = {
      team,
      user: tenantAxis(c.req.query("user")),
      agent: tenantAxis(c.req.query("agent")),
      key,
    };
    const cred = toKernelCredentials(ctx, { timeoutMs: SOUL_PERSONS_TIMEOUT_MS });

    let upstream: RawMetaResponse;
    try {
      upstream = await deps.kernelHttp.getRaw(SOUL_PERSON_PATH, query, cred);
    } catch (err) {
      const timeout = err instanceof KernelFetchError && err.code === 504;
      deps.logger.warn("soul-person upstream failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return timeout
        ? respondControlError(c, 504, "UPSTREAM_TIMEOUT")
        : respondControlError(c, 502, "UPSTREAM_ERROR");
    }

    const failure = forwardUpstreamFailure(c, deps, "soul_person", upstream);
    if (failure) return failure;

    const data = asRecord(asRecord(upstream.body).data);
    const personRaw = asRecord(data.person);
    const personKey = nonEmptyString(personRaw.key);
    const displayName = nonEmptyString(personRaw.displayName);
    if (!personKey || !displayName) {
      deps.logger.warn("soul-person upstream returned no person");
      return respondControlError(c, 503, "soul_person_failed");
    }

    const payload: SoulPersonDetailPayload = {
      person: {
        key: personKey,
        displayName,
        aliases: stringArray(personRaw.aliases),
      },
      fields: narrowFields(data.fields),
      relations: narrowPersonRelations(data.relations),
    };
    return respondEnvelope(c, okEnvelope(c, payload));
  });
}