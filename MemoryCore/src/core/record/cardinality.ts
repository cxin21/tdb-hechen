/**
 * #136（W2 属性契约）：事实基数（cardinality）——决定一条事实能不能被"同属性新值"取代。
 *
 * 背景（issue #136 评论）：W2 写时 supersession 按（实体，谓词）判同一属性，只要新值不同就
 * 把整条 L1 行标记失效。但抽取器的 predicate 是**泛化谓词**，很多属性并非函数依赖：
 *   - "User / is considering: a grocery delivery service" → "trying Thrive Market"（并存考虑项）
 *   - "User / wants to create: a private Facebook community" → "a content calendar"（不同目标）
 *   - "the user / has a book club member: publishing her debut novel" → "…soon"（措辞差异）
 * 对这类多值属性做 supersession = 删错历史，LME90 temporal-reasoning 桶因此拒答。
 *
 * 契约：只有 cardinality === "single" 的属性允许 supersession；"multi" 是 additive，
 * 永不失效（新值只是再加一条）。
 *
 * 判定优先级（先命中先返回，保证可解释）：
 *   1. 显式标注（抽取器/调用方给出）
 *   2. 单值词表（计数、联系方式、个人档案类——这些是真函数依赖，必须保住 knowledge-update）
 *   3. 多值动词线索（consider/want/plan/like/…——#136 实测误失效的谓词都落这里）
 *   4. 值结构线索（值本身并列：or / and / 、 / ，/ ; / also）
 *   5. 缺省：single（保覆盖 = #136 之前的逐位行为；契约只收紧"明确的多值"）
 */

export type FactCardinality = "single" | "multi";

export interface CardinalityVerdict {
  cardinality: FactCardinality;
  /** 命中理由（可观测/可测试，写进日志或 bench 明细）。 */
  reason: string;
}

/** 真·函数依赖：同一时刻只有一个值，新值取代旧值。 */
const SINGLE_CUES: readonly string[] = [
  // 计数 / 数量
  "follower", "followers", "fan", "fans", "fan count", "subscriber", "subscribers",
  "count", "counts", "number of", "total", "amount",
  "score", "rating", "price", "cost", "salary", "budget", "revenue",
  // 联系方式 / 地址
  "phone", "email", "address", "zip", "postal", "website", "username", "account",
  // 个人档案
  "age", "height", "weight", "birthday", "birth date", "birthday", "gender", "city",
  "country", "company", "employer", "job", "occupation", "title", "school", "university",
  "major", "degree", "status", "favorite", "favourite",
  // 中文
  "粉丝", "关注数", "数量", "总数", "价格", "花费", "工资", "预算", "收入",
  "电话", "手机", "邮箱", "邮件", "地址", "邮编", "网站", "账号",
  "年龄", "身高", "体重", "生日", "性别", "城市", "国家", "公司", "雇主",
  "职位", "职业", "学校", "大学", "专业", "学历", "状态", "最喜欢", "最爱",
];

/** 多值 / 模态：值之间不互斥，新值不取代旧值。 */
const MULTI_CUES: readonly string[] = [
  // 模态/意愿（含屈折变体——英文 cue 走词边界，不做词干化）
  "consider", "considers", "considering", "want", "wants", "wanting", "wanted", "want to",
  "plan", "plans", "planned", "planning", "intend", "intends", "intended", "hope", "hopes",
  "hope to", "try", "tries", "tried", "trying", "try to", "interested",
  // 偏好/情感（可并存多值）
  "like", "likes", "liked", "love", "loves", "loved", "enjoy", "enjoys", "enjoyed",
  "prefer", "prefers", "preferred", "own", "owns", "owned", "member", "members",
  "belong", "belongs", "belonged",
  // 泛化谓词（不是函数依赖：一次陈述 ≠ 唯一属性）
  "has a", "have a", "had a", "is a",
  // 泛化动词/系动词（#136 实测残留的误失效谓词：feels/is seeking/has made/uses/replaced…）
  // 词边界匹配，不会误伤 "account"/"language" 等单值词表命中。
  "has", "have", "had", "is", "are", "was", "were", "been", "be",
  "feels", "feel", "felt", "seeks", "seek", "seeking", "uses", "use", "used",
  "made", "make", "makes", "received", "receive", "found", "find", "looking",
  "reading", "watching", "listening", "experimenting", "excited", "ready", "recall",
  "played", "ends", "end", "lived", "met", "bought", "purchased", "ordered",
  "visited", "traveled", "travelled", "joined", "started", "stopped",
  "replaced", "replacing", "changed", "switched", "saw", "seen",
  "knows", "thinks", "believes", "unsure", "attended", "attend",
  // 中文
  "想", "想要", "打算", "计划", "考虑", "希望", "喜欢", "爱好", "感兴趣", "参与",
];

/** 值结构线索：值本身是并列集合（"yoga or pilates" / "健身、读书"）。 */
const VALUE_LIST_RE = /(?:^|\s)(?:or|and|also)(?:\s|$)|[、，;；]|\s\/\s/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 词边界匹配（中文 cue 仍用子串——没有词边界概念）。
 * 英文短词必须卡边界：否则 "age" 会命中 "language"、"title" 会命中 "entitled"，
 * 把默认单值的语义污染成"命中单值词表"。CJK 直接 includes。
 */
export function matchesCue(haystack: string, cue: string): boolean {
  if (/[\u4e00-\u9fff]/.test(cue)) return haystack.includes(cue);
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(cue)}([^a-z0-9]|$)`, "i").test(haystack);
}

function firstHit(haystack: string, cues: readonly string[]): string | undefined {
  for (const cue of cues) {
    if (matchesCue(haystack, cue)) return cue;
  }
  return undefined;
}

/** 共享判定阶梯（谓词级与内容级只差「是否看值结构线索」）。 */
function classifyStages(text: string, value: string | undefined, includeValueCues: boolean): CardinalityVerdict {
  const p = normalize(text ?? "");

  const singleCue = firstHit(p, SINGLE_CUES);
  if (singleCue) return { cardinality: "single", reason: `single-cue:${singleCue}` };

  const multiCue = firstHit(p, MULTI_CUES);
  if (multiCue) return { cardinality: "multi", reason: `multi-cue:${multiCue}` };

  if (includeValueCues) {
    const v = normalize(value ?? "");
    if (v && VALUE_LIST_RE.test(v)) return { cardinality: "multi", reason: "value-list" };
  }
  return { cardinality: "single", reason: "default-single" };
}

/**
 * 判定一条事实的基数。空谓词按缺省（single）——调用方本就不该对空谓词做 supersession。
 * 优先级：显式 → 单值词表 → 多值词表 → 值结构线索 → 缺省 single。
 */
export function classifyCardinality(
  predicate: string,
  value?: string,
  explicit?: FactCardinality,
): CardinalityVerdict {
  if (explicit === "single" || explicit === "multi") {
    return { cardinality: explicit, reason: "explicit" };
  }
  return classifyStages(predicate, value, true);
}

/** 只有单值属性允许被同属性新值取代（soft supersession）。 */
export function isSupersessionEligible(cardinality: FactCardinality): boolean {
  return cardinality === "single";
}

/**
 * 内容级判定（生产写侧没有 predicate 结构化字段，只有整句 content）。
 * 复用谓词判定的优先级：单值词表 → 多值动词线索 → 缺省单值。
 * 注意：值结构线索（or/、/，）**不**用于整句——中文句子里的逗号不是并列事实。
 */
export function classifyContentCardinality(content: string): CardinalityVerdict {
  const verdict = classifyStages(content, undefined, false);
  // reason 前缀区分「内容级」与谓词级，便于日志/复算归因
  return { ...verdict, reason: verdict.reason === "default-single" ? verdict.reason : `content-${verdict.reason}` };
}
