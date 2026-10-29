/**
 * #134 / #137 生产写面策略（W1 事实键 / W1-C 事实通道 / W2 写时双时态 supersession）。
 *
 * 设计取舍：生产 L1 的写入是「LLM 抽取后的记忆」而非 bench 的 turn 原文，因此事实来源 =
 *  ① **抽取侧 facts（#137）**：l1-extractor 在 memory.extraction.facts.enabled 时每条记忆
 *    多输出 2-5 条自足短语，落 metadata.facts（可选三元组落 metadata.factTriples）；
 *  ② **dedup 顺带抽取的 metadata.subject**：单短语回退源（P3-T17，零额外 LLM 成本）。
 * 两种形态（memory.write.factKey.mode）：
 *  - "replace"：原文 + 事实拼**同一条** embedding 键（W1 旧形态）。#147 实测键替换无净收益
 *    （判对 −2.2pp ns），且事实短语把「同主题」的行拉近、稀释「同实体不同时间」的判别信号
 *    （knowledge-update/temporal 掉点）——保留仅为回滚/对照，不再作为推荐形态。
 *  - "channel"（#137）：**原文主索引逐位不动**，事实短语单独 embed 成平行通道向量（写侧
 *    l1-writer 走 upsertL1FactVector），召回侧只扩召回、不裁决排序。
 * 开关仍在 memory.write.*（config.ts）；缺省全关（逐位现状）。
 */
import {
  buildEmbeddingKey,
  buildFactChannelKey,
  clampMaxFacts,
  DEFAULT_MAX_FACTS,
  factKeyPhrases,
  mergeFactTriples,
  normalizeFactPhrases,
  type FactNormalizeOptions,
  type NormalizedFacts,
} from "./fact-key.js";
import { classifyContentCardinality, isSupersessionEligible } from "./cardinality.js";
import type { FactCardinality } from "./cardinality.js";
import type { FactRowOptions } from "./fact-row.js";

/** #137：事实键形态（"replace" = 旧 W1 键替换；"channel" = 平行通道）。 */
export type FactKeyMode = "replace" | "channel";

export interface WriteFactKeyConfig {
  enabled: boolean;
  /** 缺省 "replace"（不静默改变既有语义）。 */
  mode?: FactKeyMode;
  separator: string;
  maxFactChars: number;
  /** #137：最多拼几条事实短语（缺省 5）。 */
  maxFacts?: number;
  /** #137：三元组展开成短语一起进键（缺省 false）。 */
  includeTriples?: boolean;
  /** #137：只对这些 type 建键（空/缺省 = 全类型；例 ["work_fact"]）。 */
  onlyForTypes?: string[];
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

/**
 * #146（W2b）事实级一行策略：抽取器直出三元组时，一个记忆拆成多条事实行落库。
 * 关 = 逐位现状（一个记忆一行）。
 */
export interface WriteFactRowsConfig {
  enabled: boolean;
  /** 事实行条数上限（缺省取全局 DEFAULT_MAX_FACTS；与事实键共用唯一 clamp）。 */
  maxFacts?: number;
}

export interface WritePolicy {
  factKey: WriteFactKeyConfig;
  supersession: WriteSupersessionConfig;
  /** #146：事实级粒度（缺省关 = 逐位现状）。 */
  factRows?: WriteFactRowsConfig;
}

/** 缺省策略：全关 = 与既有行为逐位一致（生产安全缺省）。 */
export const DEFAULT_WRITE_POLICY: WritePolicy = {
  factKey: {
    enabled: false,
    mode: "replace",
    separator: " | ",
    maxFactChars: 240,
    maxFacts: 5,
    includeTriples: false,
    onlyForTypes: [],
  },
  supersession: { enabled: false },
};

/** 事实键配置 → 归一化选项（单点换算，写侧读侧同口径；maxFacts 走全局唯一 clamp）。 */
function factNormalizeOptionsOf(fk: WriteFactKeyConfig): FactNormalizeOptions & { includeTriples: boolean } {
  return {
    maxFacts: clampMaxFacts(fk.maxFacts ?? DEFAULT_MAX_FACTS),
    includeTriples: fk.includeTriples === true,
  };
}

interface RawWriteFacts {
  /** metadata.facts 原始值（string / {phrase} / {subject,predicate,value} 混排）。 */
  facts: unknown;
  /** metadata.factTriples 原始值（#137 三元组旁路）。 */
  triples: unknown;
  /** metadata.subject（dedup 顺带抽取的单短语回退源）。 */
  subject?: string;
}

function rawWriteFactsOf(memory: { metadata?: unknown } | undefined | null): RawWriteFacts {
  const md = memory?.metadata;
  if (!md || typeof md !== "object") return { facts: [], triples: [] };
  const o = md as Record<string, unknown>;
  const subject = typeof o.subject === "string" ? o.subject.trim() : "";
  return { facts: o.facts, triples: o.factTriples, ...(subject ? { subject } : {}) };
}

/**
 * 写时可用的事实集合（#137 多来源）：metadata.facts（多短语）∪ metadata.factTriples
 * ∪ metadata.subject 回退。全部过归一化（去重/去噪/条数上限）——宁缺毋滥。
 */
export function writeFactSetOf(
  memory: { metadata?: unknown } | undefined | null,
  opts: FactNormalizeOptions & { includeTriples?: boolean } = {},
): NormalizedFacts {
  const raw = rawWriteFactsOf(memory);
  const normalized = normalizeFactPhrases(raw.facts, opts);
  // 三元组来源：facts[] 内联的 {subject,predicate,value} ∪ metadata.factTriples（去重单源）
  const triples = mergeFactTriples([raw.facts, raw.triples], opts);
  const phrases = normalizeFactPhrases(
    [...normalized, ...(raw.subject ? [raw.subject] : [])],
    opts,
  );
  return { phrases, triples };
}

/** 取写时可用的事实短语（多事实 + subject 回退；无/空白 → 空数组）。 */
export function writeFactsOf(
  memory: { metadata?: unknown } | undefined | null,
  opts: FactNormalizeOptions & { includeTriples?: boolean } = {},
): string[] {
  return factKeyPhrases(writeFactSetOf(memory, opts), opts.includeTriples === true, opts);
}

/**
 * 键文本（both 形态共用）：replace = 原文 + 事实；channel = 原文逐位返回（主索引不动）。
 * 关或缺事实 → 逐位返回 content。
 */
export function embeddingKeyFor(
  content: string,
  memory: { metadata?: unknown } | undefined | null,
  policy?: WritePolicy,
): string {
  const fk = policy?.factKey;
  if (!fk?.enabled) return content;
  // #137：channel 形态下原文主索引必须逐位不动——事实走独立通道向量，不进这条键。
  if ((fk.mode ?? "replace") === "channel") return content;
  const opts = factNormalizeOptionsOf(fk);
  return buildEmbeddingKey(content, writeFactsOf(memory, opts), {
    separator: fk.separator,
    maxFactChars: fk.maxFactChars,
  });
}

/**
 * #137（channel 档）：事实通道键文本。
 * 关 / 形态为 replace / 类型不在 onlyForTypes / 事实为空 → ""（调用方据此零外呼、通道退出）。
 */
export function factChannelKeyFor(
  record: { type?: string } | undefined | null,
  memory: { metadata?: unknown } | undefined | null,
  policy?: WritePolicy,
): string {
  const fk = policy?.factKey;
  if (!fk?.enabled || (fk.mode ?? "replace") !== "channel") return "";
  const only = fk.onlyForTypes ?? [];
  if (only.length > 0) {
    const t = record?.type;
    if (typeof t !== "string" || !only.includes(t)) return "";
  }
  const opts = factNormalizeOptionsOf(fk);
  const set = writeFactSetOf(memory, opts);
  return buildFactChannelKey(set, {
    separator: fk.separator,
    maxFactChars: fk.maxFactChars,
    maxFacts: opts.maxFacts,
    includeTriples: opts.includeTriples,
  });
}

/** #146：事实级粒度开关——true = 有可用三元组时一条事实一行（方案 A）。 */
export function factRowsEnabled(policy?: WritePolicy): boolean {
  return policy?.factRows?.enabled === true;
}

/** #146：事实行归一化/裁决选项（条数上限走全局唯一 clamp；缺省基数沿用 supersession 配置）。 */
export function factRowOptionsOf(policy?: WritePolicy): FactRowOptions {
  return {
    maxFacts: clampMaxFacts(policy?.factRows?.maxFacts ?? policy?.factKey?.maxFacts ?? DEFAULT_MAX_FACTS),
    cardinalityDefault: policy?.supersession?.cardinalityDefault,
  };
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
