import type { CSSProperties, ReactNode } from 'react';

export interface StageProps {
  /** 背景层：星场 canvas。铺满视口，位于所有 UI 之下，并接收空白处的点击/拖拽。 */
  field: ReactNode;
  /** 顶部通栏：ScopeBar（团队/agent/块 + 同步时间）。 */
  top?: ReactNode;
  /** 左栏：筛选与星点列表（通常一条 Surface）。 */
  left?: ReactNode;
  /** 中栏：留白给星场；需要时放空态提示或选中星的一句话摘要。 */
  center?: ReactNode;
  /** 右栏：星点详情（通常一条 Surface，内含 StarDetail + Pager）。 */
  right?: ReactNode;
  /** 底部通栏：图例、降级提示。 */
  bottom?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * 星图舞台：星场是**背景**，不是卡片里的一张图。
 * 规则：
 *  1. field 固定在视口底层；UI 全部浮在它上面（overlay），面板必须是实底 --surface，禁毛玻璃；
 *  2. 三栏之间不画分隔线、不给中栏加背景——中间那块只属于星场；
 *  3. 除面板自身区域外，指针事件穿透到星场（.stk-stage-ui 整体 pointer-events:none，子块再 auto）。
 */
export function Stage(props: StageProps) {
  const cls = ['stk-stage', props.className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} style={props.style}>
      <div className="stk-stage-field">{props.field}</div>
      <div className="stk-stage-ui">
        {props.top !== undefined ? <div className="stk-stage-top">{props.top}</div> : null}
        <div className="stk-stage-body">
          {props.left !== undefined ? (
            <div className="stk-stage-left stk-scroll">{props.left}</div>
          ) : null}
          <div className="stk-stage-mid">{props.center}</div>
          {props.right !== undefined ? (
            <div className="stk-stage-right stk-scroll">{props.right}</div>
          ) : null}
        </div>
        {props.bottom !== undefined ? <div className="stk-stage-bottom">{props.bottom}</div> : null}
      </div>
    </div>
  );
}
