/**
 * task-83 B 段 —— L0 测试污染会话的「选择 + 计划」纯逻辑（无 IO、无副作用）。
 *
 * 背景（票面 m02082）：生产 vectors.db 里残留探针会话（probe-*、session-probe-*），
 * 合计 128 行 / 23 会话 / 905,703 字符，会持续污染 L1 抽取。清理工具
 * `scripts/l0-testdata-clean.ts` 把「选哪些会话 / 送什么 id 给删除接口 / 计划是否安全」
 * 全部委托给本模块，CLI 只负责 sqlite 只读读取、导出与 HTTP 调用 —— 这样判定逻辑
 * 可以单测（scripts/** 不在 typecheck 与 vitest 的默认范围内）。
 *
 * 安全不变量（本模块强制）：
 * 1. 只有**显式列出**（sessions）或**命中模式**（patterns，复用 session-ignore 前缀语义）
 *    的会话才进 delete 计划；其余行一律「保留」，只作读数。
 * 2. 送删除接口的 id 只取 session_key 与「非缺省 session_id」：
 *    l0_conversations.session_id 的列缺省值是字面量 'default'（sqlite.ts:1131），
 *    把它当 id 传下去会命中该身份下所有缺省会话 —— 等于清库。
 * 3. 计划里出现「既没命中模式、也没显式列出」的会话即视为不安全（报错，除非显式放行）。
 *
 * 分组口径与读面一致：/v3/conversation/delete 的 session 路径按
 * `session_key === id || session_id === id` 过滤（v2-router.ts:1397），所以一个会话
 * 可能有两个可删 id，二者都要带上。
 */
import { compileSessionIgnorePatterns } from "./session-ignore.js";

/** 只依赖我们真正会用到的列，其余列透传（导出时需要全列） */
export interface L0RowLike {
  record_id?: string;
  session_key?: string | null;
  session_id?: string | null;
  role?: string | null;
  message_text?: string | null;
  timestamp?: number | null;
  recorded_at?: string | null;
}

/** sqlite 里 session_id 的列缺省值：不可作为删除 id */
export const DEFAULT_SESSION_ID = "default";

export interface L0SessionGroup {
  /** 展示键（session_key 优先；为空时回落 session_id） */
  key: string;
  /** 送 /v3/conversation/delete 的 session_ids（去重、已剔除缺省值） */
  ids: string[];
  rows: number;
  /** UTF-16 长度（与 JS string.length 一致；沿用历史读数口径） */
  chars: number;
  /** UTF-8 字节数（导出体积参考） */
  bytes: number;
  firstSeen: string | null;
  lastSeen: string | null;
  roles: Record<string, number>;
  /** 命中来源：模式 / 显式列出；null = 未命中（保留） */
  matchedBy:
    | { kind: "pattern"; pattern: string; matchedOn: "session_id" | "session_key"; value: string }
    | { kind: "explicit" }
    | null;
}

export interface SelectL0SessionsOptions {
  /** 前缀模式（`*` 通配）；undefined = 用 session-ignore 缺省；[] = 不按模式选 */
  patterns?: string[];
  /** 显式会话键（session_key 或 session_id 精确匹配） */
  sessions?: string[];
}

export interface SelectL0SessionsResult {
  /** 命中、会被删除的会话（按 rows 降序） */
  selected: L0SessionGroup[];
  /** 未命中、必须保留的会话（按 rows 降序） */
  kept: L0SessionGroup[];
  selectedRows: number;
  selectedChars: number;
  keptRows: number;
  keptChars: number;
  totalRows: number;
}

function trimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isoOf(row: L0RowLike): string | null {
  const recordedAt = trimmed(row.recorded_at);
  if (recordedAt) return recordedAt;
  const ts = typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : 0;
  if (ts > 0) return new Date(ts).toISOString();
  return null;
}

/** 一个会话可被删除的 id 集合：session_key + 非缺省 session_id（见文件头不变量 2） */
export function deletableIdsOf(row: L0RowLike): string[] {
  const out: string[] = [];
  const key = trimmed(row.session_key);
  if (key) out.push(key);
  const sid = trimmed(row.session_id);
  if (sid && sid !== DEFAULT_SESSION_ID) out.push(sid);
  return out;
}

/** 分组键：session_key 优先（它是「对话」的主键），为空回落 session_id */
export function groupKeyOf(row: L0RowLike): string {
  return trimmed(row.session_key) || trimmed(row.session_id);
}

/**
 * 选会话 + 算读数。纯函数：不读库、不写库、不发请求。
 * 命中模式或显式列出 → selected；否则 → kept（保留）。
 */
export function selectL0Sessions(
  rows: readonly L0RowLike[],
  opts: SelectL0SessionsOptions = {},
): SelectL0SessionsResult {
  const matcher = compileSessionIgnorePatterns(opts.patterns);
  const explicit = new Set((opts.sessions ?? []).map((s) => s.trim()).filter(Boolean));
  const groups = new Map<string, L0SessionGroup>();

  for (const row of rows) {
    const key = groupKeyOf(row);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        ids: [],
        rows: 0,
        chars: 0,
        bytes: 0,
        firstSeen: null,
        lastSeen: null,
        roles: {},
        matchedBy: null,
      };
      groups.set(key, group);
    }

    const text = typeof row.message_text === "string" ? row.message_text : "";
    group.rows += 1;
    group.chars += text.length;
    group.bytes += Buffer.byteLength(text, "utf8");
    const role = trimmed(row.role) || "unknown";
    group.roles[role] = (group.roles[role] ?? 0) + 1;

    const seen = isoOf(row);
    if (seen) {
      if (!group.firstSeen || seen < group.firstSeen) group.firstSeen = seen;
      if (!group.lastSeen || seen > group.lastSeen) group.lastSeen = seen;
    }

    for (const id of deletableIdsOf(row)) {
      if (!group.ids.includes(id)) group.ids.push(id);
    }

    if (!group.matchedBy) {
      const hit = matcher.match(trimmed(row.session_id), trimmed(row.session_key));
      if (hit) {
        group.matchedBy = { kind: "pattern", pattern: hit.pattern, matchedOn: hit.matchedOn, value: hit.value };
      } else if (explicit.has(trimmed(row.session_key)) || explicit.has(trimmed(row.session_id))) {
        group.matchedBy = { kind: "explicit" };
      }
    }
  }

  const all = [...groups.values()];
  const selected = all.filter((g) => g.matchedBy !== null).sort((a, b) => b.rows - a.rows);
  const kept = all.filter((g) => g.matchedBy === null).sort((a, b) => b.rows - a.rows);
  const sum = (list: L0SessionGroup[], pick: (g: L0SessionGroup) => number) =>
    list.reduce((acc, g) => acc + pick(g), 0);

  return {
    selected,
    kept,
    selectedRows: sum(selected, (g) => g.rows),
    selectedChars: sum(selected, (g) => g.chars),
    keptRows: sum(kept, (g) => g.rows),
    keptChars: sum(kept, (g) => g.chars),
    totalRows: rows.length,
  };
}

/** 汇总成 /v3/conversation/delete 的 session_ids（去重、剔除空与缺省 id、排序稳定） */
export function buildDeleteSessionIds(selected: readonly L0SessionGroup[]): string[] {
  const ids = new Set<string>();
  for (const g of selected) {
    for (const id of g.ids) {
      const v = trimmed(id);
      if (!v || v === DEFAULT_SESSION_ID) continue;
      ids.add(v);
    }
  }
  return [...ids].sort();
}

export interface PlanSafetyOptions {
  /** 允许删除「未命中模式」的会话（仅对显式 --sessions 有意义） */
  allowUnmatched?: boolean;
}

/** 计划安全校验：返回错误清单（空 = 可执行） */
export function validatePlan(
  result: SelectL0SessionsResult,
  opts: PlanSafetyOptions = {},
): string[] {
  const errors: string[] = [];
  const ids = buildDeleteSessionIds(result.selected);
  if (result.selected.length === 0 || ids.length === 0) {
    // 先短路：没有可删 id 时后面那些「安全提示」全是噪音
    return ["选中 0 个会话：没有可删的 id（检查 --patterns / --sessions）"];
  }
  const onlyExplicit = result.selected.every((g) => g.matchedBy?.kind === "explicit");
  if (onlyExplicit && result.selected.length > 0 && !opts.allowUnmatched) {
    errors.push(
      "选中会话全部来自 --sessions（未命中模式）：确认这是测试数据请加 --allow-unmatched-sessions",
    );
  }
  for (const id of ids) {
    if (id === DEFAULT_SESSION_ID) errors.push(`拒绝把缺省 session_id "${DEFAULT_SESSION_ID}" 当作删除 id`);
  }
  return errors;
}
