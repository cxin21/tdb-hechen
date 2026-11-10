/**
 * 人格条目哈希（账本 before/after 锚）。
 *
 * 2026-11-07 收缩记录：
 *  - P2-9：本文件原是「人格整合器」，其编排入口 runSoulConsolidation 全仓无生产调用方（死路径），已删。
 *  - P0-0：core_memory 槽位通道整体移除，classifyImported / collectSlotLines / planConsolidation
 *    随之删除；人格来源只剩 episode-history 与 l1+model+episode 两条。
 * 保留 itemHash：worker 用它算账本 before/after 哈希（回滚与漂移账本的幂等锚）。
 */
import { textHash } from "./gates.js";
import type { PersonaItem } from "./types.js";

export function itemHash(item: PersonaItem): string {
  return textHash(`${item.layer}|${item.text}|${item.state}|${item.weight.toFixed(3)}`);
}
