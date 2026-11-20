/**
 * starmap/theme/ui.tsx — 旧版 HUD 组件的**兼容层**（P6）。
 *
 * 这些名字（Card2 / StatRow / Btn / Pill / Fields / Empty / Skeleton / Note / Seg / Dialog）
 * 还被四个旧站页与总览侧栏引用。现在它们全部**转发到 kit**：
 *  - DOM 里不再出现 `.card2` / `.ch-en` / `.pill` / `.fields` / `.dlg` 这些旧类名；
 *  - 视觉口径统一由 `kit.css` + tokens 决定（实底 Surface、无英文副标、无填充块选中态）；
 *  - 组件签名保持不变，调用点零改动。
 *
 * 真正的删除要等旧站页被 P7 重写；在那之前这里是唯一出口，别再往这个文件加新组件。
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import {
  Dialog as KitDialog,
  Empty as KitEmpty,
  KvList,
  MetricRow,
  Note as KitNote,
  Seg as KitSeg,
  Skeleton as KitSkeleton,
  Surface,
  Tag,
} from '../kit';

/* ---------- 卡片外壳 → Surface（丢掉 en 英文副标与 live 呼吸点） ---------- */
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
    <Surface title={props.title} aside={props.right} className={props.className} style={props.style}>
      {props.children}
    </Surface>
  );
}

/* ---------- 指标格 → MetricRow（去掉格线） ---------- */
export function StatRow(props: { items: { label: string; value: ReactNode }[] }) {
  return <MetricRow items={props.items.map((it) => ({ k: it.label, v: it.value }))} />;
}

/* ---------- 按钮 → kit 按钮类 ---------- */
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
  const cls = ['stk-btn'];
  if (props.ghost) cls.push('is-ghost');
  if (props.danger) cls.push('is-danger');
  if (props.small) cls.push('is-sm');
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

/* ---------- 药丸 → Tag ---------- */
export function Pill(props: { children: ReactNode; tone?: 'on' | 'ok' | 'warn' | 'bad'; title?: string }) {
  const tone = props.tone === 'on' ? 'ink' : props.tone;
  return (
    <Tag tone={tone} title={props.title}>
      {props.children}
    </Tag>
  );
}

/* ---------- 字段列表 → KvList ---------- */
export function Fields(props: { items: { k: string; v: ReactNode; mono?: boolean }[] }) {
  return <KvList items={props.items} />;
}

/* ---------- 空态 → kit Empty ---------- */
export function Empty(props: { text: string; action?: ReactNode; hint?: string }) {
  return <KitEmpty title={props.text} hint={props.hint} action={props.action} />;
}

/* ---------- 骨架 → kit Skeleton ---------- */
export function Skeleton(props: { rows?: number; height?: number }) {
  return <KitSkeleton rows={props.rows ?? 4} />;
}

/* ---------- 提示条 → kit Note ---------- */
export function Note(props: { children: ReactNode; tone?: 'bad' | 'warn' | 'ok' }) {
  if (props.tone === 'bad') return <KitNote tone="bad">{props.children}</KitNote>;
  if (props.tone === 'warn') return <KitNote tone="warn">{props.children}</KitNote>;
  return <KitNote>{props.children}</KitNote>;
}

/* ---------- 分段控件 → kit Seg ---------- */
export function Seg<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm';
}) {
  return (
    <KitSeg
      value={props.value}
      options={props.options}
      onChange={props.onChange}
      size={props.size === 'sm' ? 'sm' : 'md'}
    />
  );
}

/* ---------- 对话框 → kit Dialog（补 Esc / 焦点 / 遮罩行为） ---------- */
export function Dialog(props: {
  title: ReactNode;
  en?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <KitDialog title={props.title} onClose={props.onClose} footer={props.footer} width={props.width}>
      {props.children}
    </KitDialog>
  );
}

/* ---------- 表单行（唯一没迁移的旧件：它只是 label + 子元素，没有视觉债） ---------- */
export function Field(props: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className="stk-field-label">
      <span className="stk-field-k">
        {props.label}
        {props.required && <span className="stk-field-req"> *</span>}
      </span>
      {props.children}
      {props.hint && <span className="stk-field-hint">{props.hint}</span>}
    </label>
  );
}

/* ---------- 时间/数字格式（纯函数，与视觉无关） ---------- */
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
