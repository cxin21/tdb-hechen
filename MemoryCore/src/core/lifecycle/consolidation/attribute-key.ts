/**
 * B1（P6）属性键：（entity, attribute）归一，替代 metadata.subject 整串相等。
 *
 * 病灶（research §3.P6）：全史 862 条反思类 L2 共用 subject="反思结论"，巩固层只能合成
 * 一张巨卡（10 张卡承载全部历史）。第一性原理：卡的身份不是"主题字符串"，而是
 * "哪个实体 + 哪一类属性"——(entity, attribute) 才是可重用、可累积的槽位。
 *
 * 纪律：
 *  - 纯函数、无 IO、无 embedding（embedding 兜底在 grouping.ts，属异步编排层）；
 *  - 归一不了就返回 null，交给调用方 embedding 兜底——**不猜、不用原始字符串充数**
 *    （那等于把 subject 键换个马甲）；
 *  - entity 复用仓里既有提取顺序（work_object/coreRefs/personRefs/文本主语 subjectOf）；
 *  - attribute 复用事实层封闭词表（core/record/fact-attribute.ts），表外再走本文件
 *    受限谓词表（声明顺序即优先级），两者都归一不了 → null。
 */
import { normalizeFactAttribute } from "../../record/fact-attribute.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

/** 属性键分隔符（entity|attribute）。导出以便测试/日志按同一口径拆键。 */
export const ATTRIBUTE_KEY_SEPARATOR = "|";

/** entity 归一后的长度上限（防单个异常长主语把键膨胀成不可比对的字符串）。 */
const MAX_ENTITY_CHARS = 48;

/**
 * 巩固层受限属性词表（9 个）：只收"反思/工作事实"里高频、且彼此语义互斥的属性类。
 * 声明顺序即匹配优先级——先根因（最具体）后反思（最泛），避免"复盘发现是根因"
 * 被泛词抢走。表外一律交给 embedding 兜底。
 */
export const CONSOLIDATION_ATTRIBUTES = [
  { name: "root_cause", patterns: [/根因/, /原因/, /bug\s*(?:在于|是)/i, /报错/, /异常/, /挂掉/] },
  { name: "module_ownership", patterns: [/负责/, /归属/, /维护者/, /\bowner\b/i] },
  { name: "tooling", patterns: [/工具/, /使用/, /采用/, /改用/, /技术栈/, /依赖/, /\bcli\b/i] },
  { name: "decision", patterns: [/决定/, /拍板/, /确定/, /选定/, /定了/, /结论是/, /改为/] },
  { name: "preference", patterns: [/偏好/, /喜欢/, /倾向/, /不接受/, /更愿意/] },
  { name: "plan", patterns: [/计划/, /打算/, /准备/, /下一步/, /待办/] },
  { name: "reflection", patterns: [/反思/, /复盘/, /教训/, /体会/, /总结/] },
  { name: "status", patterns: [/进度/, /状态/, /已完成/, /进行中/, /阻塞/] },
  { name: "quality", patterns: [/质量/, /风险/, /缺陷/, /\bflaky\b/i] },
] as const;

export type ConsolidationAttributeName = (typeof CONSOLIDATION_ATTRIBUTES)[number]["name"];

/** 受限词表的名字（声明顺序，供测试/日志/提示词引用）。 */
export const CONSOLIDATION_ATTRIBUTE_NAMES: readonly string[] = CONSOLIDATION_ATTRIBUTES.map((a) => a.name);

export interface AttributeKey {
  /** 归一后的实体（小写、去尾标点、空白折叠）。 */
  entity: string;
  /** 归一后的属性（事实层 canonical 名或本文件受限词表名）。 */
  attribute: string;
  /** entity + "|" + attribute：稳定、可比对、可直接做幂等键。 */
  key: string;
}

/**
 * 从一条记忆内容提取"主体/归并键"。保守规则：取首个顿号/冒号前，或前 N 字符主题词。
 * （原 grouping.ts 函数整体迁入本文件，grouping.ts 仍 re-export 以保持既有 import 面。）
 */
export function subjectOf(m: MemoryRecord, maxLen = 24): string {
  const c = m.content ?? "";
  if (!c) return "unknown";
  for (const sep of ["：", ":", " — "]) {
    const idx = c.indexOf(sep);
    if (idx > 0 && idx <= maxLen) return c.slice(0, idx).trim();
  }
  const n = Math.min(Math.max(4, maxLen), c.length);
  return c.slice(0, n);
}

/** entity 归一：去尾标点（中英）、折叠空白、小写、截断。归一后为空 → null。 */
function normalizeEntity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const trimmed = collapsed.replace(/[。．.,，;；:：!！?？、\-—_]+$/u, "").trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().slice(0, MAX_ENTITY_CHARS);
}

/** 数组型引用取首个非空字符串（coreRefs/personRefs 允许 string[] 或 string）。 */
function firstRef(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return null;
}

/** 实体：work_object → coreRefs → personRefs → 文本主语。 */
function entityOf(m: MemoryRecord): string | null {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    meta.work_object,
    meta.workObject,
    firstRef(meta.coreRefs) ?? firstRef(meta.core_refs),
    firstRef(meta.personRefs) ?? firstRef(meta.person_refs),
  ];
  for (const c of candidates) {
    const norm = normalizeEntity(c);
    if (norm) return norm;
  }
  const lexical = normalizeEntity(subjectOf(m));
  // subjectOf 空内容兜 "unknown"——那是占位不是实体，不得当键。
  if (!lexical || lexical === "unknown") return null;
  return lexical;
}

/** facts 三元组里归一 attribute（shape 宽松：{attribute} 或 {predicate/attribute}）。 */
function attributeFromFacts(meta: Record<string, unknown>): string | null {
  const facts = meta.facts;
  if (!Array.isArray(facts)) return null;
  for (const f of facts) {
    if (!f || typeof f !== "object") continue;
    const hit = normalizeFactAttribute((f as Record<string, unknown>).attribute);
    if (hit) return hit;
  }
  return null;
}

/** 属性：显式 metadata.attribute → facts 三元组 → 受限谓词表。 */
function attributeOf(m: MemoryRecord): string | null {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const declared = normalizeFactAttribute(meta.attribute);
  if (declared) return declared;
  const fromFacts = attributeFromFacts(meta);
  if (fromFacts) return fromFacts;
  const text = m.content ?? "";
  if (!text) return null;
  for (const spec of CONSOLIDATION_ATTRIBUTES) {
    for (const p of spec.patterns) {
      if (p.test(text)) return spec.name;
    }
  }
  return null;
}

/**
 * 派生 (entity, attribute) 归一键。两半都归一成功才返回；任一缺失 → null
 * （调用方进 embedding 待聚类池，不静默丢弃）。
 */
export function deriveAttributeKey(m: MemoryRecord): AttributeKey | null {
  if (!m || typeof m !== "object") return null;
  const entity = entityOf(m);
  if (!entity) return null;
  const attribute = attributeOf(m);
  if (!attribute) return null;
  return { entity, attribute, key: entity + ATTRIBUTE_KEY_SEPARATOR + attribute };
}
