import type { ReactNode } from 'react';

export interface ScopeOption {
  id: string;
  label: string;
}

export interface ScopeBarProps {
  teams: ScopeOption[];
  teamId: string;
  agents: ScopeOption[];
  agentId: string;
  /** 记忆块（星图按块重建时用）；不传则不显示该下拉。 */
  blocks?: ScopeOption[];
  blockId?: string;
  syncedAt?: ReactNode;
  loading?: boolean;
  onTeam: (id: string) => void;
  onAgent: (id: string) => void;
  onBlock?: (id: string) => void;
  onRefresh?: () => void;
}

/**
 * 星图的作用域条：团队 / agent / 记忆块。
 * 星图是 agent 级的 —— 换 agent 等于换整张星图（清选中、清推导结果，但不清缓存）。
 */
export function ScopeBar(props: ScopeBarProps) {
  const { teams, teamId, agents, agentId, blocks, blockId, syncedAt, loading } = props;
  return (
    <div className="stk-scopebar">
      <label className="stk-field">
        <span className="stk-field-k">团队</span>
        <select
          className="stk-select"
          value={teamId}
          disabled={loading || teams.length === 0}
          onChange={(e) => props.onTeam(e.target.value)}
        >
          {teams.length === 0 ? <option value="">无团队</option> : null}
          {teams.map((t) => (
            <option value={t.id} key={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="stk-field">
        <span className="stk-field-k">Agent</span>
        <select
          className="stk-select"
          value={agentId}
          disabled={loading || agents.length === 0}
          onChange={(e) => props.onAgent(e.target.value)}
        >
          {agents.length === 0 ? <option value="">无 agent</option> : null}
          {agents.map((a) => (
            <option value={a.id} key={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>

      {blocks && props.onBlock ? (
        <label className="stk-field">
          <span className="stk-field-k">记忆块</span>
          <select
            className="stk-select"
            value={blockId ?? ''}
            disabled={loading || blocks.length === 0}
            onChange={(e) => props.onBlock?.(e.target.value)}
          >
            {blocks.map((b) => (
              <option value={b.id} key={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {syncedAt !== undefined ? <span className="stk-scopebar-stamp">同步 {syncedAt}</span> : null}

      {props.onRefresh ? (
        <button type="button" className="stk-btn is-ghost" onClick={props.onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      ) : null}
    </div>
  );
}
