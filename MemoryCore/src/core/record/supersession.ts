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

function normKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * #146：事实键（实体 + 属性）唯一构造点——supersession 推演与事实级写时失效共用同一口径，
 * 否则写侧按一套键失效、读侧按另一套判新旧，事实级双时态就会静默错位。
 */
export function factKeyOf(subject: string, predicate: string): string {
  return normKeyPart(subject) + "\u0000" + normKeyPart(predicate);
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
      const verdict = f.cardinality
        ? { cardinality: f.cardinality, reason: "explicit" }
        : classifyCardinality(predicate, value);
      if (cardinalityGate && !isSupersessionEligible(verdict.cardinality)) continue;

      const key = factKeyOf(subject, predicate);
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
