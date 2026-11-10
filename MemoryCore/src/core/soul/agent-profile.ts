/**
 * 人格层 v3.7 · agent 设定读取接缝（D1）。
 *
 * 设定是「team + agent 级」的：调 readAgentProfile(agentId) 就够了，不需要 team/user。
 * 本模块只做「读一行 + 归一 + 校验 + 指纹」，不碰库、不写库：
 * - 读：通过 port 拿一行 meta_agent_persona（gateway 实现 port，worker 不直接开 metadata 库）。
 * - 校验：服务端强制表单上限（§1），Panel 只是镜像；越界一律拒绝，不静默截断。
 * - 指纹：sha256(name|pronoun|image|voice|purpose|traits|redlines)，每 tick 比一次决定要不要重建卡。
 */

import { createHash } from "node:crypto";
import {
  NAME_MAX_CHARS,
  PROFILE_NAME_MAX_CHARS,
  PROFILE_PURPOSE_MAX_CHARS,
  PROFILE_SELF_IMAGE_MAX_CHARS,
  PROFILE_VOICE_MAX_CHARS,
  REDLINE_LINE_MAX_CHARS,
  REDLINE_MAX_ROWS,
  REDLINE_TOTAL_MAX_CHARS,
  SEED_LABELS,
  TRAIT_SEEDS_MAX,
  clamp,
} from "./traits.js";

export interface AgentProfileTrait {
  /** 必须是 SEED_LABELS 里的 label（特质只允许 18 条种子，不允许自由造词）。 */
  label: string;
  /** 初始权重，0..1，保存时归一到 Σ=1（F4：不加 intensity 列）。 */
  weight: number;
}

export interface AgentRedline {
  text: string;
  /** 退役 = active:false（记账本，不物理删）。 */
  active: boolean;
  createdAt: string;
  /** 合并/退役时追加的来源标记（如 "merged:rl_3"、"retired:2026-11-07"）。 */
  source?: string;
}

/**
 * 读端口的宽容形状：worker 与卡只用到这几个字段。
 * 测试桩不必造满 AgentProfile（fingerprint/updatedAt 等只在存储侧有意义）。
 */
export interface AgentProfileLike {
  name?: string;
  pronoun?: string;
  selfImage?: string;
  voice?: string;
  purpose?: string;
  traits?: AgentProfileTrait[];
  redlines?: Array<{ text: string; active?: boolean; createdAt?: string }>;
}

export interface AgentPersonaRow {
  agentId: string;
  teamId: string;
  name: string;
  pronoun: string;
  selfImage: string;
  voice: string;
  purpose: string;
  traitsJson: string;
  redlinesJson: string;
  schemaVersion: number;
  fingerprint: string;
  updatedAt: string;
}

/** D1 的返回值：卡与 worker 都只吃这一份形状。 */
export interface AgentProfile {
  agentId: string;
  teamId: string;
  name: string;
  pronoun: string;
  selfImage: string;
  voice: string;
  purpose: string;
  traits: AgentProfileTrait[];
  redlines: AgentRedline[];
  fingerprint: string;
  updatedAt: string;
}

/** gateway 侧的 metadata 读取端口（唯一跨库入口）。 */
export interface AgentPersonaPort {
  getAgentPersona(agentId: string): Promise<AgentPersonaRow | null> | AgentPersonaRow | null;
}

export interface AgentPersonaInput {
  name?: string;
  pronoun?: string;
  selfImage?: string;
  voice?: string;
  purpose?: string;
  traits?: AgentProfileTrait[];
  redlines?: Array<Pick<AgentRedline, "text"> & Partial<Pick<AgentRedline, "active" | "createdAt" | "source">>>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SEED_LABEL_SET = new Set(SEED_LABELS.map((s) => s.label));

/** 名称+自称合计 ≤20 字（§1「名称+自称 20 字」）。 */
export function validateAgentPersonaInput(input: AgentPersonaInput): ValidationResult {
  const errors: string[] = [];
  const name = (input.name ?? "").trim();
  const pronoun = (input.pronoun ?? "").trim();
  if (!name) errors.push("name 不能为空");
  if (name.length > PROFILE_NAME_MAX_CHARS) errors.push(`name 超过 ${PROFILE_NAME_MAX_CHARS} 字`);
  if (name.length + pronoun.length > PROFILE_NAME_MAX_CHARS) {
    errors.push(`name+pronoun 合计超过 ${PROFILE_NAME_MAX_CHARS} 字`);
  }
  if ((input.selfImage ?? "").length > PROFILE_SELF_IMAGE_MAX_CHARS) {
    errors.push(`selfImage 超过 ${PROFILE_SELF_IMAGE_MAX_CHARS} 字`);
  }
  if ((input.voice ?? "").length > PROFILE_VOICE_MAX_CHARS) {
    errors.push(`voice 超过 ${PROFILE_VOICE_MAX_CHARS} 字`);
  }
  if ((input.purpose ?? "").length > PROFILE_PURPOSE_MAX_CHARS) {
    errors.push(`purpose 超过 ${PROFILE_PURPOSE_MAX_CHARS} 字`);
  }
  const traits = input.traits ?? [];
  if (traits.length > TRAIT_SEEDS_MAX) errors.push(`traits 超过 ${TRAIT_SEEDS_MAX} 个`);
  const seen = new Set<string>();
  for (const t of traits) {
    if (!SEED_LABEL_SET.has(t.label)) errors.push(`未知种子标签：${t.label}`);
    if (seen.has(t.label)) errors.push(`重复种子标签：${t.label}`);
    seen.add(t.label);
    if (!Number.isFinite(t.weight) || t.weight < 0 || t.weight > 1) {
      errors.push(`标签 ${t.label} 的权重必须在 0..1`);
    }
  }
  const active = (input.redlines ?? []).filter((r) => r.active !== false);
  if (active.length > REDLINE_MAX_ROWS) errors.push(`红线超过 ${REDLINE_MAX_ROWS} 行`);
  for (const r of active) {
    const text = (r.text ?? "").trim();
    if (!text) errors.push("红线不能为空行");
    if (text.length > REDLINE_LINE_MAX_CHARS) errors.push(`红线单行超过 ${REDLINE_LINE_MAX_CHARS} 字：${text.slice(0, 20)}…`);
  }
  const total = active.reduce((sum, r) => sum + (r.text ?? "").trim().length, 0);
  if (total > REDLINE_TOTAL_MAX_CHARS) errors.push(`红线总字符超过 ${REDLINE_TOTAL_MAX_CHARS}`);
  return { ok: errors.length === 0, errors };
}

/** 权重归一到 Σ=1（F4）；无权重或全 0 时退化为均分。 */
export function normalizeSeedWeights(traits: AgentProfileTrait[]): AgentProfileTrait[] {
  const clean = traits
    .filter((t) => SEED_LABEL_SET.has(t.label))
    .map((t) => ({ label: t.label, weight: clamp(Number(t.weight) || 0, 0, 1) }));
  const total = clean.reduce((s, t) => s + t.weight, 0);
  if (clean.length === 0) return [];
  if (total <= 1e-9) {
    const even = 1 / clean.length;
    return clean.map((t) => ({ ...t, weight: even }));
  }
  return clean.map((t) => ({ ...t, weight: t.weight / total }));
}

/** 指纹只算「进 prompt 的设定」：traits 按 label 排序、红线只取 active。 */
export function computeProfileFingerprint(p: {
  name: string;
  pronoun: string;
  selfImage: string;
  voice: string;
  purpose: string;
  traits: AgentProfileTrait[];
  redlines: Array<Pick<AgentRedline, "text" | "active">>;
}): string {
  const traits = [...p.traits]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((t) => `${t.label}:${t.weight.toFixed(4)}`)
    .join(",");
  const redlines = p.redlines
    .filter((r) => r.active !== false)
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join("\n");
  const material = [p.name, p.pronoun, p.selfImage, p.voice, p.purpose, traits, redlines].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function parseTraits(raw: string): AgentProfileTrait[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({ label: String(x?.label ?? ""), weight: Number(x?.weight) }))
      .filter((x) => SEED_LABEL_SET.has(x.label) && Number.isFinite(x.weight));
  } catch {
    return [];
  }
}

function parseRedlines(raw: string): AgentRedline[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        text: String(x?.text ?? "").trim(),
        active: x?.active !== false,
        createdAt: String(x?.createdAt ?? x?.created_at ?? ""),
        source: x?.source ? String(x.source) : undefined,
      }))
      .filter((x) => x.text.length > 0);
  } catch {
    return [];
  }
}

/** 行 → AgentProfile；指纹缺失时按当前内容补算（只读，不写库）。 */
export function normalizeAgentPersona(row: AgentPersonaRow): AgentProfile {
  const traits = normalizeSeedWeights(parseTraits(row.traitsJson));
  const redlines = parseRedlines(row.redlinesJson);
  const fingerprint = row.fingerprint?.trim() ? row.fingerprint : computeProfileFingerprint({ ...row, traits, redlines } as never);
  return {
    agentId: row.agentId,
    teamId: row.teamId,
    name: row.name,
    pronoun: row.pronoun ?? "",
    selfImage: row.selfImage ?? "",
    voice: row.voice ?? "",
    purpose: row.purpose ?? "",
    traits,
    redlines,
    fingerprint,
    updatedAt: row.updatedAt,
  };
}

/**
 * 只读接缝：agent 没有设定行时返回 null（卡走默认值，不报错、不写库）。
 * gate 层每 tick 调一次 + 比 fingerprint，所以这里禁止任何副作用。
 */
export async function readAgentProfile(agentId: string, port: AgentPersonaPort): Promise<AgentProfile | null> {
  if (!agentId) return null;
  const row = await port.getAgentPersona(agentId);
  if (!row) return null;
  return normalizeAgentPersona(row);
}

/** 表单默认值（新建 agent 未填设定时卡里用的兜底名）。 */
export const DEFAULT_PERSONA_NAME_MAX = NAME_MAX_CHARS;
