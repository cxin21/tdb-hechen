/**
 * W2（issue #134）：写时双时态版本治理（Zep 式 supersession）。
 *
 * 契约：同（实体=subject, 属性=predicate）**新值 ≠ 旧值** → 旧事实所在行标记失效
 * （valid_end = 新值所在 turn 的时间戳）；**只标记不删除**——零删除红线，历史可用
 * valid_end 追溯。本模块是纯函数，不碰 store：调用方拿 op 列表调用 store.invalidateL1。
 *
 * 缺省语义：输入无法定序（时间戳缺失/空）的 turn 不参与 supersession（宁缺毋滥）。
 */

import { classifyCardinality, isSupersessionEligible } from "./cardinality.js";
import type { FactCardinality } from "./cardinality.js";
import { normalizeFactAttribute, resolveFactCardinality } from "./fact-attribute.js";
import type { FactTriple } from "./fact-key.js";

/** 事实三元组形状单源在 fact-key.ts（cardinality/phrase 可选）；此处再导出保持既有 import 面。 */
export type { FactTriple } from "./fact-key.js";

export interface SupersessionOptions {
  /**
   * #136 属性契约门控（缺省 true = 修复开启）。false = #136 前逐位行为（凡同键新值都失效）。
   */
  cardinalityGate?: boolean;
}

/** 一个 turn 及其抽取出的事实（时间戳 = turn 的会话时间）。 */
export interface TurnFacts {
  turnId: string;
  timestamp: string;
  facts: readonly FactTriple[];
}

/** 失效标记：把 turnId 行的 valid_end 写成 validEnd（不改内容、不删除）。 */
export interface SupersessionOp {
  /** 被标记失效的旧行（turn id）。 */
  turnId: string;
  /** 失效时刻 = 新值所在的 turn 时间戳（ISO 字符串，可直接写 valid_end）。 */
  validEnd: string;
  /** 产生新值的 turn（审计追溯用）。 */
  supersededByTurnId: string;
  subject: string;
  predicate: string;
  oldValue: string;
  newValue: string;
  /** #136：被取代事实的基数（只有 "single" 会产出 op；审计/复算用）。 */
  cardinality: FactCardinality;
}

/** 英文限定词/物主代词前缀（the user / my city → user / city）。 */
const LEADING_DETERMINER_RE = /^(?:the|a|an|my|our|your|his|her|their)\s+/;
/** 尾随标点（句末句号/冒号/顿号等；中文标点同收）。 */
const TRAILING_PUNCT_RE = /[.;:,!?。，；：、！？]+$/;
/** 英文所有格（user's city → user city）。 */
const POSSESSIVE_RE = /'s\b/g;

/**
 * #146 算法修复②：属性同义归一（canonical attribute）。
 *
 * 为什么必须做：事实键 = (subject, predicate) 的字面量。抽取器直出的 predicate 是自由文本，
 * 同一属性每次措辞不同（"live in" / "lives in" / "city of residence" / "住在"），
 * 字面键永不相等 ⇒ 事实级失效在生产语料上几乎不触发。真实语料实测（1796 条三元组，
 * 1461 个不同 (subject,predicate) 对）只有 219 个跨 turn 重复（15%），其中 142 个含单值裁决
 * ——即约 15% 的事实本来有资格被事实级失效，其余 85% 因为键不撞而永远撞不上。
 *
 * 纪律：只归并**确定同义**的常见属性族（居住地/职业/电话/年龄/价格…），不猜语义；
 * 表外一律走通用归一（小写/裁限定词/裁标点），保持可解释、可审计。
 * 归一后的键同时用于写时失效（invalidateL1ByFactKey）与 supersession 推演——必须同一口径。
 */
const PREDICATE_SYNONYMS: Record<string, string> = {
  // 居住地
  "live in": "residence", "lives in": "residence", "living in": "residence",
  "reside in": "residence", "resides in": "residence", "residing in": "residence",
  "based in": "residence", "is based in": "residence", "located in": "residence",
  location: "residence", residence: "residence", "city of residence": "residence",
  "home city": "residence", "residence city": "residence",
  住在: "residence", 居住城市: "residence", 居住地: "residence", 居住于: "residence",
  // 职业
  job: "occupation", "job title": "occupation", occupation: "occupation",
  profession: "occupation", employment: "occupation",
  职业: "occupation", 职位: "occupation", 工作: "occupation",
  // 电话
  phone: "phone", "phone number": "phone", telephone: "phone", mobile: "phone",
  "mobile phone": "phone", 手机号: "phone", 手机号码: "phone", 电话: "phone",
  // 年龄
  age: "age", 年龄: "age",
  // 价格
  price: "price", cost: "price", 价格: "price", 价钱: "price",
};

/** 通用归一：小写、折叠空白、裁限定词/所有格/尾标点（subject 与 predicate 共用底座）。 */
function normKeyPart(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(POSSESSIVE_RE, "")
    .replace(/\s+/g, " ")
    .replace(LEADING_DETERMINER_RE, "")
    .replace(TRAILING_PUNCT_RE, "")
    .trim();
}

/** 属性段归一：通用底座 + 同义族映射（表外不猜）。 */
function normPredicatePart(s: string): string {
  const base = normKeyPart(s);
  return PREDICATE_SYNONYMS[base] ?? base;
}

/**
 * 事实键（实体 + 属性）唯一构造点——supersession 推演与事实级写时失效共用同一口径，
 * 否则写侧按一套键失效、读侧按另一套判新旧，事实级双时态就会静默错位。
 *
 * #167：抽取期直出受控 attribute 时优先按 (normSubject, attribute) 构造键——谓词是自由
 * 文本（"lives in"/"moved to"/"住在"），同义表打不到；attribute 是封闭词表，跨谓词对齐。
 * 无 attribute（或表外脏值）才回落 #146 的 (normSubject, normPredicate) 口径，旧数据不变。
 * "@attr:" 前缀让属性槽与谓词槽不会因字面同名而误撞。
 */
export function factKeyOf(subject: string, predicate: string, attribute?: string): string {
  const attr = normalizeFactAttribute(attribute);
  return normKeyPart(subject) + "\u0000" + (attr ? "@attr:" + attr : normPredicatePart(predicate));
}

/**
 * 计算写时失效标记（按时间序推演）。
 *
 * 同一行被多次失效时，valid_end 取**最早**一次（行在第一次被取代时即失效）。
 * #136：只有单值属性（cardinality === "single"）参与失效；多值/模态属性是 additive，
 * 新值只追加不取代（否则"粉丝数 1300"会把同行的"住在上海"一起删掉）。
 */
export function computeSupersessions(
  turns: readonly TurnFacts[],
  opts: SupersessionOptions = {},
): SupersessionOp[] {
  const cardinalityGate = opts.cardinalityGate !== false;
  const ordered = turns
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => typeof t.timestamp === "string" && t.timestamp.trim() !== "")
    .sort((a, b) => (a.t.timestamp === b.t.timestamp ? a.i - b.i : a.t.timestamp < b.t.timestamp ? -1 : 1))
    .map(({ t }) => t);

  interface Active {
    turnId: string;
    subject: string;
    predicate: string;
    value: string;
  }
  const active = new Map<string, Active>();
  const ops: SupersessionOp[] = [];

  for (const t of ordered) {
    const seenThisTurn = new Set<string>();
    for (const f of t.facts ?? []) {
      const subject = typeof f?.subject === "string" ? f.subject.trim() : "";
      const predicate = typeof f?.predicate === "string" ? f.predicate.trim() : "";
      const value = typeof f?.value === "string" ? f.value.trim() : "";
      // 事实三要素缺一不可：缺 value 的「事实」无法判定新旧（宁缺毋滥，不猜）。
      if (!subject || !predicate || !value) continue;
      // #136 属性契约：多值属性的新值不取代旧值（不进 active 表，也就永不失效）。
      // #167：基数优先级 受控 attribute > 显式 > 谓词启发式——attribute 来自封闭词表，
      // 词表档位即属性语义（residence 天然 single）；显式是自由文本，只作无 attribute 时的补充。
      const attribute = normalizeFactAttribute(f.attribute);
      // 与写侧 fact-row 共用同一阶梯（resolveFactCardinality），不让读写两套优先级漂移。
      const verdict = resolveFactCardinality(attribute, f.cardinality, classifyCardinality(predicate, value));
      if (cardinalityGate && !isSupersessionEligible(verdict.cardinality)) continue;

      const key = factKeyOf(subject, predicate, attribute);
      // 同一 turn 内同键多值：只认首见，不自伤（turn 是原子写入单元）。
      if (seenThisTurn.has(key)) continue;
      seenThisTurn.add(key);
      const prev = active.get(key);
      if (prev && normKeyPart(prev.value) !== normKeyPart(value)) {
        ops.push({
          turnId: prev.turnId,
          validEnd: t.timestamp,
          supersededByTurnId: t.turnId,
          subject: prev.subject,
          predicate: prev.predicate,
          oldValue: prev.value,
          newValue: value,
          cardinality: verdict.cardinality,
        });
      }
      active.set(key, { turnId: t.turnId, subject, predicate, value });
    }
  }
  return mergeOpsEarliestValidEnd(ops);
}

/** 同一行多次失效 → 合并为一条（valid_end=最早），保持「行在首次被取代时即失效」。 */
function mergeOpsEarliestValidEnd(ops: SupersessionOp[]): SupersessionOp[] {
  const byTurn = new Map<string, SupersessionOp>();
  for (const op of ops) {
    const cur = byTurn.get(op.turnId);
    if (!cur || op.validEnd < cur.validEnd) byTurn.set(op.turnId, op);
  }
  return [...byTurn.values()].sort((a, b) => (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0));
}
