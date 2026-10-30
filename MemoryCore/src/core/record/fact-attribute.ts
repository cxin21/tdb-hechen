/**
 * #167：抽取期受控 attribute（canonical 属性词表）。
 *
 * 背景（docs/optimization-results.md §22.6）：#146 的谓词同义族在真实 facts-cache 上
 * 实测 +0.0%——谓词是自由文本（is considering / plans to try / interested in …），
 * 同义表打不到；而语义层面它们其实是同一类属性。这里把「属性」提升为抽取期直出的
 * 受控字段（封闭词表），事实键优先 (normSubject, attribute)，从而跨谓词对齐、真正
 * 做到事实级失效（single）与并存（multi）。
 *
 * 纪律：
 *  - 词表封闭：表外/脏值一律 undefined（写侧回落谓词启发式，不猜语义）；
 *  - 别名只做**词形容错**（复数/同义规范名/连字符），不做语义外推；`city`/`location`
 *    这类既有"常住"又有"到访"歧义的词故意不收，避免把旅行目的地并进 single；
 *  - 每个属性自带基数，且表内不可再按数值/取值列表改写；
 *  - 名字、基数与描述单一来源于此文件（提示词、归一、测试、metrics 都引用它）。
 */
import type { FactCardinality } from "./cardinality.js";

export interface FactAttributeSpec {
  /** 属性名（规范化后的 canonical 名，snake_case）。 */
  readonly name: string;
  /** 固定基数：同实体同属性同刻能否并存多值。 */
  readonly cardinality: FactCardinality;
  /** 中文语义描述（进提示词，让 LLM 按语义挑而不是按名字猜）。 */
  readonly description: string;
}

/**
 * canonical 词表（24 个）：single 10 + multi 14。
 * single 档只收「同一实体同一时刻天然单值」的槽位；宁可少而准——把可并存的东西
 * 错标 single 会误失效，比漏标更贵。
 */
export const FACT_ATTRIBUTES = [
  // ── single：同实体同属性同刻唯一值 ──────────────────────────────
  { name: "residence", cardinality: "single", description: "常住地/所在城市" },
  { name: "occupation", cardinality: "single", description: "职业/职位/岗位" },
  { name: "employer", cardinality: "single", description: "雇主/就职公司" },
  { name: "education", cardinality: "single", description: "学校/专业/学历" },
  { name: "age", cardinality: "single", description: "年龄" },
  { name: "phone", cardinality: "single", description: "电话号码" },
  { name: "email", cardinality: "single", description: "邮箱地址" },
  { name: "address", cardinality: "single", description: "住址/邮寄地址" },
  { name: "marital_status", cardinality: "single", description: "婚恋状态" },
  { name: "name", cardinality: "single", description: "本人姓名/称呼" },
  // ── multi：同实体同属性可并存多值 ──────────────────────────────
  { name: "interest", cardinality: "multi", description: "感兴趣/正在考虑/想了解的事物" },
  { name: "plan", cardinality: "multi", description: "计划/打算/准备做的事" },
  { name: "preference", cardinality: "multi", description: "偏好/喜欢/讨厌的事物或口味" },
  { name: "goal", cardinality: "multi", description: "目标/愿望" },
  { name: "habit", cardinality: "multi", description: "习惯/日常做法" },
  { name: "possession", cardinality: "multi", description: "拥有/购买/收到的东西" },
  { name: "health", cardinality: "multi", description: "健康状况/症状/过敏" },
  { name: "skill", cardinality: "multi", description: "技能/擅长/正在学的能力" },
  { name: "activity", cardinality: "multi", description: "参加/经历/做过的活动" },
  { name: "travel", cardinality: "multi", description: "旅行/出行/到访地点与安排" },
  { name: "relationship", cardinality: "multi", description: "与他人的关系（朋友/家人/同事）" },
  { name: "opinion", cardinality: "multi", description: "看法/观点/担忧/不确定的事" },
  { name: "diet", cardinality: "multi", description: "饮食禁忌/忌口" },
  { name: "membership", cardinality: "multi", description: "会员/订阅/所属组织" },
] as const satisfies readonly FactAttributeSpec[];

export type FactAttributeName = (typeof FACT_ATTRIBUTES)[number]["name"];

export const ATTRIBUTE_NAMES: readonly FactAttributeName[] = FACT_ATTRIBUTES.map((a) => a.name);

const BY_NAME = new Map<string, FactAttributeSpec>(FACT_ATTRIBUTES.map((a) => [a.name, a]));

/**
 * 别名 → canonical。只收**同义词与词形变体**（复数、带下划线的完整写法）。
 * 刻意不收 title（书名/职位同形）、city/location（分不清常住地与旅行目的地）、
 * relationship_status（与 multi 的 relationship 语义重叠）：错并会把多值误判成 single。
 */
const ATTRIBUTE_ALIASES: Readonly<Record<string, FactAttributeName>> = {
  job: "occupation",
  company: "employer",
  workplace: "employer",
  school: "education",
  university: "education",
  degree: "education",
  email_address: "email",
  phone_number: "phone",
  marital: "marital_status",
  hobbies: "interest",
  hobby: "interest",
  interests: "interest",
  plans: "plan",
  planning: "plan",
  goals: "goal",
  preferences: "preference",
  possessions: "possession",
  skills: "skill",
  activities: "activity",
  relationships: "relationship",
  opinions: "opinion",
  diet_restrictions: "diet",
  subscriptions: "membership",
};

/**
 * 归一一个 attribute 提议：大小写/空白/连字符/下划线归一后查表，再查别名。
 * 表外一律 undefined（调用方回落谓词路径，不猜）。
 */
export function normalizeFactAttribute(raw: unknown): FactAttributeName | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!key) return undefined;
  const canonical = BY_NAME.get(key)?.name as FactAttributeName | undefined;
  if (canonical) return canonical;
  return ATTRIBUTE_ALIASES[key];
}

/** 属性基数；表外 undefined（调用方走启发式）。 */
export function attributeCardinalityOf(raw: unknown): FactCardinality | undefined {
  const name = normalizeFactAttribute(raw);
  return name ? BY_NAME.get(name)?.cardinality : undefined;
}

/** 词表描述（供提示词逐行列出，形如 "- residence：常住地/所在城市（single）"）。 */
export function describeAttributes(): string {
  return FACT_ATTRIBUTES.map((a) => `- ${a.name}：${a.description}（${a.cardinality}）`).join("\n");
}

export interface CardinalityResolution {
  readonly cardinality: FactCardinality;
  readonly reason: string;
}

/**
 * 基数裁决的**唯一**优先级（写侧 fact-row 与读侧 supersession 共用，避免两套阶梯漂移）：
 *   attribute（封闭词表，档位即语义） > 显式 cardinality（自由文本，可能错） > fallback。
 *
 * 显式值仍保留在无 attribute 时兜底；有 attribute 时以词表为准——`residence` 天然
 * single，不该被抽取器随手写的 multi 推翻。
 */
export function resolveFactCardinality(
  attribute: unknown,
  explicit: FactCardinality | undefined,
  fallback: CardinalityResolution,
): CardinalityResolution {
  const name = normalizeFactAttribute(attribute);
  const fromAttribute = name ? BY_NAME.get(name)?.cardinality : undefined;
  if (name && fromAttribute) return { cardinality: fromAttribute, reason: `attribute:${name}` };
  if (explicit) return { cardinality: explicit, reason: "explicit" };
  return fallback;
}
