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
