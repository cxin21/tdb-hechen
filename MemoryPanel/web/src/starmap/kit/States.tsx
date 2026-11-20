import type { ReactNode } from 'react';

export function Empty({ title, hint, action }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="stk-empty">
      <div className="stk-empty-title">{title ?? '这里还没有内容'}</div>
      {hint !== undefined ? <div className="stk-empty-hint">{hint}</div> : null}
      {action !== undefined ? <div className="stk-empty-action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stk-skeleton" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div className="stk-skeleton-row" key={i} />
      ))}
    </div>
  );
}

export interface NoteProps {
  tone?: 'dim' | 'warn' | 'bad';
  /** 右侧时间戳，例如「上次同步 12:03」。 */
  stamp?: ReactNode;
  children: ReactNode;
}

/**
 * 一行说明。降级提示用它：数据没刷新时说明「旧数据 + 上次同步时间」，
 * 不把失败变成空白页，也不假装数据是新的。
 */
export function Note({ tone = 'dim', stamp, children }: NoteProps) {
  return (
    <div className={tone === 'dim' ? 'stk-note' : `stk-note stk-note--${tone}`} role={tone === 'dim' ? undefined : 'status'}>
      <span className="stk-note-text">{children}</span>
      {stamp !== undefined ? <span className="stk-note-stamp">{stamp}</span> : null}
    </div>
  );
}
