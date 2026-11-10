/**
 * P6 / t20：episode 的确定性补事件——维护 tick 里的一个派生修复步骤。
 *
 * 为什么需要它：t12 在 90 天老库（D:/TDB/data/fulltest90/vectors.db）上验收时发现
 * 87 条 episode 一条 soul_events 都没有，于是 7 个租户 tick 全部 created=0、只记
 * skippedNoEvidence。「证据必须回指真实 soul_events」这条规则本身是对的，错的是沉默：
 * 调用方只看到 0 章，拿不到「因为老库没建事件」这个原因，也拿不到任何示例 episodeId。
 *
 * 做法与 P2 的关系线（relation-provision.ts）同构：只把 L0 里**已经存在**的原话补成事件，
 * 不调模型、不生成 L0 之外的内容。唯一命中才建；多命中/零命中/work 类一律不建，计入
 * skippedUnprovisionable 并把第一条示例打出去。判定与落库全在 store（VectorStore.
 * provisionSoulEpisodeEvents），这里只做「有没有写面 / 失败不阻断 tick / 计数与 warn 上报」。
 */
import type { CoreTenant, SoulEpisodeProvisionResult } from "../store/types.js";

/** 每 tick 最多补多少条：大库一次补完会把 tick 拖成分钟级；剩余的下轮继续（幂等）。 */
export const EPISODE_PROVISION_MAX_PER_TICK = 50;

export interface EpisodeProvisionStorePort {
  provisionSoulEpisodeEvents?: (
    tenant?: CoreTenant,
    opts?: { now?: string; limit?: number },
  ) => SoulEpisodeProvisionResult | Promise<SoulEpisodeProvisionResult>;
}

export interface RunEpisodeEventProvisionArgs {
  store: EpisodeProvisionStorePort;
  tenant: CoreTenant;
  now?: string;
  limit?: number;
  logger?: { warn?: (msg: string) => void };
}

function emptyResult(): SoulEpisodeProvisionResult {
  return {
    scanned: 0,
    created: 0,
    ambiguous: 0,
    notFound: 0,
    noSource: 0,
    skippedWork: 0,
    skippedUnprovisionable: 0,
    skippedExisting: 0,
    failed: 0,
    exampleEpisodeId: null,
    exampleReason: null,
    limitReached: false,
  };
}

/**
 * @returns 本轮账；`undefined` = store 没有这个写面（未接线），与「跑了但 0 条」可区分。
 */
export async function runEpisodeEventProvision(
  args: RunEpisodeEventProvisionArgs,
): Promise<SoulEpisodeProvisionResult | undefined> {
  const fn = args.store.provisionSoulEpisodeEvents;
  if (typeof fn !== "function") return undefined;
  try {
    const out = await fn.call(args.store, args.tenant, {
      ...(args.now ? { now: args.now } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });
    const result = out ?? emptyResult();
    if (result.skippedUnprovisionable > 0) {
      // 这条 warn 是「0 章」的可解释入口：没有它，老库/混合库的 0 章只能靠翻库猜。
      args.logger?.warn?.(
        `[soul-episode-provision] ${result.skippedUnprovisionable} 条无事件 episode 无法确定性补事件` +
          `（示例 ${result.exampleEpisodeId ?? "?"}：${result.exampleReason ?? "unknown"}）——` +
          "它们不会进章节；原因不是「没有内容」，而是「回不到 soul_events」。",
      );
    }
    return result;
  } catch (err) {
    args.logger?.warn?.(
      `[soul-episode-provision] 补事件失败（不阻断 tick，下轮重试）：${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}