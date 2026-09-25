/**
 * D-2（2026-09-21）：人物锚专视图纯逻辑（零后端新端点——数据全来自既有
 * valuesList / searchLayer 出参）。
 *
 * 单一源声明：方向词映射与 soul-assembler personDir 同语义（1 趋近/-1 回避/0 中性）；
 * 证据链口径与 ValueAnchorsPanel.handleViewRelated 同口径（label+aliases 反查、
 * personRefs 命中过滤、record_id 去重）——本模块把该口径收敛为可测纯函数。
 * 宁缺毋滥：attrs 损坏宽松降级 {}；personRefs 空/缺失全滤。
 */

export interface PersonRow {
  value_id: string;
  label: string;
  weight?: number;
  valence: number | null;
  role?: string;
  aliases: string[];
  /** V12-PERSONDESC：锚语义（attrs_json.description），PersonSection 渲染行。 */
  description?: string;
}

export interface PersonEvidenceItem {
  id: string;
  body: string;
  occurredAt?: string;
  certainty?: string;
}

/** attrs_json 宽松解析（损坏/缺失 → {}，只损失 role/aliases 维度——soul-assembler 同款）。 */
export function parsePersonAttrs(raw: unknown): { role?: string; aliases: string[]; description?: string } {
  try {
    const p = typeof raw === 'string' && raw !== '{}' ? (JSON.parse(raw) as { role?: unknown; aliases?: unknown; description?: unknown }) : {};
    return {
      role: typeof p?.role === 'string' ? p.role : undefined,
      aliases: Array.isArray(p?.aliases) ? p.aliases.map(String) : [],
      // V12-PERSONDESC：锚语义透传（注入行同源；用户看不到=没做）。
      description: typeof p?.description === 'string' ? p.description : undefined,
    };
  } catch {
    return { aliases: [], description: undefined };
  }
}

/** 人物关系方向词（personDir 同语义：回避≠审慎，spec §2.7）。 */
export function directionLabel(v: number | null | undefined): string {
  if (v === 1) return '趋近';
  if (v === -1) return '回避';
  if (v === 0) return '中性';
  return '';
}

/** 人物锚行构建：仅收 active 人物锚（node_type==='person'；旧库缺省 undefined=theme 排除）。 */
export function buildPersonRows(values: Array<Record<string, unknown>>): PersonRow[] {
  return values
    .filter((v) => v.node_type === 'person' && (v.state === undefined || v.state === 'active'))
    .map((v) => {
      const attrs = parsePersonAttrs(v.attrs_json);
      return {
        value_id: String(v.value_id ?? ''),
        label: String(v.label ?? ''),
        weight: typeof v.weight === 'number' ? v.weight : undefined,
        valence: typeof v.valence === 'number' ? v.valence : null,
        role: attrs.role,
        aliases: attrs.aliases,
        description: attrs.description,
      };
    });
}

/**
 * 证据链收集：多查询（label+aliases）反查结果合并 → personRefs 命中过滤 →
 * record_id 去重（与 VAP handleViewRelated 反查口径同款；queries 参数由调用方
 * [label, ...aliases] 传入）。
 */
export function collectPersonEvidence(
  items: Array<Record<string, unknown>>,
  queries: string[],
): PersonEvidenceItem[] {
  const seen = new Set<string>();
  const out: PersonEvidenceItem[] = [];
  for (const item of items) {
    const id = String(item.id ?? item.record_id ?? '');
    if (!id || seen.has(id)) continue;
    const meta = (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<string, unknown>;
    const refs = Array.isArray(meta.personRefs) ? meta.personRefs.map(String) : [];
    if (!queries.some((q) => refs.includes(q))) continue;
    seen.add(id);
    out.push({
      id,
      body: typeof item.body === 'string' ? item.body : '',
      occurredAt: typeof item.occurred_at === 'string' && item.occurred_at ? item.occurred_at : undefined,
      certainty: typeof item.certainty === 'string' ? item.certainty : undefined,
    });
  }
  return out;
}

/**
 * D-2b（V-02 P0 安全，2026-09-21）：凭据掩码——证据链正文入 UI 前统一过本函数。
 * 规则：① 长 token（≥24 位连续字母数字，含 -/_）掩中段留前 4 后 4；
 * ② 显式键值模式（api_key=xxx / secret=xxx / Bearer xxx）整值掩码留前 4；
 * ③ 域名/短词/数值/普通标点不误伤（宁缺毋滥反向：宁可漏掩不可破文）。
 * 用途：PersonSection 证据行渲染（截图/快照/导出均走渲染层——渲染即脱敏）。
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // 显式 key=value 形态（值 ≥16 位，字母数字下划线混合）
  out = out.replace(/((?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*)([A-Za-z0-9_-]{16,})/gi,
    (_m, p1: string, v: string) => `${p1}${v.slice(0, 4)}${'*'.repeat(6)}${v.slice(-4)}`);
  // Bearer 形态
  out = out.replace(/(Bearer\s+)([A-Za-z0-9._-]{16,})/gi,
    (_m, p1: string, v: string) => `${p1}${v.slice(0, 4)}${'*'.repeat(6)}${v.slice(-4)}`);
  // 通用长 token（≥24 位）：避免误伤 URL 里的单词与中文——仅匹配独立词
  out = out.replace(/(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{24,})([^A-Za-z0-9_-]|$)/g,
    (_m, pre: string, v: string, post: string) => `${pre}${v.slice(0, 4)}${'*'.repeat(6)}${v.slice(-4)}${post}`);
  return out;
}
