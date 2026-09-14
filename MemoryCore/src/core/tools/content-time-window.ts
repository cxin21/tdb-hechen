/**
 * 时间窗解析（recollection 设计 §3：支持"当时查询"——query 含时间锚按时间窗过滤）。
 * 纯函数、无副作用、可单测。宁缺毋滥：解析不出明确时间窗 → 返回 null（不过滤）。
 */
export interface TimeWindow {
  start: string; // ISO
  end: string;   // ISO（exclusive 上界）
  label: string; // 命中的时间短语（供日志/说明）
}

const DAY_MS = 86_400_000;

/** 当前会话"今天"的本地零点。 */
function todayStart(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 从 query 解析相对时间窗。
 * 支持的锚：今天/今日、昨天/昨日、前天、本周/这周、上周、本月/这个月、上个月、
 *          今年/这一年、去年、N天前、N个月前、N年前、X月、X月Y日附近处理。
 * 返回 null = 无法解析出明确窗（宁缺毋滥，不误过滤）。
 */
export function parseTimeWindow(query: string, now = new Date()): TimeWindow | null {
  if (!query) return null;
  const q = query.trim();
  const t0 = todayStart(now);
  const nowMs = now.getTime();

  // 今天 / 昨天 / 前天（中文无词边界，不用 \b）
  let m = q.match(/(?:今天|今日|昨天|昨日|前天|前一天)/);
  if (m) {
    const key = m[0];
    const offsetDays = key === "今天" || key === "今日" ? 0 : key === "昨天" || key === "昨日" ? 1 : 2;
    const start = t0 - offsetDays * DAY_MS;
    return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString(), label: key };
  }

  // N 天/周/月/年前
  m = q.match(/(\d+)\s*(天|周|月|年)(前|以前|之前)/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const back = unit === "天" ? n * DAY_MS : unit === "周" ? n * 7 * DAY_MS : unit === "月" ? n * 30 * DAY_MS : n * 365 * DAY_MS;
    const start = nowMs - back - 0.5 * DAY_MS;
    return { start: new Date(start).toISOString(), end: new Date(nowMs).toISOString(), label: `${n}${unit}前` };
  }

  // 本周 / 上周
  m = q.match(/(本|这|上)(周|星期|礼拜)/);
  if (m) {
    const day = now.getDay() || 7; // 周日=7
    const thisWeekMonday = t0 - (day - 1) * DAY_MS;
    const back = m[1] === "上" ? 7 : 0;
    const start = thisWeekMonday - back * DAY_MS;
    return { start: new Date(start).toISOString(), end: new Date(start + 7 * DAY_MS).toISOString(), label: `${m[1]}周` };
  }

  // 本月 / 上个月
  m = q.match(/(本|这|上)个?(月|月份)/);
  if (m) {
    const y = now.getFullYear();
    const mo = now.getMonth();
    const back = m[1] === "上" ? 1 : 0;
    const start = new Date(y, mo - back, 1).getTime();
    const end = new Date(y, mo - back + 1, 1).getTime();
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `${m[1]}月` };
  }

  // 今年 / 去年
  m = q.match(/(今|去|前)年/);
  if (m) {
    const y = now.getFullYear();
    const back = m[1] === "今" ? 0 : m[1] === "去" ? 1 : 2;
    const start = new Date(y - back, 0, 1).getTime();
    const end = new Date(y - back + 1, 0, 1).getTime();
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `${m[1]}年` };
  }

  // "X月"（当年该月）——避免把"12月份计划"误判，需 X 在 1-12 且不以"份"结尾歧义弱处理
  m = q.match(/(\d{1,2})\s*月(?!份|底|初)/);
  if (m) {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) {
      const y = now.getFullYear();
      const start = new Date(y, month - 1, 1).getTime();
      const end = new Date(y, month, 1).getTime();
      if (start <= nowMs) {
        return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `${month}月` };
      }
    }
  }

  return null;
}

/** 判断一条记忆的 occurred_at 是否落在窗内（None 时间 → 不参与时间过滤）。 */
export function inTimeWindow(occurredAt: string | undefined, win: TimeWindow): boolean {
  if (!occurredAt) return true; // 无时间锚的记忆宁缺毋滥：不拦（避免误杀缺时间字段的存量）
  const ts = new Date(occurredAt).getTime();
  if (Number.isNaN(ts)) return true;
  const s = new Date(win.start).getTime();
  const e = new Date(win.end).getTime();
  return ts >= s && ts < e;
}