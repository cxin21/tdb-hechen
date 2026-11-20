import type { ReactNode } from 'react';

export interface KvItem {
  k: string;
  v: ReactNode;
  /** id / key / 页码这类机器值用等宽。 */
  mono?: boolean;
}

export interface KvListProps {
  items: KvItem[];
}

const EMPTY = '—';

/** 键值清单。键列固定 44px，空值统一一个破折号（不留空白行，避免高度跳动）。 */
export function KvList({ items }: KvListProps) {
  if (items.length === 0) return null;

  return (
    <dl className="stk-kv">
      {items.map((it, i) => {
        const empty = it.v === null || it.v === undefined || it.v === '';
        return (
          <div className="stk-kv-row" key={`${it.k}-${i}`}>
            <dt className="stk-kv-k">{it.k}</dt>
            <dd
              className={[
                'stk-kv-v',
                it.mono ? 'is-mono' : '',
                empty ? 'is-empty' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {empty ? EMPTY : it.v}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
