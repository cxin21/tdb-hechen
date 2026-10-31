/**
 * #152 ①：store 能力位守卫（WARN-once）——「能力不支持」必须留下痕迹，不能静默空跑。
 *
 * 背景：l1_fact_vec 等可选通道此前只在调用点做「方法是否存在」的 feature-detect，
 * 方法缺失时直接 return/skip：不报错、不打日志 ⇒ 事实向量写入/检索静默失效
 * （典型表现：事实记忆写进去了，但按语义检索永远查不到，无人知晓原因）。
 *
 * 约定：
 *   - 能力位为 true 才算可用；undefined（老 store / 测试 mock 不回该位）按不可用处理；
 *   - 不可用时由调用点显式 WARN 一次（每 capability+impact 只打一条，避免每轮 recall 刷屏）；
 *   - 消费点（auto-recall / memory-search / l1-writer）接入方式：
 *     if (!ensureL1FactVec(store, logger)) return;  // 跳过 + 已 WARN
 */
import type { StoreCapabilities } from "./types.js";

type Logger = { warn?(msg: string): void; debug?(msg: string): void } | undefined;

/** 已 WARN 过的 capability+impact 组合（进程级；单测用 __resetCapabilityWarnings 清空）。 */
const warnedKeys = new Set<string>();

/**
 * 判定能力位；缺失/false 时打一条 WARN 并返回 false。
 * @param impact 人类可读后果（写进 WARN，说明「什么功能因此被跳过」）
 */
export function ensureCapability(
  caps: StoreCapabilities | undefined | null,
  capability: keyof StoreCapabilities,
  impact: string,
  logger?: Logger,
): boolean {
  if (caps && caps[capability] === true) return true;
  const key = capability + "|" + impact;
  if (!warnedKeys.has(key)) {
    warnedKeys.add(key);
    logger?.warn?.(`[capability] store does not support ${capability} → ${impact}`);
  }
  return false;
}

/**
 * l1_fact_vec 通道守卫：返回 false 表示必须跳过事实向量写入/检索（已 WARN 一次）。
 * getCapabilities 缺失或抛错按不可用处理（fail-closed，宁可少走一条通道也不静默空跑）。
 */
export function ensureL1FactVec(
  store: { getCapabilities?(): StoreCapabilities } | undefined | null,
  logger?: Logger,
): boolean {
  let caps: StoreCapabilities | undefined;
  try {
    caps = store?.getCapabilities?.();
  } catch {
    caps = undefined;
  }
  return ensureCapability(
    caps,
    "l1FactVec",
    "l1_fact_vec writes/searches are skipped: fact vectors will not be projected or searched via this store (#152 ①)",
    logger,
  );
}

/** 测试隔离：清空 WARN-once 记忆。 */
export function __resetCapabilityWarnings(): void {
  warnedKeys.clear();
}
