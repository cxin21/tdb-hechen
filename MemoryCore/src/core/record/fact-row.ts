/**
 * #146（W2b 事实级双时态，方案 A）：一条事实一行。
 *
 * 背景：#134/#136 的失效落点是**整行**——一个 turn 里有多条事实时，单值属性的一次真更新
 * 会把同一行里的兄弟事实一起软失效（降权甚至条件硬丢）。#136 把爆炸半径从"永久丢失"压到
 * "排序降权"，但没有结构性消除。本模块把写面粒度降到事实级：
 *   - 抽取器直出三元组 {subject,predicate,value,phrase?,cardinality?}；
 *   - 每条事实单独一行 L1（content = 自足短语），metadata 带 subject/predicate/cardinality/
 *     fact_key/fact_of，双时态两端 valid_start/valid_end 与 #134 同口径；
 *   - 失效只按（实体，属性）命中同键的**那一条**（factKeyOf），同 turn 其它事实行不受影响。
 *
 * 纪律（与 #134/#136 一致）：
 *   - 纯函数，不碰 store；写侧拿 plan 去落库；
 *   - 三元组缺 subject/predicate 不进事实行（宁缺毋滥，不猜）——调用方回退整行写入；
 *   - 同一记忆内同键多值只留**首见**（与 computeSupersessions 的 seenThisTurn 同口径，
 *     避免同一批写入自伤）；
 *   - 基数缺省判定复用 classifyCardinality 阶梯（启发式仅兜底，抽取器显式标注优先）。
 */

import { classifyCardinality } from "./cardinality.js";
import type { FactCardinality } from "./cardinality.js";
import { mergeFactTriples, tripleToPhrase } from "./fact-key.js";
import type { FactNormalizeOptions, FactTriple } from "./fact-key.js";
import { factKeyOf } from "./supersession.js";

/** 事实行 metadata 键（读侧/测试/运维走查的唯一口径，禁止散落字面量）。 */
export const FACT_ROW_META = {
  /** 父记忆 id（事实行由哪条记忆派生；同 turn 事实可据此聚合回原文）。 */
  factOf: "fact_of",
  /** 事实在该父记忆内的序号（0 起；0 号行沿用父记忆 id，图边有落点）。 */
  factIndex: "fact_index",
  subject: "subject",
  predicate: "predicate",
  cardinality: "cardinality",
  /** 事实键（factKeyOf(subject,predicate)）——写时按它定位同属性旧行。 */
  factKey: "fact_key",
  /**
   * 本行事实的值（#166）：读侧 present-intent 值级遮蔽需要它来校验「替换文本是否仍含旧值」。
   * 旧库行没有该字段时，读侧回退解析 factTriples[0].value（向后兼容，不重写库）。
   */
  value: "fact_value",
  /**
   * 单条事实陈述（自足短语）。**行 content 不是它**：检索/注入单位是 turn
   * （见 ADR-0015 决定 2「存储按事实、检索与呈现按 turn」），content 存父 turn 原文，
   * 事实短语落在本字段，供审计/读侧按事实判效期与展示。
   */
  factPhrase: "fact_phrase",
} as const;

/**
 * 读一行 metadata 的事实值：fact_value 优先，旧库行回退 factTriples[0].value。
 * 读侧唯一入口（#166 值级遮蔽需要用它校验替换文本；禁止在调用点散写键名）。
 */
export function factValueOfMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.[FACT_ROW_META.value];
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  const triples = meta?.factTriples;
  if (!Array.isArray(triples)) return undefined;
  for (const triple of triples) {
    const value = (triple as { value?: unknown } | null)?.value;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** 一条待落库的事实行（纯数据，不含 id/时间等写入上下文）。 */
export interface FactRowSpec {
  /** 自足事实陈述（phrase 优先；缺省 subject predicate value 机械拼接）。 */
  content: string;
  subject: string;
  predicate: string;
  value: string;
  /** 基数裁决（显式标注优先，缺省走 classifyCardinality 阶梯）。 */
  cardinality: FactCardinality;
  /** 裁决理由（explicit / single-cue:x / multi-cue:x / value-list / default-single）。 */
  cardinalityReason: string;
  /** 同属性键：factKeyOf(subject, predicate)。 */
  factKey: string;
}

export interface FactRowPlan {
  rows: FactRowSpec[];
  /** 同记忆内同键被丢弃的条数（可观测，不静默）。 */
  dropped: number;
  /** 有可用三元组（false = 调用方应回退整行写入，零行为变化）。 */
  hasFacts: boolean;
}

export interface FactRowOptions extends FactNormalizeOptions {
  /** 启发式落到 default-single 时的缺省基数（配置 memory.write.supersession.cardinalityDefault）。 */
  cardinalityDefault?: FactCardinality;
}

/**
 * 规划事实行：接受任意原始抽取形状（字符串短语 / {phrase} / {subject,predicate,value,...}），
 * 只保留 subject+predicate 齐备的三元组，一条一行。
 *
 * **去重口径按基数分档**（否则会静默丢事实）：
 *  - single（函数依赖）：同 (subject,predicate) 只留首见——同一属性同刻只能一个值，
 *    留下两个会让写前失效（先失效后写）对同批新行失效，库里出现两个有效值；
 *  - multi（可并存）：去重键必须含 value（与 fact-key.ts 的 factDedupeKeyOf 一致）——
 *    用 (subject,predicate) 去重会把「喜欢徒步」和「喜欢摄影」吞成一条（评审实测 dropped=1）。
 * 因此基数裁决必须在去重之前，不能反过来。
 */
export function planFactRows(raw: unknown, opts: FactRowOptions = {}): FactRowPlan {
  const triples: FactTriple[] = mergeFactTriples([raw], opts);
  return planFactRowsFromTriples(triples, opts);
}

/** 从已归一的 metadata（facts ∪ factTriples）规划事实行。 */
export function planFactRowsFromMetadata(metadata: Record<string, unknown> | undefined, opts: FactRowOptions = {}): FactRowPlan {
  const meta = metadata ?? {};
  const triples = mergeFactTriples([meta.facts, meta.factTriples], opts);
  return planFactRowsFromTriples(triples, opts);
}

function planFactRowsFromTriples(triples: readonly FactTriple[], opts: FactRowOptions): FactRowPlan {
  const seen = new Set<string>();
  const rows: FactRowSpec[] = [];
  let dropped = 0;
  for (const t of triples) {
    const factKey = factKeyOf(t.subject, t.predicate);
    const verdict = classifyCardinality(t.predicate, t.value, t.cardinality);
    const cardinality = verdict.reason === "default-single" && opts.cardinalityDefault === "multi"
      ? ("multi" as FactCardinality)
      : verdict.cardinality;
    const reason = cardinality === verdict.cardinality ? verdict.reason : "default-multi";
    // 去重键：multi 带 value（可并存），single 只按 (subject,predicate)（函数依赖，留首见）。
    const key = cardinality === "multi" ? factKey + "\u0000" + t.value : factKey;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    rows.push({
      content: t.phrase && t.phrase.trim() ? t.phrase.trim() : tripleToPhrase(t),
      subject: t.subject,
      predicate: t.predicate,
      value: t.value,
      cardinality,
      cardinalityReason: reason,
      factKey,
    });
  }
  return { rows, dropped, hasFacts: rows.length > 0 };
}

/**
 * 事实行 id：0 号行沿用父记忆 id（记忆图/证据链的既有落点不悬空），其余加 `#f<n>` 后缀。
 * 确定性 id = 同一记忆重写幂等（upsert 覆盖，不产生重复行）。
 */
export function factRowIdOf(parentId: string, index: number): string {
  return index <= 0 ? parentId : `${parentId}#f${index + 1}`;
}

/** 事实行 id 的逆：去掉 `#f<n>` 后缀回到父 turn（`factRowIdOf` 的单一源对称函数）。 */
export function parentTurnIdOf(recordId: string): string {
  return recordId.replace(/#f\d+$/, "");
}

/**
 * 事实行 metadata：父记忆的 metadata 之上写事实级字段，并让 facts/factTriples 只含本行事实——
 * 事实键构造（embeddingKeyFor / factChannelKeyFor）由此自动按单条事实走，无需额外分支。
 */
export function factRowMetadata(
  row: FactRowSpec,
  ctx: { parentId: string; index: number; validStart?: string },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    [FACT_ROW_META.subject]: row.subject,
    [FACT_ROW_META.predicate]: row.predicate,
    [FACT_ROW_META.cardinality]: row.cardinality,
    [FACT_ROW_META.factKey]: row.factKey,
    [FACT_ROW_META.value]: row.value,
    [FACT_ROW_META.factOf]: ctx.parentId,
    [FACT_ROW_META.factIndex]: ctx.index,
    [FACT_ROW_META.factPhrase]: row.content,
    facts: [row.content],
    factTriples: [
      { subject: row.subject, predicate: row.predicate, value: row.value, cardinality: row.cardinality, phrase: row.content },
    ],
  };
  if (ctx.validStart) metadata.valid_start = ctx.validStart;
  return metadata;
}

/** 该行是不是事实行（读侧/走查/迁移用；缺省 = 普通整行记忆）。 */
export function isFactRowMetadata(metadata: Record<string, unknown> | undefined | null): boolean {
  const parent = metadata?.[FACT_ROW_META.factOf];
  return typeof parent === "string" && parent.trim() !== "";
}

/** 事实行是否参与写时失效（只有单值属性；多值 additive 永不失效——#136 契约）。 */
export function isFactRowSupersedable(row: FactRowSpec): boolean {
  return row.cardinality === "single";
}
