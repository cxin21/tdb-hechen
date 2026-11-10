/**
 * P2（spec §10.8）：关系边 event_id 的确定性回指——维护 tick 里的一个派生修复步骤。
 *
 * 职责边界：判定与落库全在 store（VectorStore.backfillSoulPersonRelationEventIds），这里只做
 * 「有没有写面 / 失败不阻断 tick / 计数上报」三件事，保持 store 纯函数可单测。
 *
 * 为什么每一 tick 都跑：旧关系行（distiller 写入时只带 quote+record_id）不会自己长出 event_id；
 * 判定只认唯一命中，重复跑对已判定行是 0 扫描（幂等），所以不需要开关或水位。
 */
import type {
  CoreTenant,
  SoulPersonRelationBackfillResult,
  SoulPersonRelationProvisionResult,
} from "../store/types.js";

export interface RelationBackfillStorePort {
  backfillSoulPersonRelationEventIds?: (
    tenant?: CoreTenant,
    opts?: { now?: string },
  ) => SoulPersonRelationBackfillResult | Promise<SoulPersonRelationBackfillResult>;
}

export interface RunRelationEventBackfillArgs {
  store: RelationBackfillStorePort;
  tenant: CoreTenant;
  now?: string;
  logger?: { warn?: (msg: string) => void };
}

/**
 * @returns 本轮账（scanned/linked/unverifiable）；`undefined` = store 没有这个写面（未接线），
 *          与「跑了但 0 条」可区分。
 */
export interface RelationProvisionStorePort {
  provisionSoulRelationEvents?: (
    tenant?: CoreTenant,
    opts?: { now?: string },
  ) => SoulPersonRelationProvisionResult | Promise<SoulPersonRelationProvisionResult>;
}

export interface RunRelationEventProvisionArgs {
  store: RelationProvisionStorePort;
  tenant: CoreTenant;
  now?: string;
  logger?: { warn?: (msg: string) => void };
}

/**
 * P2 §10.8 / t13：确定性补事件（引文在 L0 唯一命中、但关系边当时没带 event_id）。
 *
 * 放在回指**之前**：补完事件，同一 tick 的回指才能把这三条边链上（linked）。
 * 只建 L0 已经存在的原话，不调模型、不生成新内容；零/多命中一律不建，留给回指标 unverifiable。
 *
 * @returns 本轮账（scanned/created/ambiguous/skipped）；undefined = store 没这个写面（未接线）。
 */
export async function runRelationEventProvision(
  args: RunRelationEventProvisionArgs,
): Promise<SoulPersonRelationProvisionResult | undefined> {
  const fn = args.store.provisionSoulRelationEvents;
  if (typeof fn !== "function") return undefined;
  try {
    const out = await fn.call(args.store, args.tenant, args.now ? { now: args.now } : undefined);
    return out ?? { scanned: 0, created: 0, ambiguous: 0, skipped: 0 };
  } catch (err) {
    args.logger?.warn?.(
      `[soul-relation-provision] 补事件失败（不阻断 tick，下轮重试）：${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runRelationEventBackfill(
  args: RunRelationEventBackfillArgs,
): Promise<SoulPersonRelationBackfillResult | undefined> {
  const fn = args.store.backfillSoulPersonRelationEventIds;
  if (typeof fn !== "function") return undefined;
  try {
    const out = await fn.call(args.store, args.tenant, args.now ? { now: args.now } : undefined);
    return out ?? { scanned: 0, linked: 0, unverifiable: 0 };
  } catch (err) {
    args.logger?.warn?.(
      `[soul-relation-backfill] 回指失败（不阻断 tick，下轮重试）：${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
