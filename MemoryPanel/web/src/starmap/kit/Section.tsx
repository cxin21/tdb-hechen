import type { ReactNode } from 'react';

export interface SectionProps {
  title?: ReactNode;
  /** 标题行右端：计数、单位、小操作。 */
  aside?: ReactNode;
  /** 第一条 Section 不要顶部发丝线（避免表面标题下面立刻又出一条线）。 */
  first?: boolean;
  children?: ReactNode;
}

/** 表面内部的分段。只画一条顶部发丝线，不带背景 —— 卡片不套卡片。 */
export function Section({ title, aside, first, children }: SectionProps) {
  return (
    <div className={first ? 'stk-section is-first' : 'stk-section'}>
      {title !== undefined || aside !== undefined ? (
        <div className="stk-section-h">
          {title !== undefined ? <span className="stk-section-title">{title}</span> : null}
          {aside !== undefined ? <span className="stk-section-aside">{aside}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
