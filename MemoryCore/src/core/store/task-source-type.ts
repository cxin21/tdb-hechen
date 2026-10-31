/**
 * TaskSourceType —— 任务来源三值契约（#127）。
 *
 * 口径（MemoryPanel 已对齐）：manual（人工创建）/ external（外部系统导入，github/tapd/jira
 * 等统一收敛）/ other（其他）。写路径只产出这三值。
 *
 * 历史值兼容：2.0.x 之前 task/create 的枚举是 manual|github|tapd|other，库里已有这类行。
 * 因此读旧值必须能吃：
 *   - 读侧（DB row → 实体）：normalizeTaskSourceType，github/tapd/jira → external，未知 → other，不抛错；
 *   - 写侧（请求体 → 契约）：canonicalizeTaskSourceTypeInput 作 zod preprocess，别名先归一成
 *     external，再交给 z.enum 三值校验；真正非法的值照旧被拒（→400）。
 *
 * 单一事实源：core/store/types.ts 与 metadata/types.ts 都 re-export 这里的 TaskSourceType；
 * gateway/v2-schemas.ts 与 metadata/router/v3-meta-schemas.ts 的 zod 枚举引用 TASK_SOURCE_TYPES。
 */

export const TASK_SOURCE_TYPES = ["manual", "external", "other"] as const;
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number];

/** 历史/别名来源（小写）→ 三值。它们的语义都是「外部系统导入」。 */
export const LEGACY_TASK_SOURCE_TYPE_ALIASES: Readonly<Record<string, TaskSourceType>> = Object.freeze({
  github: "external",
  tapd: "external",
  jira: "external",
});

function sourceTypeKey(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

/**
 * 写侧 preprocess：别名 → external；三值原样（顺带 trim/lowercase）；其余原样返回，
 * 让 z.enum 拒掉（非法值必须仍是 400，不能被这里悄悄改成 other）。
 */
export function canonicalizeTaskSourceTypeInput(value: unknown): unknown {
  const key = sourceTypeKey(value);
  if (key === null) return value;
  return LEGACY_TASK_SOURCE_TYPE_ALIASES[key] ?? key;
}

/**
 * 读侧归一：任何历史值都能映射成三值；无法识别 → "other"。
 * 读路径 fail-safe（不抛错），保证 Panel 永远不会收到四值枚举里的 github/tapd。
 */
export function normalizeTaskSourceType(value: unknown): TaskSourceType {
  const key = sourceTypeKey(value);
  if (key !== null) {
    if ((TASK_SOURCE_TYPES as readonly string[]).includes(key)) return key as TaskSourceType;
    const alias = LEGACY_TASK_SOURCE_TYPE_ALIASES[key];
    if (alias) return alias;
  }
  return "other";
}
