import type { ReactNode } from 'react';
import { dotClass, type Tone } from './types';

export interface GateProps {
  label: ReactNode;
  /** 计数；数据未到时传 undefined，不传 0 —— 「没有」和「不知道」必须区分。 */
  count?: number;
  unit?: string;
  tone?: Tone;
  /** 数据源降级时标灰，并给出可读的原因。 */
  degraded?: boolean;
  hint?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}

/**
 * 总览里四朵云的入口。整块可点，命中区远大于 24px。
 * 计数缺失时显示「—」而不是 0；降级时显示原因，不伪造星点。
 */
export function Gate({ label, count, unit, tone, degraded, hint, active, onClick }: GateProps) {
  const cls = ['stk-gate', active ? 'is-active' : '', degraded ? 'is-degraded' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick}>
      <span className="stk-gate-h">
        <span className={dotClass(tone)} aria-hidden="true" />
        <span className="stk-gate-label">{label}</span>
      </span>
      <span className="stk-gate-count">
        {count === undefined ? '—' : count.toLocaleString('zh-CN')}
        {count !== undefined && unit ? <span className="stk-gate-unit">{unit}</span> : null}
      </span>
      {hint !== undefined ? <span className="stk-gate-hint">{hint}</span> : null}
    </button>
  );
}
