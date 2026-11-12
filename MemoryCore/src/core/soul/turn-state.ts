/**
 * 通道 B（每轮尾巴）的渲染：心境一行 + 未完的事（≤3 条）+ 校准句（有数据才写）。
 *
 * 为什么要单独一层：turn 的预算只有 400 字，而校准句是可选的；
 * 一旦加上就超预算，整句丢掉，不能留半句。这个取舍必须能被单测钉住，
 * 所以从 card-service 里抽出来做成纯函数。
 */
import type { SoulCalibrationRow } from "../store/soul-event-types.js";
import { calibrationLinesFromRows } from "./card-v13.js";
import { OPEN_LOOPS_MAX, PERSONA_TURN_MAX_CHARS } from "./traits.js";

export interface SoulTurnStateInput {
  /** 已渲染好的心境行（可为空）。 */
  moodLine: string;
  /** 未完的事，按优先级排；这里只负责单行化与截到 3 条。 */
  openLoops: ReadonlyArray<string>;
  /** 校准原始行；没有就不写「把握」，也不写死 high/medium。 */
  calibration?: ReadonlyArray<SoulCalibrationRow>;
  maxChars?: number;
}

export interface SoulTurnStateResult {
  text: string;
  openLoops: string[];
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** turn 尾巴：先保心境与未完的事，校准句整句放不下就整句丢。 */
export function renderSoulTurnState(input: SoulTurnStateInput): SoulTurnStateResult {
  const maxChars = input.maxChars ?? PERSONA_TURN_MAX_CHARS;
  const openLoops = input.openLoops.map(oneLine).filter((text) => text !== "").slice(0, OPEN_LOOPS_MAX);
  const pending = openLoops.length > 0 ? `未完的事：${openLoops.join("；")}` : "";
  const mood = input.moodLine.trim();
  const lines = [mood, pending].filter((line) => line !== "");

  const calibration = calibrationLinesFromRows(input.calibration ?? [], { maxDomains: 1 })
    .map((line) => oneLine(line.text))
    .filter((line) => line !== "")
    .map((line) => `记得：${line}`);
  for (const line of calibration) {
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxChars) break; // 留半句比不写更误导，整条丢。
    lines.push(line);
  }

  const text = lines.join("\n");
  return {
    text: text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…",
    openLoops,
  };
}

export { assembleTurnState } from "./turn-state-assembler.js";

