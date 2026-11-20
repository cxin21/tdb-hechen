import type { ReactNode } from 'react';
import { dotClass, type Tone } from './types';

export interface MetricItem {
  k: string;
  v: ReactNode;
  tone?: Tone;
  /** 数值单位，例如「条」「个」。 */
  unit?: string;
}

/** 一行读数。数字用 tabular-nums 对齐，不画格线（旧 StatRow 的格线已去掉）。 */
export function MetricRow({ items }: { items: MetricItem[] }) {
  return (
    <div className="stk-metrics">
      {items.map((it, i) => (
        <div className="stk-metric" key={`${it.k}-${i}`}>
          <span className="stk-metric-k">
            {it.tone ? <span className={dotClass(it.tone)} aria-hidden="true" /> : null}
            {it.k}
          </span>
          <span className="stk-metric-v">
            {typeof it.v === 'number' ? it.v.toLocaleString('zh-CN') : it.v}
            {it.unit ? <span className="stk-metric-unit">{it.unit}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
