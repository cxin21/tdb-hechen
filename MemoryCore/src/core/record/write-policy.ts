/**
 * #134 生产写面策略（W1 事实键双写 / W2 写时双时态 supersession）。
 *
 * 设计取舍：生产 L1 的写入是「LLM 抽取后的记忆」而非 bench 的 turn 原文，因此：
 *  - W1 的事实短语来源 = dedup LLM **顺带抽取**的 metadata.subject（P3-T17，零额外 LLM 成本），
 *    与 bench 的离线抽取同构（把查询表述之外的主题词拼进 embedding 键，桥接「同事实不同说法」）；
 *  - W2 的触发点 = dedup 的 update/merge 决策（生产既有的「同实体同属性新值」识别点），
 *    旧行从「归档」改为「valid_end 只标记」——零删除红线在写时也成立。
 * 两者缺省全关（逐位现状）；开关在 memory.write.*（config.ts）。
 */
import { buildEmbeddingKey } from "./fact-key.js";

export interface WriteFactKeyConfig {
  enabled: boolean;
  separator: string;
  maxFactChars: number;
}

export interface WriteSupersessionConfig {
  enabled: boolean;
}

export interface WritePolicy {
  factKey: WriteFactKeyConfig;
  supersession: WriteSupersessionConfig;
}

/** 缺省策略：全关 = 与既有行为逐位一致（生产安全缺省）。 */
export const DEFAULT_WRITE_POLICY: WritePolicy = {
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: false },
};

/** 取写时可用的事实短语（缺省来源 = metadata.subject；无/空白 → 空数组）。 */
export function writeFactsOf(memory: { metadata?: unknown } | undefined | null): string[] {
  const md = memory?.metadata;
  const raw = md && typeof md === "object" ? (md as Record<string, unknown>).subject : undefined;
  if (typeof raw !== "string") return [];
  const t = raw.trim();
  return t ? [t] : [];
}

/** W1：embedding 键文本（关或缺事实 → 逐位返回 content）。 */
export function embeddingKeyFor(
  content: string,
  memory: { metadata?: unknown } | undefined | null,
  policy?: WritePolicy,
): string {
  const fk = policy?.factKey;
  if (!fk?.enabled) return content;
  return buildEmbeddingKey(content, writeFactsOf(memory), {
    separator: fk.separator,
    maxFactChars: fk.maxFactChars,
  });
}

/** W2：update/merge 的旧行处置开关——true = 标记 valid_end（不归档不删除）。 */
export function supersessionEnabled(policy?: WritePolicy): boolean {
  return policy?.supersession?.enabled === true;
}
