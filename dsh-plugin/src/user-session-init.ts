/**
 * 用户级 session_init 配置的纯决策逻辑。
 *
 * 逐行照抄 MemoryProxy/src/session/user-session-init-preset.ts:20-40（spec §5
 * 决策表）。原流程里「弹不弹卡」只由这份用户级配置决定，与候选数量无关：
 *   - ask    → 每会话都走交互表单（未配置 / manual_select≠"0" / 缺 team）
 *   - bypass → default_associate="0"，不关联、不注入
 *   - preset → 带 team（可带 agent）的预设身份，校验后静默绑定
 *
 * 纯函数，无副作用；读取失败场景（config 传 null）由调用方兜底转 ask。
 */

export type UserInitDecision =
  | { kind: 'ask' }
  | { kind: 'bypass' }
  | { kind: 'preset'; teamId: string; agentId?: string };

/** The module whose per-user defaults decide how a session initialises. */
export const SESSION_INIT_MODULE = 'session_init';

/**
 * Map `{ param_name: effective_value }` to the three-state decision.
 *
 * Anything unexpected (null config, unknown values, no team) falls through to
 * `ask`, which is the pre-existing behaviour — so a config endpoint that is
 * down changes nothing about how the session starts.
 */
export function resolveUserSessionInitDecision(config: Record<string, string> | null | undefined): UserInitDecision {
  // 读取失败 / 未配置 → 零行为变化：ask（user-session-init-preset.ts:23-24）
  if (!config) return { kind: 'ask' };

  // manual_select 生效值（默认 "1"）。非 "0" 一律仍手动选。（:26-28）
  const manualSelect = config['manual_select'];
  if (manualSelect !== '0') return { kind: 'ask' };

  // manual_select="0"：看默认是否关联。（:30-32）
  const associate = config['default_associate'];
  if (associate === '0') return { kind: 'bypass' };

  // 默认关联团队资产，但没配团队 → 无法定位，弹表单全问。（:34-36）
  const teamId = (config['default_team_id'] ?? '').trim();
  if (!teamId) return { kind: 'ask' };

  // 可带 agent；空串等价于「没配」。（:38-39）
  const agentId = (config['default_agent_id'] ?? '').trim();
  return { kind: 'preset', teamId, agentId: agentId || undefined };
}
