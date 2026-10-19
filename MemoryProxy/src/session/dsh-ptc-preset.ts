/**
 * dsh PTC 会话身份预检（捕获中断修复批次）。
 *
 * 背景：PTC（code-mode）会话发给 LLM 的 tools 只含 run_code、无
 * ask_user_question，handler.ts 判 _dshHeadless 跳过 session-init → 会话无身份
 * → L0 写入 / skill 提取 / skill 归档全零写入（ctx.isDshHeadless 连坐拦截）。
 *
 * 本模块实现"配置代供身份"：key 已通过 earlyVerify 解析出 userId，此时读
 * 用户级 session_init 默认值（kernel /v3/meta/config/user/get，module=session_init）：
 *   - manual_select=0（不需要手动选择）
 *   - default_associate=1（默认关联团队资产）
 *   - default_team_id + default_agent_id（默认关联团队/Agent，两级都配）
 * 四者配齐且 kernel 校验（team 必须存在于该用户可见 teams[]、agent 必须挂在
 * 该 team 下，与 headerAutoSelect/resolvePresetIdentity 同一安全语义）通过 →
 * 返回 PresetIdentity，handler 据此放行会话进既有头驱动登记路径（cbHandle
 * presetIdentity → completeRegistration，无表单直接登记）。
 *
 * 红线：任何不满足（未配置 / 需要手动选 / 不关联 / 缺 agent / 校验失败 /
 * kernel 不可用）→ 返回 null → 调用方维持现状 headless bypass，零行为变化。
 * 绝不让 PTC 会话触发表单——fake form tool_call 会被 dsh agent-loop 校验为
 * unknown tool 直接抛错。
 *
 * tools 形态（_dshHeadless）由此从"身份的最终裁决者"降级为"预检失败后的
 * 兜底分类"：身份来源完全由用户既有配置决定，与请求形态无关。
 *
 * deps 用 MetadataClient 的最小结构形状（listTeams/listAgents 原样），使
 * handler 可直接结构兼容传入，无需适配层；校验只需 listTeams+listAgents
 * 两次 kernel 调用（对比 fetchTeamsAndAgents 的 1+2N 次全量组装）。
 */

import { resolveUserSessionInitPreset, SESSION_INIT_MODULE } from "./user-session-init-preset.js";
import type { PresetIdentity } from "./preset.js";

/** 依赖注入接口（kernel 元数据访问，形状兼容 MetadataClient 对应方法），便于单测。 */
export interface DshPtcPresetDeps {
  getUserSessionConfig(userId: string, module: string): Promise<Record<string, string>>;
  listTeams(userId: string): Promise<{ team_id: string }[]>;
  listAgents(teamId: string, userId: string): Promise<{ agent_id: string; team_id?: string }[]>;
}

/**
 * 解析 dsh PTC 会话的预设身份。
 *
 * @returns 可直接登记的 PresetIdentity（team+agent 均已通过 kernel 校验），
 *          或 null = 不放行（调用方维持现状 bypass）。
 */
export async function resolveDshPtcPresetIdentity(
  deps: DshPtcPresetDeps,
  userId: string,
): Promise<PresetIdentity | null> {
  if (!userId) return null;

  let userCfg: Record<string, string>;
  try {
    userCfg = await deps.getUserSessionConfig(userId, SESSION_INIT_MODULE);
  } catch {
    // kernel 不可用 → 预检失败 → 维持现状 bypass（零行为变化）。
    return null;
  }

  const decision = resolveUserSessionInitPreset(userCfg);
  if (decision.kind !== "preset") {
    // ask（未配置/需要手动选/缺 team）或 bypass（default_associate=0）→ 不放行。
    return null;
  }

  let teams: { team_id: string }[];
  try {
    teams = await deps.listTeams(userId);
  } catch {
    return null;
  }
  // team 必须真实存在于该用户可见 teams[]（不信任配置里的裸值，同 headerAutoSelect）。
  if (!teams.some((t) => t.team_id === decision.teamId)) return null;

  let agents: { agent_id: string; team_id?: string }[];
  try {
    agents = await deps.listAgents(decision.teamId, userId);
  } catch {
    return null;
  }
  // agent 必须挂在该 team 下（resolvePresetIdentity 的等价语义：在指定 team
  // 的 agents 列表里能找到该 agent_id）。
  const hit = agents.find((a) => a.agent_id === decision.agentId);
  if (!hit) return null;

  return { teamId: decision.teamId, agentId: decision.agentId };
}
