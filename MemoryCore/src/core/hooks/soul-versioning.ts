/**
 * 缺口 A · 人设版本与漂移审计（纯函数层）。
 *
 * 设计要点（与 sqlite.ts / soul-assembler.ts 的分工）：
 *  - 版本链的持久化在 store（soul_snapshots 增列 version / parent_hash / reason_code /
 *    reason_detail / slots_json），单调递增与幂等由 store 内同一事务保证；
 *  - 本模块只做「可读面」：把一次渲染拆成 slot 图、对两版做键级 diff、把变更归到受控
 *    枚举原因、按时间窗列版本并逐版给 diff 摘要；
 *  - 不引 jsdiff：payload_json 是渲染全文（时间旅行合同，不改形态），slot 图另存。
 */

/** 变更原因的受控闭集（写入即枚举；自由文本只允许进 detail）。 */
export const SOUL_CHANGE_REASONS = [
  "first-version",
  "identity-discovery",
  "core-values",
  "promise",
  "state",
  "slots",
  "layout",
] as const;

export type SoulChangeReason = (typeof SOUL_CHANGE_REASONS)[number];

export interface SoulSlotSignals {
  slots?: ReadonlyArray<{ slot: string; content: string }>;
  values?: ReadonlyArray<{
    value_id?: string;
    label?: string;
    weight?: number;
    valence?: number | null;
    state?: string;
    node_type?: string;
  }>;
  parts?: ReadonlyArray<string>;
}

export interface SoulSlotDiffEntry {
  key: string;
  before?: string;
  after?: string;
}

export interface SoulSlotDiff {
  added: Array<{ key: string; after: string }>;
  removed: Array<{ key: string; before: string }>;
  changed: Array<{ key: string; before: string; after: string }>;
  unchanged: number;
  /** 内部信号：before 为 null 时说明这是首版（不落库，只用于归因）。 */
  firstVersion?: boolean;
}

import type { CoreTenant } from "../store/types.js";

export interface SoulSnapshotRowLike {
  ts: string;
  content_hash: string;
  version?: number | null;
  parent_hash?: string | null;
  trigger?: string | null;
  reason_detail?: string | null;
  slots_json?: string | null;
  payload_json?: string | null;
}

export interface SoulVersionView {
  version: number;
  ts: string;
  contentHash: string;
  parentHash: string | null;
  reasonCode: string;
  reasonDetail: string;
  diff: SoulSlotDiff;
  summary: string;
}

const DEFAULT_SUMMARY_CHARS = 60;
const MAX_KEY_LIST = 6;

const BLOCK_RE = /<([a-z][a-z0-9-]*)>\n?([\s\S]*?)\n?<\/\1>/g;

/** 把一次渲染的三类信号折成 slot 图：core_memory 槽 / 价值锚 / 渲染块。 */
export function buildSoulSlotMap(signals: SoulSlotSignals): Record<string, string> {
  const map: Record<string, string> = {};
  for (const s of signals.slots ?? []) {
    if (!s?.slot) continue;
    map[`slot:${s.slot}`] = s.content ?? "";
  }
  for (const v of signals.values ?? []) {
    const key = v?.value_id || v?.label;
    if (!key) continue;
    const bits: string[] = [v.label || key];
    if (typeof v.weight === "number") bits.push(`w=${v.weight}`);
    if (typeof v.valence === "number") bits.push(`v=${v.valence}`);
    if (v.state) bits.push(`state=${v.state}`);
    if (v.node_type) bits.push(`type=${v.node_type}`);
    map[`value:${key}`] = bits.join(" ");
  }
  for (const part of signals.parts ?? []) {
    if (typeof part !== "string") continue;
    BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BLOCK_RE.exec(part)) !== null) {
      map[`block:${m[1]}`] = m[2] ?? "";
    }
  }
  return map;
}

function summarizeValue(value: string, summaryChars: number): string {
  const oneLine = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= summaryChars) return oneLine;
  return `${oneLine.slice(0, summaryChars)}…`;
}

/** 键级 diff：added / removed / changed 三类 + 未变计数（值只留摘要）。 */
export function diffSoulSlots(
  before: Record<string, string> | null | undefined,
  after: Record<string, string>,
  opts?: { summaryChars?: number },
): SoulSlotDiff {
  const limit = opts?.summaryChars ?? DEFAULT_SUMMARY_CHARS;
  const prev = before ?? null;
  const out: SoulSlotDiff = { added: [], removed: [], changed: [], unchanged: 0, firstVersion: prev === null };
  const prevMap = prev ?? {};
  const keys = Array.from(new Set([...Object.keys(prevMap), ...Object.keys(after)])).sort();
  for (const key of keys) {
    const hadBefore = Object.prototype.hasOwnProperty.call(prevMap, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (!hadBefore && hasAfter) {
      out.added.push({ key, after: summarizeValue(after[key] ?? "", limit) });
    } else if (hadBefore && !hasAfter) {
      out.removed.push({ key, before: summarizeValue(prevMap[key] ?? "", limit) });
    } else if ((prevMap[key] ?? "") !== (after[key] ?? "")) {
      out.changed.push({
        key,
        before: summarizeValue(prevMap[key] ?? "", limit),
        after: summarizeValue(after[key] ?? "", limit),
      });
    } else {
      out.unchanged += 1;
    }
  }
  return out;
}

export function isSoulDiffEmpty(diff: SoulSlotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** 变更键（三类合并，去重排序）。 */
export function soulDiffKeys(diff: SoulSlotDiff): string[] {
  return Array.from(
    new Set([...diff.added.map((e) => e.key), ...diff.removed.map((e) => e.key), ...diff.changed.map((e) => e.key)]),
  ).sort();
}

const IDENTITY_KEYS = ["slot:self_identity", "slot:identity", "block:soul-identity"];
const CORE_VALUE_KEYS = ["slot:core_value", "slot:strict_rule", "value:"];
const PROMISE_KEYS = ["slot:promise*"];
const STATE_KEYS = ["block:soul-feeling", "slot:state", "slot:feeling"];

/** 把一次变更归到受控枚举（顺序即优先级），细节进 detail。 */
export function classifySoulChange(
  diff: SoulSlotDiff,
  opts?: { previousSlotsAvailable?: boolean },
): { code: SoulChangeReason; detail: string } {
  if (opts?.previousSlotsAvailable === false) {
    return { code: "slots", detail: "previous-slots-unavailable" };
  }
  const keys = soulDiffKeys(diff);
  if (keys.length === 0) {
    return { code: "layout", detail: "render-layout-changed" };
  }
  if (diff.firstVersion === true) {
    return { code: "first-version", detail: `keys=${keys.slice(0, MAX_KEY_LIST).join(",")}` };
  }
  const has = (prefixes: string[]): boolean =>
    keys.some((k) =>
      prefixes.some((p) =>
        p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : p.endsWith(":") ? k.startsWith(p) : k === p,
      ),
    );
  const code: SoulChangeReason = has(IDENTITY_KEYS)
    ? "identity-discovery"
    : has(CORE_VALUE_KEYS)
      ? "core-values"
      : has(PROMISE_KEYS)
        ? "promise"
        : has(STATE_KEYS)
          ? "state"
          : "slots";
  return { code, detail: `keys=${keys.slice(0, MAX_KEY_LIST).join(",")}` };
}

/** 一行可读摘要：计数 + 变更键（不展开原始值）。 */
export function summarizeSoulDiff(diff: SoulSlotDiff): string {
  const keys = soulDiffKeys(diff);
  return [
    `changed=${diff.changed.length}`,
    `added=${diff.added.length}`,
    `removed=${diff.removed.length}`,
    `unchanged=${diff.unchanged}`,
    `keys=${keys.slice(0, MAX_KEY_LIST).join(",") || "-"}`,
  ].join(" ");
}

/** slots_json 解析容错：非法 / 数组 / 空 / null 一律 {}（历史行反填前不得炸读侧）。 */
export function parseSoulSlotMap(json: string | null | undefined): Record<string, string> {
  if (typeof json !== "string" || json.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** 按时间窗列版本：逐版给 parentHash / 归因 / 对上一版的 diff（行序 = id ASC）。 */
export function listSoulVersions(
  rows: ReadonlyArray<SoulSnapshotRowLike>,
  opts?: { fromTs?: string; toTs?: string; limit?: number },
): SoulVersionView[] {
  const views: SoulVersionView[] = [];
  let prevMap: Record<string, string> | null = null;
  let prevHash: string | null = null;
  const ordered = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  ordered.forEach((row, idx) => {
    const map = parseSoulSlotMap(row.slots_json ?? null);
    const diff = diffSoulSlots(prevMap, map);
    const parentHash = row.parent_hash ?? prevHash;
    views.push({
      version: typeof row.version === "number" && row.version > 0 ? row.version : idx + 1,
      ts: row.ts,
      contentHash: row.content_hash,
      parentHash,
      reasonCode: row.trigger && row.trigger.trim() !== "" ? row.trigger : "layout",
      reasonDetail: row.reason_detail ?? "",
      diff,
      summary: summarizeSoulDiff(diff),
    });
    prevMap = map;
    prevHash = row.content_hash;
  });
  let out = views;
  if (opts?.fromTs) out = out.filter((v) => v.ts >= opts.fromTs!);
  if (opts?.toTs) out = out.filter((v) => v.ts <= opts.toTs!);
  if (typeof opts?.limit === "number" && opts.limit > 0) out = out.slice(-opts.limit);
  return out;
}

export interface SoulVersionQueryResult {
  versions: SoulVersionView[];
  notes: string[];
}

/** 查询面：按时间窗列版本 + 每版 diff 摘要（store 缺实现时如实降级并留 note，不静默）。 */
export async function querySoulVersions(
  store: { listSoulSnapshots?: (tenant: CoreTenant, limit?: number) => unknown },
  tenant: CoreTenant,
  opts?: { fromTs?: string; toTs?: string; limit?: number; scanLimit?: number },
): Promise<SoulVersionQueryResult> {
  const notes: string[] = [];
  if (typeof store.listSoulSnapshots !== "function") {
    notes.push("snapshot-surface-unavailable: store 未实现 listSoulSnapshots，版本段降级为空");
    return { versions: [], notes };
  }
  const rows = (await Promise.resolve(store.listSoulSnapshots(tenant, opts?.scanLimit ?? 1000))) ?? [];
  const list = (Array.isArray(rows) ? rows : []) as SoulSnapshotRowLike[];
  const versions = listSoulVersions(list, { fromTs: opts?.fromTs, toTs: opts?.toTs, limit: opts?.limit });
  return { versions, notes };
}
