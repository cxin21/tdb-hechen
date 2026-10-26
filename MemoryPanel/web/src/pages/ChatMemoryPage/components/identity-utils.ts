/**
 * identity-utils —— 身份区（U1，DS-SOUL-MEMORY-002 §2.5/§6.5）纯函数：slots 分组与空态判定。
 *
 * identity = 用户身份（我心中的他）；self_identity = agent 自我（我是谁，第一人称）。
 * 渲染顺序沿用 spec §2.7：self 段在前（由 IdentitySection 的渲染顺序保证）。
 * 纯函数、无 DOM 依赖，便于 vitest 直测。
 */

export interface CoreSlotRow {
  slot: string;
  content: string;
  version?: number;
  /** U1 徽标三字段（spec §6.5）：内核 readCore SELECT 已返回（sqlite.ts:2355）。 */
  source?: string;
  updated_at?: string;
}

/** U1 徽标数据形状：仅列 UI 消费的三字段（宁缺毋滥）。 */
export interface IdentityMeta {
  version?: number;
  source?: string;
  updated_at?: string;
}

/** U1 徽标数据纯函数：取同槽**首行**的 version/source/updated_at；
  * 非数组/无匹配槽 → null；匹配行缺字段 → 空对象（诚实缺列，不造假值）。 */
export function identityMetaOf(
  slots: CoreSlotRow[] | null | undefined,
  slot: string,
): IdentityMeta | null {
  if (!Array.isArray(slots)) return null;
  const row = (slots ?? []).find((s) => s && s.slot === slot);
  if (!row) return null;
  const meta: IdentityMeta = {};
  if (typeof row.version === 'number') meta.version = row.version;
  if (typeof row.source === 'string' && row.source.trim() !== '') meta.source = row.source;
  if (typeof row.updated_at === 'string' && row.updated_at.trim() !== '') meta.updated_at = row.updated_at;
  return meta;
}

export interface SplitIdentitySlots {
  self: string[];
  user: string[];
}

/** 按槽位分组身份内容；空/非字符串内容剔除（宁缺毋滥）。 */
export function splitIdentitySlots(slots: CoreSlotRow[]): SplitIdentitySlots {
  const self: string[] = [];
  const user: string[] = [];
  for (const s of slots ?? []) {
    if (!s || typeof s.content !== 'string' || s.content.trim() === '') continue;
    if (s.slot === 'self_identity') self.push(s.content);
    else if (s.slot === 'identity') user.push(s.content);
  }
  return { self, user };
}

/** 双组皆空 → 整段不渲染。 */
export function identityEmpty(user: string[], self: string[]): boolean {
  return self.length === 0 && user.length === 0;
}

// ── #69（R3 配套，Panel 身份区「叙事预览」）──

/** #69 合成叙事槽槽名。仅作为 API 响应的识别键消费（值镜像 MemoryCore
  * IDENTITY_NARRATIVE_SLOT，ADR-0005 单一源在内核）；Panel 不复制模板/组装逻辑。 */
export const IDENTITY_NARRATIVE_SLOT = 'identity_narrative';

/** #69 叙事预览三态：active=叙事生效（绿）；fallback=条目形态（灰；kernel 门关与
  * 生成闸降级在单次读响应中同为条目形态、无信号可分，合一展示并在 UI 说明）；
  * empty=身份内容全空（预览整段不渲染）。 */
export type NarrativePreviewState = 'active' | 'fallback' | 'empty';

export interface NarrativePreview {
  state: NarrativePreviewState;
  /** state='active' 时的叙事合成槽行（source/version/updated_at 供技术细节折叠）。 */
  narrative: CoreSlotRow | null;
  /** fallback 时的身份条目分组（empty 守卫与调试用途）。 */
  entries: SplitIdentitySlots;
}

/** #69 状态判定纯函数（kernel 语义 v2-router.ts:2458-2484）：叙事组装成功时身份两行被
  * 全量替换为合成槽 → active 响应内无条目；门关/降级/无身份内容 → 原条目形态。
  * 叙事槽内容空白视为缺失（宁缺毋滥）；叙事槽与条目并存（kernel 不该出现）叙事优先。 */
export function narrativePreviewOf(slots: CoreSlotRow[] | null | undefined): NarrativePreview {
  const rows = Array.isArray(slots) ? slots : [];
  const narrative =
    rows.find(
      (s) => s && s.slot === IDENTITY_NARRATIVE_SLOT && typeof s.content === 'string' && s.content.trim() !== '',
    ) ?? null;
  const entries = splitIdentitySlots(rows);
  const state: NarrativePreviewState = narrative
    ? 'active'
    : identityEmpty(entries.user, entries.self)
      ? 'empty'
      : 'fallback';
  return { state, narrative, entries };
}

/** #69「存储原文（管理员视角）」口径（与灰态条目视图一致）：只留身份两槽
  * （self_identity/identity）的字符串内容行——strict_rule/core_value 等核心区
  * 其它槽不得混入身份区；identity_narrative 合成槽与非字符串内容一并滤除。 */
export function rawIdentityRowsOf(slots: unknown): CoreSlotRow[] {
  if (!Array.isArray(slots)) return [];
  const rows: CoreSlotRow[] = [];
  for (const s of slots) {
    const row = s as Partial<CoreSlotRow> | null | undefined;
    if (
      row &&
      (row.slot === 'self_identity' || row.slot === 'identity') &&
      typeof row.content === 'string'
    ) {
      rows.push(s as CoreSlotRow);
    }
  }
  return rows;
}
