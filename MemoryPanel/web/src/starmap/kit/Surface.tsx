import type { CSSProperties, ReactNode } from 'react';

export interface SurfaceProps {
  /** 表面标题。不传则不渲染标题行（用于纯容器）。 */
  title?: ReactNode;
  /** 标题行右端：计数、同步时间、小按钮。 */
  aside?: ReactNode;
  /** 紧凑内边距（8px 而非 12px），用于侧栏窄容器。 */
  dense?: boolean;
  as?: 'section' | 'aside' | 'div';
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  children?: ReactNode;
}

/**
 * 唯一的「一块表面」。规则：Surface 内不再嵌套带背景/边框的 Surface，
 * 需要分段用 <div className="stk-sec"> 或标题行，不允许卡片套卡片。
 */
export function Surface(props: SurfaceProps) {
  const Tag = props.as ?? 'section';
  const cls = ['stk-surface', props.dense ? 'is-dense' : '', props.className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={cls} style={props.style} aria-label={props.ariaLabel}>
      {props.title !== undefined ? (
        <div className="stk-surface-h">
          <span className="stk-surface-title">{props.title}</span>
          {props.aside !== undefined ? <span className="stk-surface-aside">{props.aside}</span> : null}
        </div>
      ) : null}
      {props.children}
    </Tag>
  );
}
