/**
 * 人物档案提炼通道（P2-H，2026-11-08 spec）。
 *
 * 与 soul worker 的关系：worker 负责「我」的人格层，本文件负责「他」的档案层——
 * 同一个 store、同一张 `soul_persona` 表（`layer='human'` + `meta.source='person-profile'`），
 * 但**不经过** soul 的台上/台下判据：档案的事实来源是「这个人自己说过的话」，
 * 由模型提炼 + 确定性校验（profile.ts）兜住，落库只写 human 行与关系边。
 *
 * 三条硬纪律（写在这里是因为后面每个函数都依赖）：
 *   1. 一人一次调用、一次写一个事务；任一人的模型调用/落库失败只记账不回滚别人，也不写水位。
 *   2. 水位（`profile_at`）只在「模型答了、解析成功、落库成功」之后写；失败下一 tick 自动重试。
 *   3. 数量上限由 A12 决定（`min(8, maxUpdatedPerCycle*2)`），超出的记 `deferred`，不静默丢。
 */

import { createHash } from "node:crypto";
import type { CoreTenant, IMemoryStore, SoulPersonRelationRow } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import type { PersonaItem, SoulLedgerEntry, SoulLayer } from "../soul/types.js";
import type { SoulPerson } from "./types.js";
import {
  PERSON_PROFILE_FIELD_ORDER,
  PERSON_PROFILE_FIELDS,
  PROFILE_CONTENT_MAX,
  PROFILE_ORIGINAL_MAX_CHARS,
  PROFILE_DISLIKES_MIN_EVIDENCE,
  PROFILE_MAX_EVIDENCE,
  PROFILE_MAX_HISTORY,
  PROFILE_MAX_PERSONS_PER_TICK,
  PROFILE_MAX_TOKENS,
  PROFILE_MIN_MENTIONS,
  PROFILE_RECENT_PER_PERSON,
  PROFILE_REFRESH_MIN_HOURS,
  PROFILE_SOURCE,
  PROFILE_SYSTEM_PROMPT,
  PROFILE_VERSION,
  PROFILE_ITEM_PREFIX,
  buildPersonProfilePrompt,
  charLength,
  countDropReasons,
  formatProfileText,
  isPersonProfileField,
  normalizeRelationPred,
  normalizeWhitespace,
  parsePersonProfileOutput,
  profileEvidenceDay,
  profileItemId,
  profileSupersedingItemId,
  relationIdOf,
  stripProfileLabel,
  tenantKeyOf,
  validatePersonProfileOutput,
  type AcceptedProfileField,
  type AcceptedProfileRelation,
  type ExistingProfileField,
  type ExistingRelationEdge,
  type PersonProfileField,
  type PersonRelationPred,
  type ProfileDrop,
  type ProfileMemoryInput,
  type RawProfileRelation,
} from "./profile.js";
import { normalizePersonName, resolvePerson } from "./resolve.js";
import { normalizePersonNameCandidate } from "../record/person-hints.js";

/** 提炼任务的 taskId（日志/账本里认人用）。 */
export const PROFILE_TASK_ID = "person-profile";

/** LLM 调用超时（一人一次；超时算失败、不写水位）。 */
const DEFAULT_PROFILE_TIMEOUT_MS = 60_000;

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 内容 hash（账本 before/after 用；与 soul 侧同口径：sha1 前 16 位）。 */
function contentHash(item: PersonaItem): string {
  return sha1(`${item.layer}|${item.text}|${item.state}`);
}

function shortEnough(content: string): string {
  return content.length <= PROFILE_CONTENT_MAX ? content : content.slice(0, PROFILE_CONTENT_MAX);
}

/** 按 `source_message_ids` 顺序拼原话；一条都取不到时返回 undefined（退回摘要口径）。 */
function originalTextOf(ids: string[] | undefined, byId: Map<string, string>): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const parts: string[] = [];
  let total = 0;
  for (const id of ids) {
    if (total >= PROFILE_ORIGINAL_MAX_CHARS) break;
    const text = (byId.get(id) ?? "").trim();
    if (text === "") continue;
    const room = PROFILE_ORIGINAL_MAX_CHARS - total;
    const piece = text.length > room ? text.slice(0, room) : text;
    parts.push(piece);
    total += piece.length;
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * 批量取这批记忆对应的 L0 原话。
 *
 * `queryL0ByIds` 是 sqlite store 的具体方法、不在 IMemoryStore 契约里（替身/测试桩没有），
 * 所以这里做能力探测：没有就返回空表，引文校验退回摘要口径——宁可链短一截，也不为它加接口。
 * 过滤三个租户轴：跨租户 id 查不到（同 `queryL0ByIds` 口径），不会把别人的原话读进提示词。
 */
async function loadOriginalTexts(
  store: unknown,
  tenant: CoreTenant,
  l1: Array<{ sourceMessageIds?: string[] }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = new Set<string>();
  for (const row of l1) for (const id of row.sourceMessageIds ?? []) want.add(id);
  if (want.size === 0) return out;
  const reader = (
    store as {
      queryL0ByIds?: (
        ids: string[],
        filter?: { teamId?: string; userId?: string; agentId?: string },
      ) => Array<{ record_id?: unknown; message_text?: unknown }>;
    }
  ).queryL0ByIds;
  if (typeof reader !== "function") return out;
  try {
    const rows = await Promise.resolve(
      reader.call(store, [...want], { teamId: tenant.teamId, userId: tenant.userId, agentId: tenant.agentId }),
    );
    for (const row of rows ?? []) {
      const id = String(row.record_id ?? "");
      const text = String(row.message_text ?? "");
      if (id !== "" && text !== "") out.set(id, text);
    }
  } catch {
    // 取原话失败不该炸整轮提炼：原话是「更硬的证据」，不是必需输入。
  }
  return out;
}

/** 一条记忆的时间戳可空：`at` 全空时排到最后（选人不靠它，只做展示）。 */
function atOf(value: string | undefined): string {
  const at = (value ?? "").trim();
  return at === "" ? "" : at;
}

// ============================
// 类型
// ============================

/** 提炼通道用到的 store 能力（A1 + 关系边 + 水位 + 档案读写）。 */
export type PersonProfileStorePort = Pick<
  IMemoryStore,
  | "listSoulPersona"
  | "commitSoulPersona"
  | "listSoulPersons"
  | "listL1ByPerson"
  | "listPersonProfileStats"
  | "listSoulPersonProfileWatermarks"
  | "markSoulPersonProfileAt"
  | "listSoulPersonRelations"
  | "commitSoulPersonRelations"
>;

/** 一个人这一轮的账。 */
export interface PersonProfilePersonReport {
  personKey: string;
  displayName: string;
  memories: number;
  /** 通过校验、真正落库的字段数（不含 outdated 作废）。 */
  fields: number;
  /** 落库的关系边行数（新增 + 并证据）。 */
  relations: number;
  /** 旧行被置 validTo 的数量（字段 + 边）。 */
  outdated: number;
  dropped: number;
  byReason: Record<string, number>;
  /** 失败原因（模型/解析/落库）；非空时本轮不写水位。 */
  error?: string;
}

/** 进 `report.personProfile`（worker 直接透传）。 */
export interface PersonProfileReport {
  /** 候选人数（≥3 条 L1 提到、未合并）。 */
  candidates: number;
  /** 这一轮真正调了模型的人数（≤ maxPersons）。 */
  attempted: number;
  /** 过水位门槛、够跑但被上限挡下的人数（§6.5）。 */
  deferred: number;
  /** 成功（含 0 条通过校验）的人数。 */
  completed: number;
  /** 失败（模型/解析/落库）的人数。 */
  failed: number;
  fields: number;
  relations: number;
  outdated: number;
  dropped: number;
  byReason: Record<string, number>;
  persons: PersonProfilePersonReport[];
}

export interface PersonProfileRunInput {
  store: PersonProfileStorePort;
  tenant: CoreTenant;
  now: string;
  /** A12：本轮最多跑几个人。 */
  maxPersons: number;
  trigger: string;
}

export type PersonProfiler = (input: PersonProfileRunInput) => Promise<PersonProfileReport>;

export interface PersonProfilerOptions {
  timeoutMs?: number;
  logger?: Logger;
}

// ============================
// A12：每 tick 人数
// ============================

/**
 * A12：每 tick 人数 = `min(8, maxUpdatedPerCycle * 2)`。
 *
 * 不新增配置键——复用既有 `maxUpdatedPerCycle`（默认 3 → 6 人/轮），
 * 上限 8 是硬顶（一人一次调用，再多会挤掉 soul 主流程的调用预算）。
 */
export function personProfileMaxPerTick(maxUpdatedPerCycle: number): number {
  const base = Number.isFinite(maxUpdatedPerCycle) ? Math.max(0, Math.floor(maxUpdatedPerCycle)) : 0;
  return Math.min(PROFILE_MAX_PERSONS_PER_TICK, base * 2);
}

// ============================
// 选人（§6 + A8）
// ============================

export interface ProfileCandidate {
  personKey: string;
  displayName: string;
  memories: number;
  lastAt: string;
  profileAt: string | null;
}

/**
 * §6 选人：候选（≥3 条 L1）→ 水位过滤 → profile_at 升序（null 优先）→ 截断。
 *
 * 过门槛但被截断的人记 `deferred`：这是「够格但没跑」，不是「不符合条件」，
 * 混在一起会让运维看不出配额被谁吃掉了。
 */
export function pickPersonProfileTargets(input: {
  persons: ReadonlyArray<SoulPerson>;
  stats: ReadonlyArray<{ personKey: string; memories: number; lastAt: string }>;
  watermarks: ReadonlyArray<{ personKey: string; profileAt: string | null }>;
  now: string;
  maxPersons: number;
}): { selected: ProfileCandidate[]; deferred: number; candidates: number } {
  const byKey = new Map(input.persons.map((p) => [p.personKey, p]));
  const watermarkOf = new Map(input.watermarks.map((w) => [w.personKey, w.profileAt]));
  const nowMs = Date.parse(input.now);
  const minGapMs = PROFILE_REFRESH_MIN_HOURS * 60 * 60 * 1000;

  const eligible: ProfileCandidate[] = [];
  let candidates = 0;
  for (const stat of input.stats) {
    const person = byKey.get(stat.personKey);
    if (!person) continue; // merged_into 非空 / 已消失的人：listSoulPersons 已过滤，这里再兜一层
    if (stat.memories < PROFILE_MIN_MENTIONS) continue;
    candidates += 1;
    const profileAt = watermarkOf.get(stat.personKey) ?? null;
    if (profileAt !== null && profileAt !== "") {
      const profileMs = Date.parse(profileAt);
      const lastMs = Date.parse(stat.lastAt);
      if (Number.isFinite(profileMs)) {
        // 没有新记忆 → 不跑；有新记忆但距上次不足 6h → 也不跑（防抖，A8）。
        if (!Number.isFinite(lastMs) || lastMs <= profileMs) continue;
        if (Number.isFinite(nowMs) && nowMs - profileMs < minGapMs) continue;
      }
    }
    eligible.push({
      personKey: stat.personKey,
      displayName: person.displayName,
      memories: stat.memories,
      lastAt: stat.lastAt,
      profileAt: profileAt === "" ? null : profileAt,
    });
  }

  // profile_at 升序（null 优先：从没跑过的人先跑）；同水位按 key 稳定排序。
  eligible.sort((a, b) => {
    if (a.profileAt === b.profileAt) return a.personKey < b.personKey ? -1 : 1;
    if (a.profileAt === null) return -1;
    if (b.profileAt === null) return 1;
    return a.profileAt < b.profileAt ? -1 : 1;
  });

  const limit = Math.max(0, Math.floor(input.maxPersons));
  return {
    selected: eligible.slice(0, limit),
    deferred: Math.max(0, eligible.length - limit),
    candidates,
  };
}

// ============================
// 档案行 ↔ 提示词输入
// ============================

interface ProfileMeta {
  source?: unknown;
  person?: { key?: unknown; displayName?: unknown };
  profileField?: unknown;
  evidence?: unknown;
  profileVersion?: unknown;
  history?: unknown;
}

function profileMetaOf(item: PersonaItem): ProfileMeta | null {
  const meta = item.meta;
  if (!meta || typeof meta !== "object") return null;
  const typed = meta as ProfileMeta;
  if (typed.source !== PROFILE_SOURCE) return null;
  return typed;
}

function metaPersonKey(item: PersonaItem): string {
  const meta = profileMetaOf(item);
  const key = meta?.person?.key;
  return typeof key === "string" ? key : "";
}

function metaEvidence(item: PersonaItem): Array<{ recordId: string; at: string; quote: string }> {
  const meta = profileMetaOf(item);
  if (!meta || !Array.isArray(meta.evidence)) return [];
  const out: Array<{ recordId: string; at: string; quote: string }> = [];
  for (const raw of meta.evidence) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { recordId?: unknown; at?: unknown; quote?: unknown };
    const recordId = typeof rec.recordId === "string" ? rec.recordId : "";
    if (recordId === "") continue;
    out.push({
      recordId,
      at: typeof rec.at === "string" ? rec.at : "",
      quote: typeof rec.quote === "string" ? rec.quote : "",
    });
  }
  return out;
}

function metaHistory(item: PersonaItem): NonNullable<ExistingProfileField["history"]> {
  const meta = profileMetaOf(item);
  if (!meta || !Array.isArray(meta.history)) return [];
  const out: NonNullable<ExistingProfileField["history"]> = [];
  for (const raw of meta.history) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { text?: unknown; evidence?: unknown; validFrom?: unknown; validTo?: unknown };
    const text = typeof rec.text === "string" ? rec.text : "";
    if (text === "") continue;
    out.push({
      text,
      ...(typeof rec.validFrom === "string" ? { validFrom: rec.validFrom } : {}),
      ...(typeof rec.validTo === "string" ? { validTo: rec.validTo } : {}),
    });
  }
  return out;
}

/** 现行档案行 → 提示词里的 `existing`（只给人类可读的正文，不给 meta 细节）。 */
function toExistingField(item: PersonaItem, field: PersonProfileField): ExistingProfileField {
  const evidence = metaEvidence(item);
  const lastEvidenceAt = evidence[0]?.at ?? item.lastEvidenceAt ?? item.updatedAt;
  return {
    rowId: item.itemId,
    field,
    text: stripProfileLabel(field, item.text),
    evidenceCount: evidence.length > 0 ? evidence.length : (item.evidenceIds?.length ?? 0),
    lastEvidenceAt,
    ...(item.createdAt ? { validFrom: item.createdAt } : {}),
    history: metaHistory(item),
  };
}

/** 现行关系边行 → 提示词里的 `relationCandidates`（谓词越界的行不进提示词）。 */
function toExistingRelation(row: SoulPersonRelationRow): ExistingRelationEdge | null {
  if (normalizeRelationPred(row.pred) === null) return null;
  return {
    relId: row.relId,
    subjKey: row.subjKey,
    pred: row.pred,
    objKey: row.objKey,
    objName: row.objName,
    direction: row.direction,
    quote: row.quote,
  };
}

// ============================
// 写库：档案行（§5.1 + A3）
// ============================

interface FieldWrite {
  items: PersonaItem[];
  drops: ProfileDrop[];
  ledger: SoulLedgerEntry[];
  /** 真正写入的新/更新字段数。 */
  written: number;
  /** 作废数。 */
  outdated: number;
}

/**
 * 把一份通过校验的字段清单变成 `soul_persona` 的 upsert + 账本。
 *
 * A3 的两种更新语义在这里分叉：
 *   - `op=update`：**itemId 不动**，就地换 text，旧正文压进 `meta.history`（≤3 代）。
 *   - `op=outdated`：旧行写 `validTo`（+ `supersededBy` 指向新行），新行换取
 *     `human:pp-<sha1(key|field)>-<sha1(新正文)[0:8]>` 的 itemId——旧行不删，留证。
 *   - `op=add` 且同字段已有现行行（模型不知道旧行存在）：落到同一 itemId 上覆盖，
 *     所以「同样的输出跑第二遍仍然是同样多行」（§9 测试 3 的不变量）。
 */
function buildFieldWrites(input: {
  personKey: string;
  displayName: string;
  now: string;
  trigger: string;
  fields: ReadonlyArray<AcceptedProfileField>;
  existingByRowId: ReadonlyMap<string, { item: PersonaItem; field: PersonProfileField }>;
  currentByField: ReadonlyMap<PersonProfileField, PersonaItem>;
  memoryAt: ReadonlyMap<string, string>;
}): FieldWrite {
  const items: PersonaItem[] = [];
  const ledger: SoulLedgerEntry[] = [];
  const writtenKeys = new Set<string>();
  let written = 0;
  let outdated = 0;
  const drops: ProfileDrop[] = [];

  const hasOutdatedFor = new Set<PersonProfileField>();
  for (const f of input.fields) if (f.op === "outdated") hasOutdatedFor.add(f.field);

  const pushLedger = (
    item: PersonaItem,
    action: SoulLedgerEntry["action"],
    before: PersonaItem | undefined,
  ): void => {
    ledger.push({
      entryId: `led-${item.layer}-${item.itemId}-${action}-${input.now}`,
      at: input.now,
      trigger: input.trigger,
      layer: item.layer as SoulLayer,
      itemId: item.itemId,
      action,
      ...(before ? { beforeHash: contentHash(before) } : {}),
      afterHash: contentHash(item),
      gates: ["person_profile", "deterministic_validate"],
      reason: `${PROFILE_SOURCE} field=${String((item.meta as { profileField?: unknown } | undefined)?.profileField ?? "")} action=${action}`,
      evidenceIds: item.evidenceIds,
    });
  };

  for (const field of input.fields) {
    const key = `${field.op}|${field.field}`;
    if (writtenKeys.has(key)) continue;
    writtenKeys.add(key);
    const evidenceAt = input.memoryAt.get(field.recordId) ?? "";
    const evidence = { recordId: field.recordId, at: atOf(evidenceAt), quote: field.quote };

    if (field.op === "outdated") {
      const target = field.targetRowId ? input.existingByRowId.get(field.targetRowId) : undefined;
      if (!target || target.item.validTo) continue; // 已经作废过：幂等跳过
      const successor = items.find(
        (it) =>
          (it.meta as { profileField?: unknown } | undefined)?.profileField === field.field &&
          !it.validTo,
      );
      const retired: PersonaItem = {
        ...target.item,
        validTo: input.now,
        ...(successor ? { supersededBy: successor.itemId } : {}),
        updatedAt: input.now,
      };
      items.push(retired);
      pushLedger(retired, "invalidate", target.item);
      outdated += 1;
      continue;
    }

    const current = input.currentByField.get(field.field);
    const existingText = current ? stripProfileLabel(field.field, current.text) : "";
    const nextText = formatProfileText(field.field, field.text);

    // 同一字段同一正文：不写（避免每 tick 都把 updatedAt 推高、让 TTL 永不老化）。
    if (current && existingText === stripProfileLabel(field.field, nextText) && !hasOutdatedFor.has(field.field)) {
      continue;
    }

    // A3 的 outdated 分支：同一批里「作废旧行 + 写新值」时，新值必须是**新行**。
    // 落回旧 itemId 会把刚标了 validTo 的那一行又覆盖回 active（实测踩过：行数从 2 变 1）。
    const superseding = hasOutdatedFor.has(field.field);
    const base = superseding ? undefined : current;
    const stableId = superseding
      ? profileSupersedingItemId(input.personKey, field.field, nextText)
      : (current?.itemId ?? profileItemId(input.personKey, field.field));

    const priorEvidence = base ? metaEvidence(base) : [];
    const mergedEvidence: Array<{ recordId: string; at: string; quote: string }> = [];
    const seenEvidence = new Set<string>();
    for (const ev of [evidence, ...priorEvidence]) {
      if (ev.recordId === "") continue;
      const dedupeKey = `${ev.recordId}|${ev.quote}`;
      if (seenEvidence.has(dedupeKey)) continue;
      seenEvidence.add(dedupeKey);
      mergedEvidence.push(ev);
      if (mergedEvidence.length >= PROFILE_MAX_EVIDENCE) break;
    }

    // §7：dislikes「逐字，需 ≥2 条证据」——累计证据（本轮 + 该字段已有证据）不够 2 条就不写，
    // 等下次再攒一条。凑不够不算模型错，但必须计数，禁止静默。
    if (field.field === "dislikes" && mergedEvidence.length < PROFILE_DISLIKES_MIN_EVIDENCE) {
      drops.push({
        kind: "field",
        name: field.field,
        reason: "insufficient_evidence",
        detail: `evidence=${mergedEvidence.length}`,
      });
      continue;
    }

    const priorHistory = base ? metaHistory(base) : [];
    const history =
      base && existingText !== ""
        ? [
            {
              text: base.text,
              evidence: priorEvidence,
              validFrom: base.createdAt,
              validTo: input.now,
            },
            ...priorHistory,
          ].slice(0, PROFILE_MAX_HISTORY)
        : priorHistory.slice(0, PROFILE_MAX_HISTORY);

    const item: PersonaItem = {
      itemId: stableId,
      layer: "human",
      text: nextText,
      state: "active",
      weight: 0.8,
      evidenceIds: mergedEvidence.map((e) => e.recordId),
      evidenceDays: Array.from(new Set(mergedEvidence.map((e) => profileEvidenceDay(e.at, input.now)))),
      // A2：能进档案的只有本人/主人说过的话，所以证据来源恒为 "user"（不走 "soul"/"model"）。
      evidenceOrigins: ["user"],
      createdAt: base?.createdAt ?? input.now,
      updatedAt: input.now,
      lastEvidenceAt: input.now,
      meta: {
        source: PROFILE_SOURCE,
        person: { key: input.personKey, displayName: input.displayName },
        profileField: field.field,
        evidence: mergedEvidence,
        profileVersion: PROFILE_VERSION,
        ...(history.length > 0 ? { history } : {}),
      },
    };
    items.push(item);
    pushLedger(item, base ? "update" : "admit", base);
    written += 1;
  }

  return { items, ledger, written, outdated, drops };
}

// ============================
// 写库：关系边（§5.2 + A4/A5）
// ============================

interface RelationWrite {
  insert: SoulPersonRelationRow[];
  appendEvidence: Array<{ relId: string; items: Array<{ recordId: string; at: string; quote: string }> }>;
  close: Array<{ relId: string; at: string }>;
}

/**
 * 一对 (A,B) 是不是同一条边（A5）。
 *
 * 谓词开放之后，「同一件事」只能靠模型给的词与逆词判：
 * ① 同向同词（对称关系两侧同词）；② 反向且谓词互为逆词。
 */
function sameEdge(
  edge: {
    subjKey: string;
    pred: string;
    inversePred?: string | null;
    objKey: string | null;
    objName: string | null;
  },
  want: {
    personKey: string;
    pred: string;
    inverse: string | null;
    objKey: string | null;
    objName: string | null;
    symmetric: boolean;
  },
): boolean {
  const samePred = (a: string | null | undefined, b: string | null | undefined): boolean =>
    typeof a === "string" && typeof b === "string" && normalizeWhitespace(a) === normalizeWhitespace(b);
  const objMatchesForward =
    want.objKey !== null
      ? edge.objKey === want.objKey
      : normalizeWhitespace(edge.objName ?? "") === normalizeWhitespace(want.objName ?? "");
  const objMatchesBackward = want.objKey !== null ? edge.subjKey === want.objKey : false;
  if (edge.subjKey === want.personKey && objMatchesForward && samePred(edge.pred, want.pred)) return true;
  if (objMatchesBackward) {
    // 对称关系两侧写同一个词，谁当 subj 都算同一条边。
    if (want.symmetric && samePred(edge.pred, want.pred)) return true;
    if (want.inverse !== null && samePred(edge.pred, want.inverse)) return true;
    if (samePred(edge.inversePred, want.pred)) return true;
  }
  return false;
}

/**
 * 关系边写入计划。
 *
 * A5 的两层归并都在这里：
 *   ① `mergeRelId`（profile.ts 在库里找到的既有边）→ 只并证据，不插行；
 *   ② 本批内部重复（同一轮模型同时给了「上级」和反向下属）→ 也并到先出现的那条，
 *      否则一次 tick 就会插两行互相矛盾的行。
 */
function buildRelationWrites(input: {
  personKey: string;
  tenantKey: string;
  now: string;
  relations: ReadonlyArray<AcceptedProfileRelation>;
  memoryAt: ReadonlyMap<string, string>;
}): RelationWrite {
  const insert: SoulPersonRelationRow[] = [];
  const appendMap = new Map<string, Array<{ recordId: string; at: string; quote: string }>>();
  const close: Array<{ relId: string; at: string }> = [];

  const appendTo = (relId: string, ev: { recordId: string; at: string; quote: string }): void => {
    const list = appendMap.get(relId) ?? [];
    if (!list.some((e) => e.recordId === ev.recordId && e.quote === ev.quote)) list.push(ev);
    appendMap.set(relId, list);
  };

  for (const rel of input.relations) {
    const ev = { recordId: rel.recordId, at: atOf(input.memoryAt.get(rel.recordId) ?? ""), quote: rel.quote };
    if (rel.op !== "add" && rel.targetRelId) close.push({ relId: rel.targetRelId, at: input.now });
    if (rel.mergeRelId) {
      appendTo(rel.mergeRelId, ev);
      continue;
    }
    const want = {
      personKey: input.personKey,
      pred: rel.pred,
      inverse: rel.inverse,
      objKey: rel.objKey,
      objName: rel.objName,
      symmetric: rel.direction === "mutual",
    };
    const batchHit = insert.find((row) =>
      sameEdge({ subjKey: row.subjKey, pred: row.pred, inversePred: row.inversePred, objKey: row.objKey, objName: row.objName }, want),
    );
    if (batchHit) {
      appendTo(batchHit.relId, ev);
      continue;
    }
    const relId = relationIdOf({
      tenantKey: input.tenantKey,
      subjKey: input.personKey,
      pred: rel.pred,
      obj: rel.objKey ?? rel.objName ?? "",
      validFrom: input.now,
    });
    insert.push({
      relId,
      subjKey: input.personKey,
      pred: rel.pred,
      inversePred: rel.inverse,
      objKey: rel.objKey,
      objName: rel.objName,
      direction: rel.direction,
      quote: rel.quote,
      recordId: rel.recordId,
      evidence: [ev],
      validFrom: input.now,
      validTo: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  return {
    insert,
    appendEvidence: Array.from(appendMap.entries()).map(([relId, items]) => ({ relId, items })),
    close,
  };
}

// ============================
// 一人一轮
// ============================

function emptyReport(): PersonProfileReport {
  return {
    candidates: 0,
    attempted: 0,
    deferred: 0,
    completed: 0,
    failed: 0,
    fields: 0,
    relations: 0,
    outdated: 0,
    dropped: 0,
    byReason: {},
    persons: [],
  };
}

function addReasons(target: Record<string, number>, add: Record<string, number>): void {
  for (const [k, v] of Object.entries(add)) target[k] = (target[k] ?? 0) + v;
}

/**
 * 关系对象落人：模型只给 objName、不给 obj.key 时，用名字解析/新建一个人，把 key 补上。
 *
 * 为什么必须补：面板的关系图与「谁和谁有关」按 obj_key 连边；只写 objName 的边是断头边
 * （生产实测 4 条边里 3 条 obj_key=null）。名字来源仍受两道硬门：必须能过人名形状门，
 * 且必须逐字出现在这条边自己的引文里——不能凭关系名想象一个人。
 *
 * 失败只跳过这一条边（保留 objName），不影响整轮提炼。
 */
async function resolveRelationObjects(
  relations: RawProfileRelation[],
  input: {
    store: PersonProfileStorePort;
    tenant: CoreTenant;
    person: SoulPerson;
    memories: ReadonlyArray<ProfileMemoryInput>;
  },
  opts: PersonProfilerOptions,
): Promise<Array<{ key: string; displayName: string }>> {
  const store = input.store as unknown as IMemoryStore;
  if (typeof store.upsertSoulPerson !== "function") return [];
  const out: Array<{ key: string; displayName: string }> = [];
  const seen = new Set<string>();
  const selfName = normalizePersonName(input.person.displayName);
  const sources = input.memories.map((m) => m.originalText ?? m.content);
  for (const raw of relations) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw.obj;
    const hasKey =
      obj && typeof obj === "object" && typeof (obj as { key?: unknown }).key === "string"
        ? ((obj as { key: string }).key).trim() !== ""
        : false;
    if (hasKey) continue;
    const name = normalizePersonNameCandidate(raw.objName);
    if (name === null) continue;
    if (selfName !== "" && normalizePersonName(name) === selfName) continue;
    const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
    if (quote === "") continue;
    // 引文必须已被本批记忆证实，名字还必须在这条引文里逐字出现。
    if (!sources.some((s) => s.includes(quote))) continue;
    if (!quote.includes(name)) continue;
    try {
      const person = await resolvePerson(store, input.tenant, { displayName: name });
      if (!person?.personKey) continue;
      raw.obj = { key: person.personKey };
      raw.objName = person.displayName || name;
      if (!seen.has(person.personKey)) {
        seen.add(person.personKey);
        out.push({ key: person.personKey, displayName: person.displayName || name });
      }
    } catch (err) {
      opts.logger?.warn?.(
        `[person-profile] resolve obj failed name=${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** 一人的完整一轮：取记忆 → 组提示词 → 调模型 → 校验 → 落库 → 写水位。 */
async function runOnePerson(
  runner: LLMRunner,
  input: PersonProfileRunInput,
  candidate: ProfileCandidate,
  person: SoulPerson,
  knownPersons: ReadonlyArray<{ key: string; displayName: string }>,
  opts: PersonProfilerOptions,
): Promise<PersonProfilePersonReport> {
  const { store, tenant, now, trigger } = input;
  const report: PersonProfilePersonReport = {
    personKey: candidate.personKey,
    displayName: person.displayName,
    memories: 0,
    fields: 0,
    relations: 0,
    outdated: 0,
    dropped: 0,
    byReason: {},
  };

  const l1 = (await store.listL1ByPerson?.(tenant, candidate.personKey, PROFILE_RECENT_PER_PERSON)) ?? [];
  const originalById = await loadOriginalTexts(store, tenant, l1);
  const memories: ProfileMemoryInput[] = [];
  const memoryAt = new Map<string, string>();
  for (const row of l1) {
    const role = row.roleInRecord === "speaker" ? "speaker" : row.roleInRecord === "subject" ? "subject" : null;
    if (!role) continue;
    const speakerIsSelf =
      role === "speaker" || (person.platformId !== null && row.userId != null && row.userId === person.platformId);
    const memory: ProfileMemoryInput = {
      recordId: row.recordId,
      at: atOf(row.at),
      content: shortEnough(row.content ?? ""),
      ...(() => {
        const originalText = originalTextOf(row.sourceMessageIds, originalById);
        return originalText === undefined ? {} : { originalText };
      })(),
      speakerIsSelf,
      role,
    };
    if (memoryAt.has(memory.recordId)) continue;
    memoryAt.set(memory.recordId, memory.at);
    memories.push(memory);
  }
  report.memories = memories.length;
  if (memories.length < PROFILE_MIN_MENTIONS) {
    // 记忆被删/被清过：不写水位（下一 tick 若又够 3 条还能再试）。
    return report;
  }

  // 生产实测（2026-11-08 14:37 tick）：迁移期写入的人只有 `role=subject`、没有 platform 绑定，
  // 于是每一条记忆都判 `speakerIsSelf=false`，模型给的字段被 `not_speaker_self` 全量丢弃 ——
  // 烧了一次 LLM、写 0 条、还把水位推了。这类人「凭现有证据永远不会产出」，
  // 应先于模型调用就退出，且不写水位（等他有了平台绑定或本人发言记录再试）。
  if (!memories.some((m) => m.speakerIsSelf)) {
    report.error = "no_self_speech";
    return report;
  }

  const personaRows = (await store.listSoulPersona?.(tenant)) ?? [];
  const profileRows = personaRows.filter(
    (it) => it.layer === "human" && !it.validTo && metaPersonKey(it) === candidate.personKey,
  );
  const existing: ExistingProfileField[] = [];
  const existingByRowId = new Map<string, { item: PersonaItem; field: PersonProfileField }>();
  const currentByField = new Map<PersonProfileField, PersonaItem>();
  for (const item of profileRows) {
    const meta = profileMetaOf(item);
    const fieldRaw = meta?.profileField;
    if (!isPersonProfileField(fieldRaw)) continue;
    const field = fieldRaw;
    existing.push(toExistingField(item, field));
    existingByRowId.set(item.itemId, { item, field });
    // 同一字段多行（历史遗留）：留最新的一行当「现行」。
    const prev = currentByField.get(field);
    if (!prev || prev.updatedAt < item.updatedAt) currentByField.set(field, item);
  }

  const edges = (await store.listSoulPersonRelations?.(tenant, { subjKey: candidate.personKey })) ?? [];
  const edgeList = edges.map(toExistingRelation).filter((e): e is ExistingRelationEdge => e !== null);
  // 反向边（别人指向他）也要进提示词：A5 的归并判据需要看到它们。
  const inbound = (await store.listSoulPersonRelations?.(tenant, { objKey: candidate.personKey })) ?? [];
  for (const row of inbound) {
    const edge = toExistingRelation(row);
    if (!edge) continue;
    if (edgeList.some((e) => e.relId === edge.relId)) continue;
    edgeList.push(edge);
  }

  const prompt = buildPersonProfilePrompt({
    personKey: candidate.personKey,
    displayName: person.displayName,
    aliases: person.aliases,
    now,
    existing,
    relationCandidates: edgeList,
    knownPersons,
    memories,
  });

  let raw: string;
  try {
    raw = await runner.run({
      prompt,
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      taskId: `${PROFILE_TASK_ID}:${candidate.personKey}`,
      timeoutMs: opts.timeoutMs ?? DEFAULT_PROFILE_TIMEOUT_MS,
      maxTokens: PROFILE_MAX_TOKENS,
    });
  } catch (err) {
    report.error = `llm: ${err instanceof Error ? err.message : String(err)}`;
    opts.logger?.warn?.(`[person-profile] llm failed key=${candidate.personKey}: ${report.error}`);
    return report;
  }

  let validated;
  try {
    const parsed = parsePersonProfileOutput(raw);
    // obj.key 缺省时按名字落人，再进校验：这样边能连到真实 person 行，
    // 且 findMergeTarget 能用 key 判「同一件事」，不会每轮重复插边。
    const extraKnown = await resolveRelationObjects(
      parsed.relations,
      { store: input.store, tenant, person, memories },
      opts,
    );
    validated = validatePersonProfileOutput({
      personKey: candidate.personKey,
      fields: parsed.fields,
      relations: parsed.relations,
      memories,
      existing,
      existingRelations: edgeList,
      knownPersons: [...knownPersons, ...extraKnown],
    });
  } catch (err) {
    report.error = `parse: ${err instanceof Error ? err.message : String(err)}`;
    opts.logger?.warn?.(`[person-profile] parse failed key=${candidate.personKey}: ${report.error}`);
    return report;
  }

  const fieldWrite = buildFieldWrites({
    personKey: candidate.personKey,
    displayName: person.displayName,
    now,
    trigger,
    fields: validated.fields,
    existingByRowId,
    currentByField,
    memoryAt,
  });
  // 字段侧还会在写库那一步丢（如 dislikes 证据不足）：和校验丢弃合并计数，口径只有一处。
  const dropped = [...validated.dropped, ...fieldWrite.drops];
  report.dropped = dropped.length;
  report.byReason = countDropReasons(dropped);

  const relationWrite = buildRelationWrites({
    personKey: candidate.personKey,
    tenantKey: tenantKeyOf(tenant),
    now,
    relations: validated.relations,
    memoryAt,
  });

  try {
    if (fieldWrite.items.length > 0) {
      if (!store.commitSoulPersona) throw new Error("commitSoulPersona unavailable");
      await store.commitSoulPersona(tenant, { upsert: fieldWrite.items, ledger: fieldWrite.ledger });
    }
    if (
      relationWrite.insert.length > 0 ||
      relationWrite.appendEvidence.length > 0 ||
      relationWrite.close.length > 0
    ) {
      if (!store.commitSoulPersonRelations) throw new Error("commitSoulPersonRelations unavailable");
      await store.commitSoulPersonRelations(tenant, {
        insert: relationWrite.insert,
        appendEvidence: relationWrite.appendEvidence,
        close: relationWrite.close,
      });
    }
  } catch (err) {
    report.error = `commit: ${err instanceof Error ? err.message : String(err)}`;
    opts.logger?.warn?.(`[person-profile] commit failed key=${candidate.personKey}: ${report.error}`);
    return report;
  }

  report.fields = fieldWrite.written;
  report.relations = relationWrite.insert.length + relationWrite.appendEvidence.length;
  report.outdated = fieldWrite.outdated + relationWrite.close.length;

  // A8：落库成功才写水位；失败路径在上面 return 掉，所以这里写就是「成功」的定义。
  try {
    await store.markSoulPersonProfileAt?.(tenant, candidate.personKey, now);
  } catch (err) {
    // 水位写失败不回滚已写入的档案（档案本身是对的），下一 tick 最多重复提炼一次。
    opts.logger?.warn?.(
      `[person-profile] watermark failed key=${candidate.personKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return report;
}

// ============================
// 入口
// ============================

/** 跑一轮提炼。失败不抛：整轮的失败面进 report（soul 主流程不该被档案通道带崩）。 */
export async function runPersonProfileDistill(
  runner: LLMRunner,
  input: PersonProfileRunInput,
  opts: PersonProfilerOptions = {},
): Promise<PersonProfileReport> {
  const report = emptyReport();
  const { store, tenant, now } = input;
  try {
    const persons = (await store.listSoulPersons?.(tenant)) ?? [];
    const stats = (await store.listPersonProfileStats?.(tenant)) ?? [];
    const watermarks = (await store.listSoulPersonProfileWatermarks?.(tenant)) ?? [];
    if (persons.length === 0 || stats.length === 0) return report;

    const pick = pickPersonProfileTargets({ persons, stats, watermarks, now, maxPersons: input.maxPersons });
    report.candidates = pick.candidates;
    report.deferred = pick.deferred;
    if (pick.selected.length === 0) return report;

    const byKey = new Map(persons.map((p) => [p.personKey, p]));
    const knownPersons = persons
      .filter((p) => p.personKey !== "")
      .map((p) => ({ key: p.personKey, displayName: p.displayName }));

    for (const candidate of pick.selected) {
      const person = byKey.get(candidate.personKey);
      if (!person) continue;
      report.attempted += 1;
      const one = await runOnePerson(runner, input, candidate, person, knownPersons, opts);
      report.persons.push(one);
      report.fields += one.fields;
      report.relations += one.relations;
      report.outdated += one.outdated;
      report.dropped += one.dropped;
      addReasons(report.byReason, one.byReason);
      // `no_self_speech` 不是失败：这个人的证据里根本没有「他本人说的话」，重试也没用，
      // 只有等他有了平台绑定或本人发言记录才会变。记成 deferred，别把它算进 failed 掩盖真故障。
      if (one.error === "no_self_speech") report.deferred += 1;
      else if (one.error) report.failed += 1;
      else report.completed += 1;
    }
    return report;
  } catch (err) {
    // store 自己炸了（表缺失/读失败）：整轮记一个失败，不抛给 worker。
    opts.logger?.warn?.(`[person-profile] round failed: ${err instanceof Error ? err.message : String(err)}`);
    report.failed += 1;
    return report;
  }
}

/** 绑定 runner 的 profiler（worker 侧依赖注入用）。 */
export function createPersonProfiler(runner: LLMRunner, opts: PersonProfilerOptions = {}): PersonProfiler {
  return (input) => runPersonProfileDistill(runner, input, opts);
}

/** 导出给读面/测试复用：档案行的字段序（与提示词、卡渲染同源）。 */
export const PROFILE_FIELD_ORDER = PERSON_PROFILE_FIELD_ORDER;

/** 导出给读面：字段中文标签（`label`）。 */
export function profileFieldLabel(field: PersonProfileField): string {
  return PERSON_PROFILE_FIELDS[field].label;
}

/** 档案行的 itemId 前缀（读面过滤 / 排查用）。 */
export const PROFILE_ITEM_ID_PREFIX = PROFILE_ITEM_PREFIX;

/** 便于测试断言字符数口径一致。 */
export { charLength };
