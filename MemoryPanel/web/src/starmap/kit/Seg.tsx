import type { ReactNode } from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  title?: string;
}

export interface SegProps<T extends string> {
  value: T;
  options: SegOption<T>[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

/**
 * 分段切换（层筛选、范围切换）。
 * 选中态＝文字转 --ink + 底部 2px 层色短线；旧实现是蓝色 rgba 填充块，已废弃。
 */
export function Seg<T extends string>({ value, options, onChange, size = 'md', ariaLabel }: SegProps<T>) {
  return (
    <div className={size === 'sm' ? 'stk-seg is-sm' : 'stk-seg'} role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            type="button"
            key={opt.value}
            className={on ? 'stk-seg-btn is-on' : 'stk-seg-btn'}
            aria-pressed={on}
            title={opt.title}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.count !== undefined ? <span className="stk-seg-count">{opt.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
