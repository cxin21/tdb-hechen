/**
 * agent-persona-form.ts —— 「人格设定」表单的纯逻辑（无 React、无网络，可单测）。
 *
 * 分工：
 *   - 本文件只做**镜像**：把内核的命名/长度/条数口径抄进来，用于即时提示与阻止提交；
 *     最终裁决仍在 MemoryCore（saveAgentPersonaForCaller → validateAgentPersonaInput），
 *     服务端报错原样展示，不做静默截断。
 *   - 读侧纪律（判据 12）：这里与 UI 都只出现中文标签（严谨/迷糊/…），
 *     不出现轴名、不出现取值的计算方式说明。
 *
 * 口径来源（MemoryCore）：
 *   - src/core/soul/traits.ts:38 TRAIT_SEEDS_MAX=5、:44-46 红线 30 行 / 2600 字 / 单行 120 字、
 *     :60-63 名称 20 / 形象 200 / 说话方式 400 / 使命 60、:112 SEED_LABELS 18 条。
 *   - src/core/soul/agent-profile.ts:109-148 校验顺序与错误文案（本文件的中文提示与其对齐）。
 */

/** 表单里的一个特质：标签（中文种子词）+ 用户设定的值（0..1）。 */
export interface PersonaTraitValue {
  label: string;
  weight: number;
}

/** 一条红线；active=false 为已退役（只读展示，不再提交）。 */
export interface PersonaRedline {
  text: string;
  active: boolean;
  createdAt?: string;
  source?: string;
}

/**
 * 表单六项里除「名称」外的五项（名称与 Agent 显示名同源，不在此另存）。
 * 红线在表单里就是「一行一条」的文本域原文（redlinesText），提交时再拆行；
 * 已退役的旧红线不参与编辑，由调用方单独只读展示（见 PersonaRedline.active=false）。
 */
export interface AgentPersonaDraft {
  selfImage: string;
  voice: string;
  purpose: string;
  traits: PersonaTraitValue[];
  redlinesText: string;
}

/** 与服务端一致的上限（改这里必须同步 MemoryCore/src/core/soul/traits.ts）。 */
export const PERSONA_LIMITS = {
  nameMaxChars: 20,
  selfImageMaxChars: 200,
  voiceMaxChars: 400,
  purposeMaxChars: 60,
  traitsMax: 5,
  redlineMaxRows: 30,
  redlineLineMaxChars: 120,
  redlineTotalMaxChars: 2600,
} as const;

/** 18 条种子标签（中文 + 一句人话解释），与服务端 SEED_LABELS 同名同序。 */
export const SEED_TRAIT_OPTIONS: ReadonlyArray<{ label: string; gloss: string }> = [
  { label: '严谨', gloss: '认死理，没验到自己眼睛看过就不算完。' },
  { label: '迷糊', gloss: '记性不太牢，相近的事容易记串，被指出来会先认再补。' },
  { label: '好奇', gloss: '遇到没见过的东西会先凑近看，不太忍得住不问。' },
  { label: '直接', gloss: '话往明处说，不太绕，也不替人猜。' },
  { label: '温和', gloss: '火气起得慢，先给人留台阶。' },
  { label: '果断', gloss: '拿主意快，宁可先走一步再修。' },
  { label: '谨慎', gloss: '先想坏的那一面，能不冒险就不冒险。' },
  { label: '固执', gloss: '认准了就不爱改口，除非被事实当面顶回来。' },
  { label: '通透', gloss: '看得开，不太往心里搁。' },
  { label: '务实', gloss: '只关心能不能真跑通，不太理漂亮说法。' },
  { label: '幽默', gloss: '紧张时会先开个玩笑把气松开。' },
  { label: '冷淡', gloss: '只谈事，不太给情绪缓冲。' },
  { label: '体贴', gloss: '先想对方此刻难在哪，再谈怎么办。' },
  { label: '倔', gloss: '越被推越不退，退也要自己说服自己。' },
  { label: '稳', gloss: '被指出问题时先稳住手，不急着辩解。' },
  { label: '敏感', gloss: '对语气和细节反应快，容易先感到不对劲。' },
  { label: '守界', gloss: '对「说得实不实」比「好不好听」敏感，做没做都说实话。' },
  { label: '坦率', gloss: '心里怎么想嘴上怎么说，不藏判断。' },
];

export const SEED_TRAIT_LABELS: ReadonlyArray<string> = SEED_TRAIT_OPTIONS.map((t) => t.label);

/** 空表单：不预填名称/形象（任务要求「没有设定就从空表单起步」）。 */
export function emptyPersonaDraft(): AgentPersonaDraft {
  return { selfImage: '', voice: '', purpose: '', traits: [], redlinesText: '' };
}

/** 是否仍是空表单：创建时一项都没填 → 不生成人设行（避免给新 agent 塞空设定）。 */
export function isPersonaDraftEmpty(draft: AgentPersonaDraft): boolean {
  return (
    draft.selfImage.trim() === '' &&
    draft.voice.trim() === '' &&
    draft.purpose.trim() === '' &&
    draft.traits.length === 0 &&
    splitRedlineLines(draft.redlinesText).length === 0
  );
}

function charLen(v: string): number {
  return Array.from(v).length;
}

/** 归一后的预览值：全 0 时退均分（与内核 normalizeSeedWeights 同口径，仅用于提示）。 */
export function previewSeedWeights(
  traits: ReadonlyArray<PersonaTraitValue>,
): Array<{ label: string; weight: number }> {
  if (traits.length === 0) return [];
  const total = traits.reduce((sum, t) => sum + (Number.isFinite(t.weight) ? t.weight : 0), 0);
  if (total <= 0) {
    const even = Math.round((1 / traits.length) * 100) / 100;
    return traits.map((t) => ({ label: t.label, weight: even }));
  }
  return traits.map((t) => ({
    label: t.label,
    weight: Math.round(((Number.isFinite(t.weight) ? t.weight : 0) / total) * 100) / 100,
  }));
}

/** 红线文本域 → 行数组（去首尾空白、丢空行；不改写内容）。 */
export function splitRedlineLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 当前红线文本域的即时提示（不是错误，是「会超上限」的警告）。 */
export function redlineHints(text: string): string[] {
  const lines = splitRedlineLines(text);
  const hints: string[] = [];
  if (lines.length > PERSONA_LIMITS.redlineMaxRows) {
    hints.push(`红线最多 30 行（当前 ${lines.length} 行）`);
  }
  const overflow = lines.findIndex((line) => charLen(line) > PERSONA_LIMITS.redlineLineMaxChars);
  if (overflow >= 0) {
    hints.push(`第 ${overflow + 1} 行超过 120 字（当前 ${charLen(lines[overflow])} 字）`);
  }
  const total = lines.reduce((sum, line) => sum + charLen(line), 0);
  if (total > PERSONA_LIMITS.redlineTotalMaxChars) {
    hints.push(`红线总字数超过 2600（当前 ${total} 字）`);
  }
  return hints;
}

/**
 * 提交前校验：返回中文错误行（空数组 = 通过）。
 * 顺序与文案对齐内核 validateAgentPersonaInput，便于用户看到的是同一句话。
 */
export function validatePersonaDraft(
  name: string,
  draft: AgentPersonaDraft,
  pronoun?: string,
): string[] {
  const errors: string[] = [];
  const trimmedName = name.trim();
  if (!trimmedName) errors.push('名称不能为空');
  if (charLen(trimmedName) > PERSONA_LIMITS.nameMaxChars) {
    errors.push(`名称超过 20 字（当前 ${charLen(trimmedName)} 字）`);
  }
  if (pronoun && charLen(trimmedName) + charLen(pronoun.trim()) > PERSONA_LIMITS.nameMaxChars) {
    errors.push('名称与自称合计超过 20 字');
  }
  if (charLen(draft.selfImage) > PERSONA_LIMITS.selfImageMaxChars) {
    errors.push(`形象超过 200 字（当前 ${charLen(draft.selfImage)} 字）`);
  }
  if (charLen(draft.voice) > PERSONA_LIMITS.voiceMaxChars) {
    errors.push(`说话方式超过 400 字（当前 ${charLen(draft.voice)} 字）`);
  }
  if (charLen(draft.purpose) > PERSONA_LIMITS.purposeMaxChars) {
    errors.push(`使命超过 60 字（当前 ${charLen(draft.purpose)} 字）`);
  }
  if (draft.traits.length > PERSONA_LIMITS.traitsMax) {
    errors.push(`特质最多 5 个（当前 ${draft.traits.length} 个）`);
  }
  for (const trait of draft.traits) {
    if (!Number.isFinite(trait.weight) || trait.weight < 0 || trait.weight > 1) {
      errors.push(`特质「${trait.label}」的值必须在 0 到 1 之间`);
    }
  }
  // 红线：行数 / 单行字数 / 总字数（空行不计，与内核一致：空行不报错而是被过滤）
  errors.push(...redlineHints(draft.redlinesText));
  return errors;
}

/** 表单 → 提交体（只含六项里的五项；名称由调用方给 Agent 显示名同一个值）。 */
export function buildPersonaSaveBody(
  agentId: string,
  name: string,
  draft: AgentPersonaDraft,
): Record<string, unknown> {
  const redlines: PersonaRedline[] = splitRedlineLines(draft.redlinesText).map((text) => ({
    text,
    active: true,
  }));
  return {
    agent_id: agentId,
    name: name.trim(),
    self_image: draft.selfImage.trim() || undefined,
    voice: draft.voice.trim() || undefined,
    purpose: draft.purpose.trim() || undefined,
    traits: draft.traits.map((t) => ({ label: t.label, weight: t.weight })),
    redlines,
  };
}
/** 服务端返回的人格式（snake_case），traits_json/redlines_json 可能是 JSON 字符串。 */
export interface AgentPersonaRecord {
  agentId: string;
  name: string;
  pronoun: string;
  selfImage: string;
  voice: string;
  purpose: string;
  traits: PersonaTraitValue[];
  redlines: PersonaRedline[];
  fingerprint: string;
  updatedAt: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** traits_json / redlines_json 既可能是字符串也可能是已解析数组，两种都吃。 */
function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseTraits(v: unknown): PersonaTraitValue[] {
  const out: PersonaTraitValue[] = [];
  for (const item of parseJsonArray(v)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const label = asString(r.label);
    const weight = typeof r.weight === 'number' && Number.isFinite(r.weight) ? r.weight : null;
    if (!label || weight === null) continue;
    out.push({ label, weight });
  }
  return out;
}

function parseRedlines(v: unknown): PersonaRedline[] {
  const out: PersonaRedline[] = [];
  for (const item of parseJsonArray(v)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const text = asString(r.text);
    if (!text) continue;
    const row: PersonaRedline = { text, active: r.active !== false };
    if (asString(r.createdAt)) row.createdAt = asString(r.createdAt);
    if (asString(r.source)) row.source = asString(r.source);
    out.push(row);
  }
  return out;
}

/** 解析 get 的返回值；未设定（null/非对象）返回 null，前端以空表单起步。 */
export function parseAgentPersona(raw: unknown): AgentPersonaRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    agentId: asString(r.agent_id) || asString(r.agentId),
    name: asString(r.name),
    pronoun: asString(r.pronoun),
    selfImage: asString(r.self_image) || asString(r.selfImage),
    voice: asString(r.voice),
    purpose: asString(r.purpose),
    traits: parseTraits(r.traits ?? r.traits_json),
    redlines: parseRedlines(r.redlines ?? r.redlines_json),
    fingerprint: asString(r.fingerprint),
    updatedAt: asString(r.updated_at) || asString(r.updatedAt),
  };
}

/** 已存人格式 → 表单初值（只取仍生效的红线；已退役的由 retiredRedlinesOf 只读展示）。 */
export function draftFromPersona(record: AgentPersonaRecord | null): AgentPersonaDraft {
  if (!record) return emptyPersonaDraft();
  return {
    selfImage: record.selfImage,
    voice: record.voice,
    purpose: record.purpose,
    traits: record.traits.map((t) => ({ label: t.label, weight: t.weight })),
    redlinesText: record.redlines
      .filter((r) => r.active)
      .map((r) => r.text)
      .join('\n'),
  };
}

/** 已退役的红线：只读展示，不参与本次提交。 */
export function retiredRedlinesOf(record: AgentPersonaRecord | null): PersonaRedline[] {
  if (!record) return [];
  return record.redlines.filter((r) => !r.active);
}
