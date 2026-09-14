/**
 * 用户级 session_init 配置的纯决策逻辑（spec §5 决策表）。
 *
 * 输入是 Task 2 getUserSessionConfig 返回的 { param_name: effective_value }，
 * 输出一个三态决策，供 CB / CC 状态机在 asset_confirm 前消费：
 *   - ask    → 回退现有交互表单（未配置 / manual_select=1 / 缺 team）
 *   - bypass → default_associate=0，直接不关联
 *   - preset → 带 team（可带 agent）的预设身份，复用 resolvePresetIdentity 校验登记
 *
 * 纯函数，无副作用；读取失败场景（config 传 null）由调用方兜底转 ask。
 */

export type UserInitDecision =
  | { kind: "ask" }
  | { kind: "bypass" }
  | { kind: "preset"; teamId: string; agentId?: string };

export const SESSION_INIT_MODULE = "session_init";

export function resolveUserSessionInitPreset(
  config: Record<string, string> | null,
): UserInitDecision {
  // 读取失败 / 未配置 → 零行为变化：ask
  if (!config) return { kind: "ask" };

  // manual_select 生效值（默认 "1"）。非 "0" 一律仍手动选。
  const manualSelect = config["manual_select"];
  if (manualSelect !== "0") return { kind: "ask" };

  // manual_select=0：看默认是否关联。
  const associate = config["default_associate"];
  if (associate === "0") return { kind: "bypass" };

  // 默认关联团队资产，但没配团队 → 无法定位，弹表单全问。
  const teamId = (config["default_team_id"] ?? "").trim();
  if (!teamId) return { kind: "ask" };

  const agentId = (config["default_agent_id"] ?? "").trim();
  return { kind: "preset", teamId, agentId: agentId || undefined };
}