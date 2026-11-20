export interface PagerProps {
  page: number;
  pages: number;
  /** 总条数（来自接口 total，不是本页条数）。 */
  total: number;
  pageSize?: number;
  /** 量词：条 / 个 / 项。 */
  unit?: string;
  loading?: boolean;
  onChange: (page: number) => void;
}

const ELLIPSIS = '…' as const;
export type PageSlot = number | typeof ELLIPSIS;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 分页窗口：最多 7 个槽位。
 * 1) 总页数 ≤7 全列；2) 首页段 1 2 3 4 5 … N；
 * 3) 尾页段 1 … N-4 N-3 N-2 N-1 N；4) 中间 1 … c-1 c c+1 … N。
 * 槽位恒定意味着按钮行不随翻页抖动（跳页时鼠标下方不会换到另一个数字）。
 */
export function pageWindow(page: number, pages: number): PageSlot[] {
  const total = Number.isFinite(pages) ? Math.max(1, Math.floor(pages)) : 1;
  if (total <= 1) return [1];
  if (total <= 7) {
    const all: PageSlot[] = [];
    for (let p = 1; p <= total; p += 1) all.push(p);
    return all;
  }

  const cur = clamp(Number.isFinite(page) ? Math.floor(page) : 1, 1, total);
  let from: number;
  let to: number;
  if (cur <= 4) {
    from = 2;
    to = 5;
  } else if (cur >= total - 3) {
    from = total - 4;
    to = total - 1;
  } else {
    from = cur - 1;
    to = cur + 1;
  }

  const out: PageSlot[] = [1];
  if (from > 2) out.push(ELLIPSIS);
  for (let p = from; p <= to; p += 1) out.push(p);
  if (to < total - 1) out.push(ELLIPSIS);
  out.push(total);
  return out;
}

export function Pager({ page, pages, total, pageSize, unit = '条', loading, onChange }: PagerProps) {
  const totalPages = Math.max(1, Math.floor(pages) || 1);
  const cur = clamp(Math.floor(page) || 1, 1, totalPages);
  const busy = Boolean(loading);

  const meta = [
    `共 ${total.toLocaleString('zh-CN')} ${unit}`,
    pageSize ? `每页 ${pageSize}` : null,
    `第 ${cur}/${totalPages} 页`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <nav className="stk-pager" aria-label="分页">
      <div className="stk-pager-meta" aria-live="polite">
        {meta}
      </div>
      <div className="stk-pager-ctl">
        <button
          type="button"
          className="stk-pager-dir"
          onClick={() => onChange(cur - 1)}
          disabled={busy || cur <= 1}
          aria-label="上一页"
        >
          ‹
        </button>
        <div className="stk-pager-nums">
          {pageWindow(cur, totalPages).map((slot, i) =>
            slot === ELLIPSIS ? (
              <span className="stk-pager-gap" key={`gap-${i}`} aria-hidden="true">
                {ELLIPSIS}
              </span>
            ) : (
              <button
                type="button"
                key={slot}
                className={slot === cur ? 'stk-pager-num is-on' : 'stk-pager-num'}
                onClick={() => onChange(slot)}
                disabled={busy || slot === cur}
                aria-current={slot === cur ? 'page' : undefined}
                aria-label={`第 ${slot} 页`}
              >
                {slot}
              </button>
            ),
          )}
        </div>
        <button
          type="button"
          className="stk-pager-dir"
          onClick={() => onChange(cur + 1)}
          disabled={busy || cur >= totalPages}
          aria-label="下一页"
        >
          ›
        </button>
      </div>
    </nav>
  );
}
