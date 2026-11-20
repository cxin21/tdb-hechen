import { dotClass, type Tone } from './types';

export interface LegendItem {
  tone: Tone;
  label: string;
}

export interface LegendProps {
  items: LegendItem[];
  /** 必填口径：暗色到底代表什么。写死在这里，避免每个页面各自解释。 */
  note?: string;
}

/** 图例。默认口径＝暗＝团队可见但未挂到本 agent。 */
export function Legend({ items, note = '暗＝团队可见、未挂到本 agent' }: LegendProps) {
  return (
    <div className="stk-legend">
      <div className="stk-legend-items">
        {items.map((it) => (
          <span className="stk-legend-item" key={it.label}>
            <span className={dotClass(it.tone)} aria-hidden="true" />
            {it.label}
          </span>
        ))}
      </div>
      <div className="stk-legend-note">{note}</div>
    </div>
  );
}
