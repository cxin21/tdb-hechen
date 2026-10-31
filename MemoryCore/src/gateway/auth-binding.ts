/**
 * #红队② /v3 数据面归属校验（task-60）
 * ---------------------------------------------------------------------------
 * 背景：core 数据面今天只有「服务级信任」——Bearer 通过即认任何 user_id。
 * 红队实测：单凭 Bearer 可用任意 user_id 读真实 L0（200）甚至删（deleted:10）。
 *
 * 但**不能**直接把「user_id 必须等于凭据主体」写死：现有 DSH 插件与
 * MemoryProxy 本来就用共享密钥 + 三 header 的身份模型，硬改会把它们全打挂。
 *
 * 因此本模块只提供**可配、缺省关**的判定函数（零 IO、零 env 读取）：
 *   - ① 缺省 requireUserBinding=false ⇒ decideUserBinding 恒放行，
 *        与今天逐位相同（回归由 auth-binding.test.ts 的 bite-identical 用例钉住）；
 *   - ② 开启后 /v3 数据面要求 x-tdai-user-key 与请求声明的 user_id 一致，
 *        否则 403 + 机器码（USER_BINDING_REQUIRED / USER_BINDING_MISMATCH）；
 *   - ③ 写侧未知主体策略（unknownPrincipalPolicy）：off / warn / reject，
 *        由调用方注入的 entity 存在性查询喂数据（本模块只做判定）；
 *   - ④ admin 显式旁路：x-tdai-user-type=system_admin + x-tdai-admin-bypass=1。
 *
 * env 读取集中在 utils/env-config.ts（OpenClaw 安全扫描器约束），
 * 本模块只接收已解析的字符串/对象，便于纯函数单测。
 *
 * task-68（#137 跟进）把 team 归属校验的开关也收进同一份 memory.auth：
 * requireTeamOwnership（off|warn|enforce，缺省 off）+ teamOwnershipWhitelist。
 * 判定纯函数在 gateway/team-ownership.ts，metadata 查询/缓存见 gateway/team-ownership-resolver.ts。
 */

import {
  normalizeTeamOwnershipWhitelist,
  parseTeamOwnershipMode,
  type TeamOwnershipMode,
} from "./team-ownership.js";

/** 写侧未知主体（entity 表里查不到 team/agent/user）的处理档。 */
export type UnknownPrincipalPolicy = "off" | "warn" | "reject";

export interface AuthBindingConfig {
  /**
   * 是否要求 /v3 数据面把 x-tdai-user-key（凭据主体）与请求声明的 user_id 绑定。
   * 缺省 false = 沿用今天的服务级信任。
   */
  requireUserBinding: boolean;
  /** 写侧未知主体处理档；缺省 "off"（完全不查，逐位不变）。 */
  unknownPrincipalPolicy: UnknownPrincipalPolicy;
  /** 是否允许 admin 显式旁路（需 system_admin + 显式 bypass header）。缺省 false。 */
  adminBypassEnabled: boolean;
  /**
   * `/v3` 数据面「team 属不属于本调用方」三档：off（缺省，逐位现状）/ warn / enforce。
   * 判定见 gateway/team-ownership.ts 的 decideTeamOwnership。
   */
  requireTeamOwnership: TeamOwnershipMode;
  /** 归属校验白名单：命中的 team_id 不查询、直接放行（历史脏 team 逃生口）。缺省空。 */
  teamOwnershipWhitelist: string[];
}

/** 缺省 = 今天的生产行为：三个开关全关。 */
export const DEFAULT_AUTH_BINDING: AuthBindingConfig = {
  requireUserBinding: false,
  unknownPrincipalPolicy: "off",
  adminBypassEnabled: false,
  requireTeamOwnership: "off",
  teamOwnershipWhitelist: [],
};

/** 403 的机器码（客户端可据此区分缺凭据 vs 身份不符）。 */
export const USER_BINDING_REQUIRED = "USER_BINDING_REQUIRED";
export const USER_BINDING_MISMATCH = "USER_BINDING_MISMATCH";
/** 写侧未知主体的 400 机器码。 */
export const UNKNOWN_PRINCIPAL = "UNKNOWN_PRINCIPAL";

const OFF_WORDS = new Set(["0", "false", "off", "no", "disabled"]);
const ON_WORDS = new Set(["1", "true", "on", "yes", "enabled"]);

/**
 * 解析布尔开关：空/未设 → fallback；on 词 → true；off 词 → false；
 * 未知非空取值 → **fail-secure 视为 true**（与 resolveV3StrictIsolation 同口径：
 * 显式写了 but 写错，按开启处理，宁严不松）。
 */
export function parseSwitch(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (OFF_WORDS.has(v)) return false;
  if (ON_WORDS.has(v)) return true;
  return true;
}

/** 解析写侧策略：空/未设 → fallback；未知非空取值 → "reject"（fail-secure）。 */
export function parseUnknownPrincipalPolicy(
  raw: string | undefined,
  fallback: UnknownPrincipalPolicy = "off",
): UnknownPrincipalPolicy {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "off" || v === "warn" || v === "reject") return v;
  return "reject";
}

export interface AuthBindingConfigSource {
  memory?: {
    auth?:
      | (Partial<Omit<AuthBindingConfig, "requireTeamOwnership">> & {
          requireTeamOwnership?: TeamOwnershipMode | string | undefined;
        })
      | undefined;
  } | undefined;
}

/**
 * 合并生效配置。优先级：env 显式设置 > 配置文件 memory.auth > 缺省全关。
 * env 参数由 utils/env-config.ts 的 reader 取来（本函数不读 process.env）。
 */
export function resolveAuthBindingConfig(
  config?: AuthBindingConfigSource | undefined,
  env?: {
    requireUserBinding?: string | undefined;
    unknownPrincipalPolicy?: string | undefined;
    adminBypass?: string | undefined;
    requireTeamOwnership?: string | undefined;
    teamOwnershipWhitelist?: string | undefined;
  },
): AuthBindingConfig {
  const fromCfg = config?.memory?.auth ?? {};
  const requireUserBinding = parseSwitch(
    env?.requireUserBinding,
    fromCfg.requireUserBinding === true,
  );
  const unknownPrincipalPolicy = parseUnknownPrincipalPolicy(
    env?.unknownPrincipalPolicy,
    fromCfg.unknownPrincipalPolicy ?? "off",
  );
  const adminBypassEnabled = parseSwitch(
    env?.adminBypass,
    fromCfg.adminBypassEnabled === true,
  );
  // task-68：team 归属三档 + 白名单（env > yaml memory.auth > 缺省 off/空）。
  const requireTeamOwnership = parseTeamOwnershipMode(
    env?.requireTeamOwnership,
    parseTeamOwnershipMode(
      typeof fromCfg.requireTeamOwnership === "string" ? fromCfg.requireTeamOwnership : undefined,
      "off",
    ),
  );
  const envTeamWhitelist = normalizeTeamOwnershipWhitelist(env?.teamOwnershipWhitelist);
  const teamOwnershipWhitelist = envTeamWhitelist.length > 0
    ? envTeamWhitelist
    : normalizeTeamOwnershipWhitelist(fromCfg.teamOwnershipWhitelist);
  return {
    requireUserBinding,
    unknownPrincipalPolicy,
    adminBypassEnabled,
    requireTeamOwnership,
    teamOwnershipWhitelist,
  };
}

export interface UserBindingInput {
  config: AuthBindingConfig;
  /** 请求声明的 user_id（body 优先，其次 x-tdai-user-id），已 trim。 */
  requestUserId: string;
  /** x-tdai-user-key（凭据主体）。未带 → undefined/空串。 */
  userKey?: string | undefined;
  /** x-tdai-user-type（如 system_admin）。 */
  userType?: string | undefined;
  /** x-tdai-admin-bypass：仅 "1"/"true" 视为显式旁路意图。 */
  adminBypass?: string | undefined;
}

export type UserBindingDecision =
  | { allow: true; bypassed: boolean }
  | { allow: false; code: typeof USER_BINDING_REQUIRED | typeof USER_BINDING_MISMATCH; reason: string };

/** 纯判定：/v3 数据面是否允许这个 (请求 user_id, 凭据 user key) 组合。 */
export function decideUserBinding(input: UserBindingInput): UserBindingDecision {
  const { config } = input;
  // ① 缺省关 ⇒ 恒放行（bite-identical）
  if (!config.requireUserBinding) return { allow: true, bypassed: false };

  const bypassFlag = (input.adminBypass ?? "").trim().toLowerCase();
  const userType = (input.userType ?? "").trim().toLowerCase();
  if (
    config.adminBypassEnabled &&
    userType === "system_admin" &&
    (bypassFlag === "1" || bypassFlag === "true")
  ) {
    // ④ admin 显式旁路：需要同时具备 system_admin + 显式 header，缺一不放行
    return { allow: true, bypassed: true };
  }

  const key = (input.userKey ?? "").trim();
  if (!key) {
    return {
      allow: false,
      code: USER_BINDING_REQUIRED,
      reason: "x-tdai-user-key is required when memory.auth.requireUserBinding is enabled",
    };
  }
  const claimed = (input.requestUserId ?? "").trim();
  if (!claimed || key !== claimed) {
    return {
      allow: false,
      code: USER_BINDING_MISMATCH,
      reason: `x-tdai-user-key (${key}) does not match requested user_id (${claimed || "<empty>"})`,
    };
  }
  return { allow: true, bypassed: false };
}

/** 主体存在性查询结果：true=存在，false=查无，null=无法判定（不拦）。 */
export interface PrincipalLookup {
  teamKnown?: boolean | null;
  agentKnown?: boolean | null;
  userKnown?: boolean | null;
}

export type PrincipalKind = "team" | "agent" | "user";

export interface UnknownPrincipalDecision {
  action: "allow" | "warn" | "reject";
  /** 查无的主体维度（action=allow 时为空）。 */
  unknown: PrincipalKind[];
}

/**
 * ③ 写侧未知主体判定。policy=off ⇒ 恒 allow（不查也不记）。
 * 只有明确的 false（查无）才算未知；null/undefined（没有该查询能力）不拦。
 */
export function decideUnknownPrincipal(
  policy: UnknownPrincipalPolicy,
  lookup: PrincipalLookup | null | undefined,
): UnknownPrincipalDecision {
  if (policy === "off" || !lookup) return { action: "allow", unknown: [] };
  const unknown: PrincipalKind[] = [];
  if (lookup.teamKnown === false) unknown.push("team");
  if (lookup.agentKnown === false) unknown.push("agent");
  if (lookup.userKnown === false) unknown.push("user");
  if (unknown.length === 0) return { action: "allow", unknown };
  return { action: policy === "reject" ? "reject" : "warn", unknown };
}
