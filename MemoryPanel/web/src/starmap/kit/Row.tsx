import type { ReactNode } from 'react';

export interface RowProps {
  /** 行首：圆点、图标、序号。 */
  leading?: ReactNode;
  label: ReactNode;
  /** 标签右侧的次要数字（计数、时间）。 */
  meta?: ReactNode;
  /** 行尾：徽标、小按钮。放按钮时本行不要同时传 onClick，避免按钮套按钮。 */
  trailing?: ReactNode;
  /** 当前选中项。视觉：文字转实色 + 左侧 2px 层色短线。 */
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}

/**
 * 一行列表项。可点行渲染为 <button>（原生键盘/回车/空格），
 * 不可点行渲染为 <span>，两者外层结构一致，切换时不会跳版。
 */
export function Row(props: RowProps) {
  const cls = [
    'stk-row',
    props.active ? 'is-active' : '',
    props.disabled ? 'is-disabled' : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {props.leading !== undefined ? <span className="stk-row-lead">{props.leading}</span> : null}
      <span className="stk-row-label">{props.label}</span>
    </>
  );

  return (
    <div className={cls} title={props.title}>
      {props.onClick ? (
        <button
          type="button"
          className="stk-row-main"
          onClick={props.onClick}
          disabled={props.disabled}
          aria-current={props.active ? 'true' : undefined}
        >
          {inner}
        </button>
      ) : (
        <span className="stk-row-main" aria-current={props.active ? 'true' : undefined}>
          {inner}
        </span>
      )}
      {props.meta !== undefined ? <span className="stk-row-meta">{props.meta}</span> : null}
      {props.trailing !== undefined ? <span className="stk-row-tail">{props.trailing}</span> : null}
    </div>
  );
}
