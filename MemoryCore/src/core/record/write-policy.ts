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
import { classifyContentCardinality, isSupersessionEligible } from "./cardinality.js";
import type { FactCardinality } from "./cardinality.js";

export interface WriteFactKeyConfig {
  enabled: boolean;
  separator: string;
  maxFactChars: number;
}

export interface WriteSupersessionConfig {
  enabled: boolean;
  /**
   * #136 属性契约门控（缺省 true）。false = #136 前逐位行为：update/merge 的旧行一律失效。
   * 开启时多值/模态内容不失效——新增事实是 additive，旧行保持有效（两行并存）。
   */
  cardinalityGate?: boolean;
  /** 内容级判定无线索时的缺省基数（缺省 "single" 保覆盖；"multi" = 保守不失效）。 */
  cardinalityDefault?: FactCardinality;
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

/**
 * #136：生产写侧的内容级基数门控——旧行到底该不该失效。
 * 生产 L1 的 content 是 LLM 抽取后的整句记忆（没有 predicate 字段），因此：
 *  - 命中单值线索（粉丝数/价格/城市/电话…）→ 允许失效（knowledge-update 依赖它）；
 *  - 命中多值/模态线索（考虑/想/计划/喜欢…）→ 不失效（新事实 additive，旧行留着）；
 *  - 无线索 → 缺省允许（缺省单值 = 保覆盖）；配置 cardinalityDefault="multi" 可收紧；
 *  - cardinalityGate === false → 一律允许（逐位旧行为，回滚阀门）。
 */
export function supersessionEligibleForContent(content: string, policy?: WritePolicy): boolean {
  const cfg = policy?.supersession;
  if (cfg?.cardinalityGate === false) return true;
  const verdict = classifyContentCardinality(content ?? "");
  if (!isSupersessionEligible(verdict.cardinality)) return false;
  if (verdict.reason === "default-single" && cfg?.cardinalityDefault === "multi") return false;
  return true;
}
