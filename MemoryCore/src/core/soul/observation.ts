/**
 * S8（2026-11-07）：soul 观测——把插件两通道与漂移结果落进 recall journal。
 *
 * spec D10：journal 增三个字段 soul.sessionInit{version,hash,chars}、soul.turnChars、
 * soul.drift{changed,rejected}。三条约束：
 *  1. best-effort：任何异常都返回 undefined，召回热路径零影响（与 journal 本身同纪律）；
 *  2. 纯读：本模块不写库、不触发渲染副作用；
 *  3. 不新开日志通道：漂移 changed/rejected 由 worker 在 tick 内喂进来（内存登记），
 *     journal 写入点只读最近一次登记——漂移发生在生命周期线程，journal 在召回线程。
 */
import type { CoreTenant, IMemoryStore } from "../store/types.js";
import { assembleSoulTurn, readPersistedCardMeta } from "./card-service.js";

/** 漂移观测：changed = 本 tick 真正位移的轴数；rejected = 被拒票数（含 step_exceeded）。 */
export interface SoulDriftObservation {
  changed: number;
  rejected: number;
  /** 观测时刻（ISO）；journal 侧只读，不判断新鲜度。 */
  at: string;
}

/** journal 的 soul 字段（spec D10）。 */
export interface SoulJournalFields {
  sessionInit?: { version: number; hash: string; chars: number };
  turnChars?: number;
  drift?: { changed: number; rejected: number };
  /** G2：取卡/渲染失败原因（turn-error），用于区分「没设定」与「取卡失败」。 */
  failReason?: "turn-error";
  /**
   * R1（2026-11-07）：这三项是 Core 侧**估算**——sessionInit 读落库快照 meta、
   * turnChars 现场再渲染一次，都不是插件真正拼进 prompt 的那份字节。
   * 实际注入量由插件回传（journal 的 `kind:"injection"` 行，source=plugin）。
   */
  source?: "server-render";
}

const driftByTenant = new Map<string, SoulDriftObservation>();

function tenantKey(t: Pick<CoreTenant, "teamId" | "userId" | "agentId">): string {
  return [t.teamId ?? "default", t.userId ?? "default", t.agentId ?? "default"].join("|");
}

/** worker 每个 tick 调用一次（覆盖写：只保留最近一 tick 的观测）。 */
export function recordSoulDrift(
  tenant: Pick<CoreTenant, "teamId" | "userId" | "agentId">,
  stats: { changed: number; rejected: number },
  now: Date | string = new Date(),
): void {
  if (!Number.isFinite(stats.changed) || !Number.isFinite(stats.rejected)) return;
  driftByTenant.set(tenantKey(tenant), {
    changed: Math.max(0, Math.floor(stats.changed)),
    rejected: Math.max(0, Math.floor(stats.rejected)),
    at: typeof now === "string" ? now : now.toISOString(),
  });
}

export function readSoulDrift(
  tenant: Pick<CoreTenant, "teamId" | "userId" | "agentId">,
): SoulDriftObservation | undefined {
  return driftByTenant.get(tenantKey(tenant));
}

/** 仅供测试/进程退出清理。 */
export function resetSoulDriftRegistry(): void {
  driftByTenant.clear();
}

/**
 * 组装本轮 journal 的 soul 字段。
 *
 * - sessionInit 只在「新会话首次召回」写（sessionReused=false 且已有落库卡），语义 = 这次会话
 *   冻结的是哪一版卡；复用会话不重复记账（判据 14 要能答「哪版卡 version/hash」）。
 * - turnChars = 通道 B 实际渲染字符数（与插件注入同源：assembleSoulTurn）。
 * - drift = 最近一次 worker tick 的位移/拒绝数。
 * 三项都取不到时返回 undefined（journal 不写该键，向后兼容旧条目）。
 */
export async function collectSoulJournalFields(
  store: IMemoryStore | undefined,
  tenant: Pick<CoreTenant, "teamId" | "userId" | "agentId">,
  opts: { sessionReused: boolean },
): Promise<SoulJournalFields | undefined> {
  if (!store) return undefined;
  const out: SoulJournalFields = {};
  try {
    if (!opts.sessionReused) {
      const meta = await readPersistedCardMeta(store as never, tenant as CoreTenant);
      if (meta) out.sessionInit = meta;
    }
    const turn = await assembleSoulTurn({ store: store as never, tenant: tenant as CoreTenant });
    if (typeof turn.text === "string") out.turnChars = turn.text.length;
    const drift = readSoulDrift(tenant);
    if (drift) out.drift = { changed: drift.changed, rejected: drift.rejected };
  } catch {
    return { failReason: "turn-error", source: "server-render", ...out };
  }
  if (Object.keys(out).length === 0) return undefined;
  return { ...out, source: "server-render" };
}
