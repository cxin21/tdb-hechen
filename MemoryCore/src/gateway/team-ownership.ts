/**
 * #137 / task-68：/v3 数据面的「team 属不属于本调用方」裁决
 * ---------------------------------------------------------------------------
 * 背景（task-58 调研 + 红队复测）：
 *   - L0–L3 数据面今天只校验三 ID **非空**（gateway/v2-router.ts 的
 *     collectV3Missing），不校验归属。任意 team_id 都能开自己的命名空间
 *     （写自己的、读自己的，不串到别人的 team），缺的是「这个 team 属不属于
 *     本调用方」这一层裁决。
 *   - metadata 面自己有闸（knowledge-handlers / asset caller authz），
 *     conversation/add 调 metadata 只做 ensureChatMemoryAsset 登记、失败仅 warn。
 *
 * 为什么**缺省关 + warn 先行**（Lead 拍板，不直接 403）：
 *   1. DSH 插件今天不带 x-tdai-user-key 头，直接 403 会把自己的写回打死；
 *   2. 历史数据里存在不属于任何人的 team（迁移/压测残留），一刀切会误伤。
 *   所以三档 off | warn | enforce，off = 逐位现状；warn = 只记审计与计数；
 *   enforce = 403 TEAM_NOT_OWNED。灰度顺序见 docs/ops/team-ownership-check.md。
 *
 * 判定源：metadata 的 team→member 关系（meta_team_members，status='active'）。
 * 调用方身份只认 x-tdai-user-key（与 /v3/meta/auth/verify 同源：verifyAuth）。
 * **没有 user-key 时不得判为不通过**——降级成 warn 并计数 no_identity，
 * 否则所有不带身份的写入都会被打死。
 *
 * 失败策略：metadata 查询抛错 ⇒ fail-open + WARN（一次一条，不刷屏）。
 * 记忆可用性优先于归属校验的一致性：抖动的 metadata 不该挡住写。
 *
 * env 读取集中在 utils/env-config.ts（OpenClaw 安全扫描器约束），本模块只接收
 * 已解析的字符串，便于纯函数单测。
 */

export type TeamOwnershipMode = "off" | "warn" | "enforce";

/** 403 的机器码（客户端可据此区分「身份不符」与「团队的归属不成立」）。 */
export const TEAM_NOT_OWNED = "TEAM_NOT_OWNED";

export interface TeamOwnershipConfig {
  /** 三档开关；缺省 "off" = 逐位现状（一次 metadata 查询都不发）。 */
  mode: TeamOwnershipMode;
  /** 归属校验白名单：命中即放行且**不查询**（历史脏 team 的逃生口）。 */
  whitelist: string[];
}

export const DEFAULT_TEAM_OWNERSHIP: TeamOwnershipConfig = {
  mode: "off",
  whitelist: [],
};

/**
 * 解析三档：空/未设 → fallback；off/warn/enforce 原样；
 * 未知非空取值 → "enforce"（与 parseSwitch / parseUnknownPrincipalPolicy 同口径：
 * 显式写了但写错，按最严处理，宁严不松）。
 */
export function parseTeamOwnershipMode(
  raw: string | undefined,
  fallback: TeamOwnershipMode = "off",
): TeamOwnershipMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "off" || v === "warn" || v === "enforce") return v;
  return "enforce";
}

/** 白名单归一化：去空白、去空项、去重（保序）。只接受字符串数组 / 逗号分隔串。 */
export function normalizeTeamOwnershipWhitelist(raw: unknown): string[] {
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export interface TeamOwnershipConfigSource {
  memory?: {
    auth?: {
      requireTeamOwnership?: TeamOwnershipMode | string | undefined;
      teamOwnershipWhitelist?: string[] | undefined;
    } | undefined;
  } | undefined;
}

/**
 * 合并生效配置。优先级：env 显式设置 > 配置文件 memory.auth > 缺省 off。
 * env 参数由 utils/env-config.ts 的 reader 取来（本函数不读进程环境）。
 */
export function resolveTeamOwnershipConfig(
  config?: TeamOwnershipConfigSource | undefined,
  env?: {
    requireTeamOwnership?: string | undefined;
    teamOwnershipWhitelist?: string | undefined;
  },
): TeamOwnershipConfig {
  const fromCfg = config?.memory?.auth ?? {};
  const mode = parseTeamOwnershipMode(
    env?.requireTeamOwnership,
    parseTeamOwnershipMode(
      typeof fromCfg.requireTeamOwnership === "string" ? fromCfg.requireTeamOwnership : undefined,
      "off",
    ),
  );
  const envList = normalizeTeamOwnershipWhitelist(env?.teamOwnershipWhitelist);
  const whitelist = envList.length > 0
    ? envList
    : normalizeTeamOwnershipWhitelist(fromCfg.teamOwnershipWhitelist);
  return { mode, whitelist };
}

// ── obs 计数（authz.team_ownership.*）──
//
// 没有通用指标注册表可用（观测口径见 docs/ops/extraction-session-isolation.md §5：
// 只有结构化日志 + 进程内计数）。这里维护模块级计数器，另在每次判定打一条带
// metric=authz.team_ownership.<name> 的结构化日志，便于 grep 与灰度读数。

export const TEAM_OWNERSHIP_METRICS = [
  "off",
  "warn",
  "enforce",
  "no_identity",
  "metadata_error",
  "allowed",
  "denied",
] as const;

export type TeamOwnershipMetric = (typeof TEAM_OWNERSHIP_METRICS)[number];

const counters = new Map<TeamOwnershipMetric, number>();

export function recordTeamOwnershipMetric(name: TeamOwnershipMetric, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

/** 计数快照（只返回非零项，便于日志/探针直接展开）。 */
export function snapshotTeamOwnershipMetrics(): Partial<Record<TeamOwnershipMetric, number>> {
  const out: Partial<Record<TeamOwnershipMetric, number>> = {};
  for (const [k, v] of counters) if (v > 0) out[k] = v;
  return out;
}

/** 单测用：清空计数。 */
export function __resetTeamOwnershipMetricsForTests(): void {
  counters.clear();
}

/**
 * metadata 侧查来的原始事实（由 gateway 的 resolver 注入）。
 *   - callerUserId：x-tdai-user-key → verifyAuth 解出的用户；解不出 ⇒ null
 *   - teamKnown：team 行存在；null = 没查/查不了
 *   - isMember：调用方是该 team 的 active 成员；null = 没查/查不了
 */
export interface TeamOwnershipLookup {
  callerUserId: string | null;
  teamKnown: boolean | null;
  isMember: boolean | null;
}

export type TeamOwnershipWhy =
  | "mode_off"
  | "whitelisted"
  | "no_identity"
  | "member"
  | "lookup_unavailable"
  | "team_unknown"
  | "not_member";

export type TeamOwnershipDecision =
  | { allow: true; why: TeamOwnershipWhy; warn: boolean; metric: TeamOwnershipMetric }
  | {
      allow: false;
      why: TeamOwnershipWhy;
      metric: TeamOwnershipMetric;
      code: typeof TEAM_NOT_OWNED;
      reason: string;
    };

export interface TeamOwnershipInput {
  config: TeamOwnershipConfig;
  teamId: string;
  /** x-tdai-user-key 头（未带 ⇒ 空串）。 */
  userKey?: string | undefined;
  /** resolver 查来的事实；off/白名单/无身份时允许 undefined（此时不该发查询）。 */
  lookup?: TeamOwnershipLookup | null | undefined;
}

function denied(reason: string, why: TeamOwnershipWhy = "not_member"): TeamOwnershipDecision {
  return { allow: false, why, metric: "denied", code: TEAM_NOT_OWNED, reason };
}

/**
 * 纯判定：/v3 数据面是否允许这次 (team_id, 调用方) 组合。
 *
 * 判定顺序（每一步都短路；能省掉的 metadata 查询由调用方用 teamOwnershipNeedsLookup 提前跳过）：
 *   1. mode=off            ⇒ 放行（逐位现状）
 *   2. team 在白名单        ⇒ 放行（不查询）
 *   3. 无 user-key          ⇒ 放行 + 计数 no_identity（不得打死无身份写入）
 *   4. 查询失败 / 事实缺失   ⇒ 放行 + 计数 metadata_error（fail-open）
 *   5. team 查无            ⇒ enforce 403 / warn 放行（team_unknown）
 *   6. 成员判定 false       ⇒ enforce 403 TEAM_NOT_OWNED / warn 放行
 *   7. 成员判定 true        ⇒ 放行
 */
export function decideTeamOwnership(input: TeamOwnershipInput): TeamOwnershipDecision {
  const { config } = input;
  if (config.mode === "off") {
    return { allow: true, why: "mode_off", warn: false, metric: "off" };
  }
  const teamId = (input.teamId ?? "").trim();
  if (teamId && config.whitelist.includes(teamId)) {
    return { allow: true, why: "whitelisted", warn: false, metric: "allowed" };
  }
  const userKey = (input.userKey ?? "").trim();
  if (!userKey) {
    return { allow: true, why: "no_identity", warn: true, metric: "no_identity" };
  }
  const lookup = input.lookup;
  if (!lookup) {
    return { allow: true, why: "lookup_unavailable", warn: true, metric: "metadata_error" };
  }
  const callerUserId = (lookup.callerUserId ?? "").trim();
  if (!callerUserId) {
    // key 带了但解不出用户（被吊销/伪造）：与「没带 key」同档——降级 warn，不判不通过。
    return { allow: true, why: "no_identity", warn: true, metric: "no_identity" };
  }
  if (lookup.teamKnown === null || lookup.isMember === null) {
    return { allow: true, why: "lookup_unavailable", warn: true, metric: "metadata_error" };
  }
  if (lookup.teamKnown === false) {
    if (config.mode === "enforce") {
      return denied("team " + (teamId || "<empty>") + " does not exist in metadata", "team_unknown");
    }
    return { allow: true, why: "team_unknown", warn: true, metric: "warn" };
  }
  if (lookup.isMember === false) {
    if (config.mode === "enforce") {
      return denied(
        "user " + callerUserId + " is not an active member of team " + (teamId || "<empty>"),
        "not_member",
      );
    }
    return { allow: true, why: "not_member", warn: true, metric: "warn" };
  }
  return { allow: true, why: "member", warn: false, metric: "allowed" };
}

/** 该次判定是否需要向 metadata 发查询（off / 白名单 / 无 key 都不发）。 */
export function teamOwnershipNeedsLookup(input: {
  config: TeamOwnershipConfig;
  teamId: string;
  userKey?: string | undefined;
}): boolean {
  if (input.config.mode === "off") return false;
  const teamId = (input.teamId ?? "").trim();
  if (teamId && input.config.whitelist.includes(teamId)) return false;
  return (input.userKey ?? "").trim() !== "";
}
