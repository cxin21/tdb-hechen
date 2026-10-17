/**
 * T4（方案 Task 4，2026-10-17）：#42 锚打分器 shadow 定标落盘——行为零变化的旁路采集。
 *
 * 与 reflection shadow sink（core/lifecycle/reflection.ts appendShadowCalibrationRow，
 * #ε-定标 ADR0003 D7）同哲学：JSONL 逐行追加（先看分布再定标，不拍脑袋阈值）；
 * fail-safe：任何写错误只 warn 一次（每文件路径一次，进程内降级集），随后静默，
 * 绝不抛进渲染主路径；sync fs（无未处理 rejection）。sink off = 零调用 = 逐位现状。
 * 独立模块原因：hooks/ 不依赖 lifecycle/（引用方向纪律），行形状不同
 * （打分定标行 vs 提案判定行），消耦合不共享实现。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "../types.js";

const degradedPaths = new Set<string>();

/** 追加一行 #42 shadow 定标 jsonl。row 形状（方案 Task 4 Interfaces）：
 * {ts, agentId, threshold, rowsScored:[{valueId,score}], wouldSelect:[valueId],
 *  actuallySelected:[valueId], agree:boolean}——序列化前已是纯 JSON 值。 */
export function appendAnchorShadowRow(file: string, row: Record<string, unknown>, logger?: Logger): void {
  const target = resolve(process.cwd(), file);
  if (degradedPaths.has(target)) return; // 已降级：同一路径不再重试不再刷屏
  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(row)}\n`, "utf8");
  } catch (err) {
    degradedPaths.add(target);
    logger?.warn?.(`[soul-anchor-shadow] write failed (degraded, non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
