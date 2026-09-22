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
