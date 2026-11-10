/**
 * starmap/theme/ui.tsx — 深空 HUD 基础组件。
 *
 * 只做观感与可访问性，不含业务；所有业务星门复用这里，避免各写一套。
 */
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';

/* ---------- 卡片外壳 ---------- */
export function Card2(props: {
  title?: ReactNode;
  en?: string;
  right?: ReactNode;
  live?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className={'card2' + (props.className ? ' ' + props.className : '')} style={props.style}>
      {props.title !== undefined && (
        <div className="ch">
          <span className="ch-zh">{props.title}</span>
          {props.en && <span className="ch-en">{props.en}</span>}
          <span className="ch-right">
            {props.right}
            {props.live && <i className="live-dot" />}
          </span>
        </div>
      )}
      {props.children}
    </div>
  );
}

/* ---------- 指标格 ---------- */
export function StatRow(props: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="stat-row" style={{ gridTemplateColumns: `repeat(${Math.max(props.items.length, 1)}, 1fr)` }}>
      {props.items.map((it, i) => (
        <div className="stat-cell" key={i}>
          <b>{it.value}</b>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- 按钮 ---------- */
export function Btn(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  ghost?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const cls = ['sm-btn'];
  if (props.primary) cls.push('primary');
  if (props.danger) cls.push('danger');
  if (props.ghost) cls.push('ghost');
  if (props.small) cls.push('sm');
  return (
    <button
      type={props.type ?? 'button'}
      className={cls.join(' ')}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/* ---------- 药丸 ---------- */
export function Pill(props: { children: ReactNode; tone?: 'on' | 'ok' | 'warn' | 'bad'; title?: string }) {
  return (
    <span className={'pill' + (props.tone ? ' ' + props.tone : '')} title={props.title}>
      {props.children}
    </span>
  );
}

/* ---------- 字段列表 ---------- */
export function Fields(props: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="fields">
      {props.items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{it.k}</dt>
          <dd>{it.v ?? <span className="sm-dim2">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- 空态 ---------- */
export function Empty(props: { text: string; action?: ReactNode; hint?: string }) {
  return (
    <div className="st-empty">
      <div style={{ opacity: 0.5, fontSize: 18, letterSpacing: '0.2em' }}>· · ·</div>
      <div>{props.text}</div>
      {props.hint && <div className="sm-dim2" style={{ fontSize: 10, maxWidth: 280 }}>{props.hint}</div>}
      {props.action}
    </div>
  );
}

/* ---------- 骨架 ---------- */
export function Skeleton(props: { rows?: number; height?: number }) {
  const rows = props.rows ?? 4;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: 2 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sk" style={{ height: props.height ?? 12, width: `${92 - (i % 4) * 13}%` }} />
      ))}
    </div>
  );
}

/* ---------- 提示条 ---------- */
export function Note(props: { children: ReactNode; tone?: 'bad' | 'warn' | 'ok' }) {
  return <div className={'sm-note' + (props.tone ? ' ' + props.tone : '')}>{props.children}</div>;
}

/* ---------- 分段控件 ---------- */
export function Seg<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm';
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: 'rgba(10,16,28,.6)', border: '1px solid var(--hair)' }}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            style={{
              height: props.size === 'sm' ? 20 : 24,
              padding: props.size === 'sm' ? '0 7px' : '0 10px',
              borderRadius: 6,
              fontSize: props.size === 'sm' ? 9.5 : 10.5,
              letterSpacing: '0.04em',
              color: on ? 'var(--ink)' : 'var(--dim2)',
              background: on ? 'rgba(60,120,200,.22)' : 'transparent',
              border: '1px solid ' + (on ? 'rgba(127,200,255,.36)' : 'transparent'),
              transition: 'all .16s',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- 对话框 ---------- */
export function Dialog(props: {
  title: ReactNode;
  en?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose]);
  return (
    <div className="dlg-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dlg" ref={ref} style={props.width ? { width: Math.min(props.width, 960) } : undefined} role="dialog" aria-modal="true">
        <div className="ch">
          <span className="ch-zh">{props.title}</span>
          {props.en && <span className="ch-en">{props.en}</span>}
          <span className="ch-right">
            <Btn ghost small onClick={props.onClose} title="关闭">✕</Btn>
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{props.children}</div>
        {props.footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>{props.footer}</div>
        )}
      </div>
    </div>
  );
}

/* ---------- 表单行 ---------- */
export function Field(props: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="sm-label">
        {props.label}
        {props.required && <span style={{ color: 'var(--bad)' }}> *</span>}
      </span>
      {props.children}
      {props.hint && <span className="sm-dim2" style={{ fontSize: 9.5 }}>{props.hint}</span>}
    </label>
  );
}

/* ---------- 时间/数字格式 ---------- */
export function formatTime(input?: string | number | null): string {
  if (input === undefined || input === null || input === '') return '—';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDay(input?: string | number | null): string {
  const t = formatTime(input);
  return t === '—' ? t : t.slice(0, 10);
}

export function agoText(input?: string | number | null): string {
  if (input === undefined || input === null || input === '') return '—';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  const diff = Date.now() - d.getTime();
  if (!Number.isFinite(diff)) return '—';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + ' 天前';
  return formatDay(input);
}

/* ---------- 错误文本 ---------- */
export function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  return '未知错误';
}
