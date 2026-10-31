/**
 * task-68：team 归属判定的 metadata resolver（带进程内 LRU + 失败留痕）。
 *
 * 与 ensureChatMemoryAsset 同一条热路径的思路：确认过的事实进进程内 Map 缓存，
 * 同 (user_key) / 同 (team, user) 的后续请求直接短路，**不新增每请求同步查询**。
 * 缓存 TTL 缺省 60s（成员变更/踢人可以在一分钟内生效），容量上限 4096，
 * 达到上限时淘汰最早写入项（与 MetadataService 的 ensuredChatMemoryAssets 同款 Map 语义）。
 *
 * 失败策略：**不吞异常**——查不动就抛，由 v2-router 统一走 fail-open + 一次 WARN
 * 计数 metadata_error。本模块只负责把「查到了什么」翻译成 TeamOwnershipLookup。
 */
import type { MetadataService } from "../metadata/service/metadata-service.js";
import type { TeamOwnershipLookup } from "./team-ownership.js";

export interface TeamOwnershipLogger {
  warn: (msg: string) => void;
  debug?: ((msg: string) => void) | undefined;
}

export interface TeamOwnershipResolverDeps {
  /** 与 v2-router deps.getMetadataService 同一实例来源（按 instanceId 懒建）。 */
  getMetadataService: (instanceId: string) => Promise<MetadataService>;
  logger: TeamOwnershipLogger;
  /** 缓存 TTL（毫秒）；0 = 不缓存（仅测试/排障用）。缺省 60000。 */
  cacheTtlMs?: number | undefined;
  /** 缓存条目上限；缺省 4096。 */
  maxEntries?: number | undefined;
  /** 可注入时钟（测试用）。 */
  now?: (() => number) | undefined;
}

export interface TeamOwnershipResolverInput {
  instanceId: string;
  teamId: string;
  userKey: string;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 4096;
const WARN_ONCE_LIMIT = 256;

interface UserCacheEntry {
  userId: string | null;
  at: number;
}

interface MemberCacheEntry {
  teamKnown: boolean;
  isMember: boolean;
  at: number;
}

export interface TeamOwnershipLookupFn {
  (input: TeamOwnershipResolverInput): Promise<TeamOwnershipLookup>;
}

export interface TeamOwnershipResolver {
  lookup: TeamOwnershipLookupFn;
  /** 缓存/告警的去重集大小（只读取证用）。 */
  stats: () => { users: number; members: number; warnOnce: number };
  /** 单测用：清空全部缓存与 warn-once 状态。 */
  reset: () => void;
}

/**
 * 建 resolver。cacheTtlMs=0 时每次都回 metadata 查（测试/排障）。
 */
export function createTeamOwnershipResolver(deps: TeamOwnershipResolverDeps): TeamOwnershipResolver {
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = deps.now ?? (() => Date.now());

  const users = new Map<string, UserCacheEntry>();
  const members = new Map<string, MemberCacheEntry>();
  const warnOnce = new Set<string>();

  const remember = <T extends { at: number }>(map: Map<string, T>, key: string, value: T): void => {
    if (map.size >= maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  };

  const fresh = (at: number): boolean => ttl > 0 && now() - at < ttl;

  const warnOnceFor = (key: string, msg: string): void => {
    if (warnOnce.has(key)) return;
    if (warnOnce.size >= WARN_ONCE_LIMIT) {
      const oldest = warnOnce.values().next().value;
      if (oldest !== undefined) warnOnce.delete(oldest);
    }
    warnOnce.add(key);
    deps.logger.warn(msg);
  };

  const lookup: TeamOwnershipLookupFn = async (input) => {
    const instanceId = (input.instanceId ?? "").trim();
    try {
      return await lookupInner(input);
    } catch (err) {
      // fail-open 由调用方（v2-router 的归属闸）决定；这里只保证「查不动」这件事
      // 一定留痕一次（同一 (instance, team) 不刷屏），然后原样抛出。
      warnOnceFor(
        "err:" + instanceId + ":" + (input.teamId ?? "").trim(),
        "[TEAM-OWNERSHIP] metadata lookup failed (fail-open) instance=" + instanceId +
          " team=" + (input.teamId ?? "") + ": " + (err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  };

  const lookupInner: TeamOwnershipLookupFn = async (input) => {
    const instanceId = (input.instanceId ?? "").trim();
    const teamId = (input.teamId ?? "").trim();
    const userKey = (input.userKey ?? "").trim();
    if (!userKey) return { callerUserId: null, teamKnown: null, isMember: null };

    const svc = await deps.getMetadataService(instanceId);

    // 1) user_key → userId（verifyAuth 与 /v3/meta/auth/verify 同源）
    let userEntry = users.get(userKey);
    if (!userEntry || !fresh(userEntry.at)) {
      const user = await svc.verifyAuth(userKey);
      userEntry = { userId: user?.user_id ?? null, at: now() };
      remember(users, userKey, userEntry);
    }
    const callerUserId = userEntry.userId;
    if (!callerUserId || !teamId) {
      return { callerUserId, teamKnown: null, isMember: null };
    }

    // 2) (team, user) → team 是否存在 + 是否 active 成员
    const memberKey = teamId + "\u0000" + callerUserId;
    let memberEntry = members.get(memberKey);
    if (!memberEntry || !fresh(memberEntry.at)) {
      const team = await svc.getTeamById(teamId);
      const member = team ? await svc.getTeamMember(teamId, callerUserId) : null;
      memberEntry = { teamKnown: team != null, isMember: member != null, at: now() };
      remember(members, memberKey, memberEntry);
    }

    deps.logger.debug?.(`[TEAM-OWNERSHIP] lookup team=${teamId} user=${callerUserId} ` +
      `team_known=${memberEntry.teamKnown} member=${memberEntry.isMember}`);

    return {
      callerUserId,
      teamKnown: memberEntry.teamKnown,
      isMember: memberEntry.isMember,
    };
  };

  return {
    lookup,
    stats: () => ({ users: users.size, members: members.size, warnOnce: warnOnce.size }),
    reset: () => {
      users.clear();
      members.clear();
      warnOnce.clear();
    },
  };
}
