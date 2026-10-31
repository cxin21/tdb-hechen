import { describe, it, expect } from "vitest";
import { parseConfig } from "../../config.js";

/**
 * task-100（预算内降级）配置面契约：
 *  - v3Recall.l1BudgetMs：缺省 2000（生产 timeoutMs=5000 下留 3s 给 FTS+组装）；
 *    **0 = 关（逐位旧行为）**，负数/非数字 → 缺省，超界 clamp 到 [200,15000]；
 *  - v3Recall.l1Fallback：只认 'none'（只观测不降级），其余一律 'fts'。
 */
const v3 = (v3Recall: Record<string, unknown>) =>
  parseConfig({ recall: { v3Recall: { enabled: true, timeoutMs: 5000, ...v3Recall } } }).recall.v3Recall;

describe("config: v3Recall 预算内降级旋钮（task-100）", () => {
  it("① 缺省 l1BudgetMs=2000 / l1Fallback='fts'（不配也能降级，不靠 yaml 钉子）", () => {
    const d = v3({});
    expect(d.l1BudgetMs).toBe(2000);
    expect(d.l1Fallback).toBe("fts");
  });

  it("② 0 = 关（显式关档逐位旧行为），不 clamp 成 200", () => {
    expect(v3({ l1BudgetMs: 0 }).l1BudgetMs).toBe(0);
  });

  it("③ 越界 clamp：199→200、15000 保留、99999→15000、负数→0（关）", () => {
    expect(v3({ l1BudgetMs: 199 }).l1BudgetMs).toBe(200);
    expect(v3({ l1BudgetMs: 15000 }).l1BudgetMs).toBe(15000);
    expect(v3({ l1BudgetMs: 99999 }).l1BudgetMs).toBe(15000);
    expect(v3({ l1BudgetMs: -5 }).l1BudgetMs).toBe(0);
  });

  it("④ 非数字/NaN → 缺省 2000（不把配置笔误变成 0 = 静默关档）", () => {
    expect(v3({ l1BudgetMs: "abc" }).l1BudgetMs).toBe(2000);
    expect(v3({ l1BudgetMs: Number.NaN }).l1BudgetMs).toBe(2000);
    expect(v3({ l1BudgetMs: null }).l1BudgetMs).toBe(2000);
  });

  it("⑤ l1Fallback 只认 'none'，其余（含笔误）一律 'fts'", () => {
    expect(v3({ l1Fallback: "none" }).l1Fallback).toBe("none");
    expect(v3({ l1Fallback: "FTS" }).l1Fallback).toBe("fts");
    expect(v3({ l1Fallback: "off" }).l1Fallback).toBe("fts");
    expect(v3({ l1Fallback: undefined }).l1Fallback).toBe("fts");
  });

  it("⑥ 小数向下取整（预算只许更紧不许更松：1999.7→1999、200.9→200）", () => {
    expect(v3({ l1BudgetMs: 1999.7 }).l1BudgetMs).toBe(1999);
    expect(v3({ l1BudgetMs: 200.9 }).l1BudgetMs).toBe(200);
  });
});