/**
 * 确定性判据（零 LLM）。这是「0 人工」的地基：人能审的只有判据，
 * 判据必须是可复现的纯函数，才有资格替代人。
 *
 * 六类闸门：
 *  - 事件句 / 阶段词：会随任务过期的内容不是人格
 *  - 换项目测试：把项目名/路径/单号换成 X 后是否仍成立
 *  - 两难测试：价值只在冲突时显形，「有用的事」不构成价值
 *  - 证据独立性：证据过半来自 soul 自身产出 = 自我循环，拒
 *  - 用户原话支撑：关于「他」的判断必须有逐字原话
 *  - 变更率/预算/红线形态：结构性约束
 */
import type { EvidenceOrigin, PersonaItem, SoulLayer, SoulMaintenanceConfig } from "./types.js";

export type GateCode =
  | "ok"
  | "event_sentence"
  | "stage_word"
  | "project_bound"
  | "methodology"
  | "dilemma_missing"
  | "task_specific"
  | "self_evidence"
  | "verbatim_missing"
  | "churn_exceeded"
  | "budget_exceeded"
  | "redline_shape"
  | "too_long"
  | "duplicate"
  | "empty"
  /* —— 正向判据（2026-11-05 引入：只靠「像不像人格」筛，长出的全是方法论）——
   * 真人格必须携带来源与代价：说得出「我为哪次具体的事、放弃了什么」。
   * 这些门只作用于非 legacy 的新候选（存量导入不追溯）。 */
  | "stance_missing"
  | "cost_missing"
  | "episode_missing"
  | "voice_quote_missing"
  /** voice 是「我」的语体，不是第三人称给用户做的画像（2026-11-05 生产实拍：整层写成「他开口像下工单」）。 */
  | "voice_self_missing"
  | "narrative_method"
  | "self_missing"
  | "self_not_owned"
  | "agent_stance_missing"
  | "intrinsic_missing"
  | "relationship_person_missing"
  | "relationship_history_missing"
  | "insufficient_evidence";

/* —— 人格形态门（task_specific）——
 * 判据来自 2026-11-05 生产回放（582 条 core_pending，405 rejected）：判成「人格」的
 * 70 条漏网几乎全是「用具体任务证据讲我怎么做事」的叙事——带 issue 号、commit、
 * 行号、文件名、工具名、比例数字，或长到一句话讲不完。
 * 真正的取舍句是短、且不含任务锚的：它换一个项目、换一套工具依然成立。
 * 因此身份/价值/关系/红线四层在**非存量导入**路径上必须先过形态门；
 * 用户手工写进 strict_rule 的存量按 legacy 放宽（用户原话即最高级证据）。 */
const ARTIFACT_PATTERNS: RegExp[] = [
  /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|ya?ml|toml|md|java|py|sql|sh|ps1|vue)\b/iu,
  /(?:[A-Za-z]:[\\/]|\/(?:[\w.-]+\/)+)/u,
  /#\d+/u,
  /\b[0-9a-f]{7,40}\b/iu,
  /\bv?\d+\.\d+(?:\.\d+)?\b/u,
  /\b\d+\s*\/\s*\d+\b/u,
  /\d+(?:\.\d+)?\s*%/u,
  /\b(?:grep|vitest|typecheck|tsc|node|gh|git|zip|unzip|ocr|a11y|compress|decompress|sqlite|journal|snapshot|probe|bash|pwsh|stdout|stderr)\b/iu,
  /(?:本次|此例|该任务|本轮|首轮|这一轮|该票|本票|该目录|当次)/u,
  /\b(?:this|that|current|last)\s+(?:task|ticket|round|sprint|session|pr|issue)\b/iu,
];

/** 各人格层的「一句话讲得完」上限（字符）。超出=在讲一段经历，不是一条取舍。 */
export const PERSONA_SHAPE_MAX_CHARS: Record<SoulLayer, number> = {
  voice: 120,
  identity: 90,
  self: 120,
  values: 110,
  boundary: 120,
  relationship: 110,
  narrative: 160,
  method: Number.POSITIVE_INFINITY,
};

/**
 * 人格单位长度：CJK 一字=1，非 CJK 字符=0.4（约 2.5 字符折 1 字）。
 * 判据原本只按字符串长度，英文人格句会被中文字数上限误杀；折算后中文行为不变，
 * 英文按「同样信息量」给上限，而不是按 UTF-16 码元个数。
 */
export function personaLength(text: string): number {
  let units = 0;
  // 中文标点也按 1 字计：只折 ASCII 才能让「122 字符、其中 10 个标点」不被算成 116 字，
  // 否则红线的 120 字硬帽会被标点悄悄放宽（2026-11-06 回归）。
  for (const ch of text) units += /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u.test(ch) ? 1 : 0.4;
  return Math.round(units * 10) / 10;
}

/** 形态门：短 + 不含任务锚。返回首个命中的证据，便于审计为什么被判叙事。 */
export function personaShape(
  s: string,
  layer: SoulLayer,
  config?: SoulMaintenanceConfig,
): { pass: boolean; matched?: string; detail: string } {
  // 配置可收紧/放宽单层上限（boundary 走 redlineMaxChars；其余层受 maxItemChars 二次约束）。
  const base = PERSONA_SHAPE_MAX_CHARS[layer] ?? 120;
  const cfgMax =
    layer === "boundary"
      ? config?.redlineMaxChars
      : config?.maxItemChars?.[layer] !== undefined
        ? config.maxItemChars[layer]
        : undefined;
  const max = Math.min(base, cfgMax ?? base);
  const len = personaLength(s);
  if (len > max) {
    return { pass: false, detail: `${s.length} 字符（折算 ${len} 字）> 形态上限 ${max}（叙事，不是一句话取舍）` };
  }
  for (const re of ARTIFACT_PATTERNS) {
    const m = re.exec(s);
    if (m) return { pass: false, matched: m[0], detail: `含任务锚「${m[0]}」，换项目/换工具即不成立` };
  }
  return { pass: true, detail: "形态合规（短且无任务锚）" };
}

export interface GateReport {
  pass: boolean;
  code: GateCode;
  detail: string;
  matched?: string;
}

export interface GateContext {
  layer: SoulLayer;
  now: string;
  existing: PersonaItem[];
  config: SoulMaintenanceConfig;
  /** 候选文本占用的层预算（已渲染字符数）。 */
  layerUsedChars?: number;
  /** 用户原话语料（逐字支撑判定用；为空则涉及「他」的判断一律拒）。 */
  userCorpus?: string[];
  /** 本条候选的证据来源分布。 */
  evidenceOrigins?: EvidenceOrigin[];
  /** 本条候选引用的事件层 id（ep-*）。identity/values/narrative 必须真的挂在事件上。 */
  evidenceEpisodeIds?: string[];
  /** voice 层引用到的真实用户原话（逐字，带 recordId）。 */
  voiceFewShots?: { quote: string; recordId: string }[];
  /** 存量导入/人工钉住的白名单放宽（只放宽形态与两难，不放宽事件句）。 */
  legacy?: boolean;
  /** 关系层要指名的人（缺省由调用方传 cfg.personName）；不传则不施加指名门。 */
  personName?: string;
}

// ---------------------------------------------------------------- 文本工具

const BULLET_RE = /^(?:[-*+·•](?:\s+|$)|\d+[.、)]\s*|\d+、)/u;

export function stripBullet(text: string): string {
  return text.replace(BULLET_RE, "").trim();
}

export function normalizeText(text: string): string {
  return stripBullet(String(text ?? ""))
    .replace(/\s+/gu, "")
    .replace(/[“”"']/gu, "")
    .replace(/[，。；：、！？,.;:!?]/gu, "");
}

/** FNV-1a 32bit ×2，稳定、无依赖、跨运行时一致（不用于安全场景）。 */
export function textHash(text: string): string {
  const s = normalizeText(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

export function charBigrams(text: string): Set<string> {
  const s = normalizeText(text);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function textSimilarity(a: string, b: string): number {
  return jaccard(charBigrams(a), charBigrams(b));
}

/**
 * 单次改写的文本差异比例（设计里的 α 语义）= 归一化编辑距离（改了几个字 / 较长串长度）。
 *
 * 不用 1 - textSimilarity（bigram Jaccard）：短句里改一个字会销毁并新建 2 个 bigram，
 * 15 字的句子改 1 字就被判成 0.23 > α=0.15——α 形同虚设，更新永远跑不动。
 * 编辑距离对「改了两个字」是 2/15≈0.13，符合 α 想表达的「小步走」。
 */
export function diffRatio(before: string, after: string): number {
  const a = normalizeText(before);
  const b = normalizeText(after);
  if (a === b) return 0;
  const len = Math.max(a.length, b.length);
  if (len === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length] / len;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------- 判据正则

/** 「我做了什么」：完成/提交/修复/发现 + 具体产物锚点。 */
const EVENT_PATTERNS: RegExp[] = [
  /(?:完成|提交|推送|合并|关闭|修复|落地|收尾|上线|部署|跑完|改完)(?:了|并|掉)?[^。；]{0,16}(?:commit|pr|pull request|issue|票|分支|测试|门禁|版本|v\d|#\d)/iu,
  /\b(?:commit|pr|issue|merge request)\s*[#:：]?\s*[0-9a-f]{6,}/iu,
  /\b[0-9a-f]{7,40}\b/u,
  /\b#\d{2,}\b/u,
  /我在[^。；]{0,24}(?:中|时|之后|以后|期间)/u,
  /(?:今天|昨天|今晚|刚才|刚刚|本轮|这次|本次)[^。；]{0,24}(?:做|改|跑|查|写|发现|确认|排除|定位|修)/u,
  /\b\d{4}-\d{2}-\d{2}\b/u,
  /(?:tests?|vitest|typecheck|测试)[^。；]{0,12}(?:全绿|passed|failed|通过|失败)/iu,
  /(?:还剩|剩余|待办|下一步|接下来|尚未|进度)[^。；]{0,20}/u,
  /(?:我|本次)[^。；]{0,10}(?:判定|裁定|裁决)[^。；]{0,10}(?:为|是)[^。；]{0,20}/u,
  /\b(?:finished|submitted|pushed|merged|closed|fixed|landed|deployed|shipped|completed)\b[^.;]{0,28}\b(?:commit|pr|issue|branch|tests?|version|v\d)/iu,
  /\b(?:commit|pr|issue|merge request)\s*[#:]?\s*[0-9a-f]{6,}/iu,
  /\b(?:today|yesterday|just now|this round|last round)\b[^.;]{0,32}\b(?:did|changed|ran|checked|found|fixed|confirmed)\b/iu,
  /\b(?:tests?|vitest|typecheck)\b[^.;]{0,16}\b(?:passed|failed)\b/iu,
  /\b(?:next step|remaining|todo|still need|left to do)\b/iu,
  /\bI\s+(?:judged|ruled|decided)\b[^.;]{0,20}\b(?:as|that|to)\b/iu,
];

/** 阶段词：本周项目状态，不构成身份。 */
const STAGE_PATTERNS: RegExp[] = [
  /(?:当前|目前|现阶段|本阶段|这一阶段|眼下)(?:的)?(?:任务|项目|重点|工作|阶段|目标)/u,
  /(?:正在|刚刚|暂时)(?:做|改|处理|推进|验证|排查)/u,
  /(?:本周|本月|这周|这个月|今天|昨天)(?:的)?(?:计划|安排|进度|待办)/u,
  /\b(?:currently|right now|at the moment)\b[^.;]{0,20}\b(?:working|doing|fixing|investigating)\b/iu,
  /\b(?:this|next)\s+(?:week|month|sprint)\b[^.;]{0,16}\b(?:plan|schedule|progress|roadmap)\b/iu,
];

/** 项目/工具专名：换项目即不成立。 */
const PROJECT_TOKENS =
  /(?:TDB|td-agemem|MemoryCore|MemoryPanel|MemoryProxy|dsh-plugin|deck-autopilot|云文库|NC客开|NCC|用友|YonYou|src\/|\/v3\/|\.ts\b|\.md\b|\b80\d{2}\b)/iu;

/** 方法论标记：怎么做事，而不是站哪边。 */
const METHOD_PATTERNS: RegExp[] = [
  /(?:流程|步骤|顺序|方法论|sop|清单|模板|套路|固定顺序|先[^。；]{0,10}再)/iu,
  /(?:我|我的)[^。；]{0,12}(?:做法|工作流|排障顺序|验证顺序|操作顺序)/u,
  /(?:一律|每次|逐条|逐项|分批|切片|按批)[^。；]{0,16}(?:执行|推进|确认|处理|验证)/u,
  /\b(?:process|steps?|checklist|workflow|sop|playbook|first\b[^.;]{0,20}\bthen)\b/iu,
  /\b(?:my|the)\s+(?:approach|method|routine|way of working)\b/iu,
  /\b(?:always|every time|one by one|batch)\b[^.;]{0,20}\b(?:run|check|confirm|verify|process)\b/iu,
];

/** 两难/取舍标记：价值与红线在这里显形。 */
const DILEMMA_PATTERNS: RegExp[] = [
  /(?:宁可|宁愿|与其|而不是|也不|也要|即使|哪怕|取舍|权衡|冲突时|打架|矛盾时)/u,
  /(?:优先|站在这边|不换|拒绝|放弃|接受不了|不能接受)/u,
  /\b(?:rather than|instead of|even if|even when|trade-?off|prioriti[sz]e|give up|refuse|won't trade|would rather)\b/iu,
  /\b(?:would|'d)\s+rather\b[^.;]{0,40}\bthan\b/iu,
];

/** 第一人称特质句。 */
const TRAIT_PATTERNS: RegExp[] = [
  /^我(?:在意的|看重的|信的|相信|倾向|习惯|受不了|不接受|坚持|宁可|不会|从不|始终|更愿意|更喜欢)/u,
  /^我(?:是|就是)(?:一个|那种|个)/u,
  /^I(?:'m| am)\s+(?:the kind|someone|a person)\b/iu,
  /^I\s+(?:care about|value|believe|tend to|can't stand|cannot stand|don't accept|do not accept|always|never|prefer|would rather)\b/iu,
];

/** 红线/禁令标记。 */
const BOUNDARY_PATTERNS: RegExp[] = [
  /(?:绝不|不得|严禁|禁止|不允许|不可以|红线|必须先|一律不|永不)/u,
  /\b(?:never|must not|must never|forbidden|not allowed|red line|under no circumstances)\b/iu,
];

export function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

export function isEventSentence(text: string): { hit: boolean; matched?: string } {
  const matched = firstMatch(text, EVENT_PATTERNS);
  return matched ? { hit: true, matched } : { hit: false };
}

export function isStageBound(text: string): { hit: boolean; matched?: string } {
  const matched = firstMatch(text, STAGE_PATTERNS);
  return matched ? { hit: true, matched } : { hit: false };
}

export function isProjectBound(text: string): boolean {
  return PROJECT_TOKENS.test(text);
}

export function looksMethodology(text: string): boolean {
  return firstMatch(text, METHOD_PATTERNS) !== undefined;
}

export function hasDilemma(text: string): boolean {
  return firstMatch(text, DILEMMA_PATTERNS) !== undefined;
}

export function isTraitSentence(text: string): boolean {
  return firstMatch(text, TRAIT_PATTERNS) !== undefined;
}

export function looksBoundary(text: string): boolean {
  return firstMatch(text, BOUNDARY_PATTERNS) !== undefined;
}

/* —— 正向判据的确定性词面（与 episode.ts 的标记组同源，但判据只看「这一句话里有没有」）—— */

/** 第一人称立场：人格句必须能听出「我」站在哪边，而不是描述「一个严谨的人」。 */
const STANCE_PATTERNS: RegExp[] = [
  /^我(?:认为|觉得|宁可|宁愿|更|只|会|不会|不要|不|要|选|站|倾向|看重|讨厌|喜欢|接受|拒绝)/u,
  /(?:对我来说|我的底线|我看重|我宁可|我宁愿|我不接受|我不做|我选择|我宁愿不|我宁可少)/u,
  /(?:我更在意|我更看重|我宁愿要|我必须先|我绝不)/u,
  /^I\s+(?:think|believe|would rather|prefer|choose|stand for|value|care about|won't|will not|refuse|accept|don't|do not)\b/iu,
  /\b(?:to me|my bottom line|what I value|I'd rather|I would rather|I will never|I won't)\b/iu,
];

/** 代价词：价值必须点名「为此放弃了什么」；不含代价的价值=便宜的口号。 */
const COST_TEXT_PATTERNS: RegExp[] = [
  /(?:放弃|牺牲|代价|错过|不换|宁愿不|宁可少|宁可慢|少赚|慢一点|多花|让位|接受损失)/u,
  /\b(?:give up|sacrifice|costs?|miss|trade|slower|less money|pay the price|let go)\b/iu,
];

/** 来路词：narrative 必须讲「从哪来」，否则就是伪装成叙事的自我描述。 */
const ORIGIN_TEXT_PATTERNS: RegExp[] = [
  /(?:来路|后来|当初|曾经|以前|当时|这些年|过去|早先|从前|一路|之前)/u,
  /\b(?:used to|back then|at first|over the years|in the past|earlier|before that|along the way)\b/iu,
];

export function hasStance(text: string, legacy = false): boolean {
  if (legacy) return true;
  if (hasDilemma(text)) return true;
  return firstMatch(text, STANCE_PATTERNS) !== undefined;
}

export function hasCostWording(text: string): boolean {
  return firstMatch(text, COST_TEXT_PATTERNS) !== undefined;
}

/** 自我承诺：自我模型必须是我对自己的约束/愿望，不是「我是个怎样的人」的描述。 */
const SELF_COMMITMENT_PATTERNS: RegExp[] = [
  /^我(?:承诺|答应|发誓|不愿|不想|害怕|怕|在意|绝不成为|不要成为|要守|选择成为|宁可)/u,
  /(?:我答应过自己|我对我自己|我欠自己|我不愿变成|我不想变成|我怕自己变成)/u,
  /^I\s+(?:promised|promise|swore|don't want|do not want|fear|care about|will never become|choose to become|would rather)\b/iu,
  /\bI\s+(?:promised myself|owe it to myself|don't want to become|do not want to become|fear becoming)\b/iu,
];

/** 非效率价值：必须能指向一个「没有产出也仍然要守」的东西，否则只是效率的修辞。 */
const INTRINSIC_VALUE_PATTERNS: RegExp[] = [
  // 「诚实/证据」类必须覆盖它的日常说法，否则模型写「我宁可交回没核实的东西，也不说没问题」会被误杀。
  /(?:体面|尊严|诚实|不骗|好奇|审美|忠诚|不伤害|心安|羞耻|骄傲|干净|交代|对得起|像个人|一手证据|验证|核实|核对|复核|跑过|跑一遍|亲眼看|没看见|未采集|假绿|跑绿|不假设|不假定|不糊弄|不装|降级|删减|半成品|亲读|亲看|原文|二手|转述|把账算清)/u,
  /\b(?:dignity|honesty|honest|curiosity|integrity|respect|shame|pride|clean|fairness|first-hand|evidence|verify|verified|check|recheck|raw truth|no fake green|not assume|don't assume|do not assume)\b/iu,
];

export function hasSelfCommitment(text: string): boolean {
  return firstMatch(text, SELF_COMMITMENT_PATTERNS) !== undefined;
}

export function hasIntrinsicValue(text: string): boolean {
  return firstMatch(text, INTRINSIC_VALUE_PATTERNS) !== undefined;
}

export function hasOriginWording(text: string): boolean {
  return firstMatch(text, ORIGIN_TEXT_PATTERNS) !== undefined;
}

/** 事件 id 必须是 ep-* 且去重后计数；模型输出的「ep-xxx」若不存在于本轮事件池，由调用方先过滤。 */
export function countEpisodeEvidence(ids: string[] | undefined): number {
  if (!ids || ids.length === 0) return 0;
  return new Set(ids.filter((id) => typeof id === "string" && /^ep-[0-9a-z]+$/u.test(id))).size;
}

/** voice 必须说「我」：第一人称、且不是「他/她/用户/对方」开头的第三人称画像。 */
export function isSelfVoice(text: string): boolean {
  const s = stripBullet(text);
  if (s === "") return false;
  // 中文第一人称「我」；英文 /\bI\b/ 及其缩写。只认第一人称，不认「他/用户」画像。
  const firstPerson = /我/u.test(s) || /\bI(?:'m|'ve|'d|'ll|\b)/u.test(s);
  if (!firstPerson) return false;
  if (/^(?:他|她|用户|对方|这个人|该用户)/u.test(s)) return false;
  if (/^(?:he|she|they|the user|this user|user)\b/iu.test(s)) return false;
  return true;
}

/** few-shot 必须逐字出现在合法语料里（recordId 也得真实存在才可信）。 */
export function verifyVoiceFewShots(
  fewShots: { quote: string; recordId: string }[] | undefined,
  corpus: string[] | undefined,
  minChars: number,
): { pass: boolean; detail: string } {
  if (!fewShots || fewShots.length < 2) {
    return { pass: false, detail: "voice 必须携带至少 2 条逐字 few-shot（一条不足以证明语体）" };
  }
  const usable = (fewShots ?? []).filter(
    (f) => typeof f?.quote === "string" && typeof f?.recordId === "string" && f.recordId.trim() !== "",
  );
  if (usable.length < 2) return { pass: false, detail: "few-shot 缺 recordId（无法回溯到真实消息）" };
  // 全部命中，不是「中一条就算」：一条真、一条编的 few-shot 会把审计链做成半真半假。
  const hit = usable.filter((f) => hasVerbatimSupport(f.quote, corpus, Math.min(minChars, 6)));
  if (hit.length !== usable.length) {
    return { pass: false, detail: `${hit.length}/${usable.length} 条 few-shot 逐字可回溯（必须全部）` };
  }
  return { pass: true, detail: `${hit.length}/${usable.length} 条 few-shot 逐字可回溯` };
}

/**
 * 换项目测试：把专名替换为「X」后仍能否成立。确定性近似 = 不含专名，
 * 或含专名但同时含稳定的第一人称取舍句（此时专名是举例而非依赖）。
 */
export function survivesProjectSwap(text: string): boolean {
  if (!isProjectBound(text)) return true;
  const s = stripBullet(text);
  return hasDilemma(text) && (/^我/u.test(s) || /^I\b/iu.test(s));
}

/** 证据独立性：soul/model 自身产出占比上限。 */
export function evidenceIndependence(
  origins: EvidenceOrigin[] | undefined,
  cfg: SoulMaintenanceConfig,
): GateReport {
  if (!origins || origins.length === 0) {
    return { pass: false, code: "self_evidence", detail: "无证据来源标注，按自身产出处理（宁缺毋滥）" };
  }
  const selfCount = origins.filter((o) => o === "soul" || o === "model").length;
  const share = selfCount / origins.length;
  if (share > cfg.maxSoulEvidenceShare) {
    return {
      pass: false,
      code: "self_evidence",
      detail: `自身产出证据占比 ${share.toFixed(2)} > ${cfg.maxSoulEvidenceShare}`,
    };
  }
  return { pass: true, code: "ok", detail: `自身产出占比 ${share.toFixed(2)}` };
}

/** 用户原话逐字支撑：候选里出现与用户语料重合的连续 ≥N 字片段。 */
export function hasVerbatimSupport(text: string, corpus: string[] | undefined, minChars: number): boolean {
  if (!corpus || corpus.length === 0) return false;
  const t = normalizeText(text);
  if (t.length < minChars) return false;
  for (const raw of corpus) {
    const c = normalizeText(raw);
    if (c.length < minChars) continue;
    for (let i = 0; i + minChars <= t.length; i += 1) {
      if (c.includes(t.slice(i, i + minChars))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 分类与评估

export interface Classification {
  layer: SoulLayer | null;
  reports: GateReport[];
}

/**
 * 把一行文本分类到人格层或方法层。返回 layer=null 表示「不该进人格，也不值得留」。
 * 顺序刻意如此：事件 > 阶段 > 项目 > 方法论 > 红线 > 价值 > 特质。
 */
export function classifyLine(text: string, legacy = false, config?: SoulMaintenanceConfig): Classification {
  const s = stripBullet(text);
  const reports: GateReport[] = [];
  if (s.length === 0) return { layer: null, reports: [{ pass: false, code: "empty", detail: "空行" }] };

  const ev = isEventSentence(s);
  if (ev.hit) {
    reports.push({ pass: false, code: "event_sentence", detail: "事件/进度报告，会随任务过期", matched: ev.matched });
    return { layer: "method", reports };
  }
  const st = isStageBound(s);
  if (st.hit) {
    reports.push({ pass: false, code: "stage_word", detail: "阶段状态，不是身份", matched: st.matched });
    return { layer: "method", reports };
  }
  if (!legacy && !survivesProjectSwap(s)) {
    reports.push({ pass: false, code: "project_bound", detail: "换项目即不成立（项目专名/路径/单号）" });
    return { layer: "method", reports };
  }
  // 形态门先于「像不像」：一段带任务锚的长叙事即使含「宁可…也不…」，也只是在报告经历。
  // 逐层取各自档位（boundary 120 / identity·values 90）：先按 values 档判会把 100 字红线误杀。
  // 存量导入（legacy=true）放行——用户写进槽里的原话就是最高级证据。
  const shapeFor = (layer: SoulLayer): GateReport | null => {
    if (legacy) return null;
    const shape = personaShape(s, layer, config);
    if (shape.pass) return null;
    return {
      pass: false,
      code: "task_specific",
      detail: shape.detail,
      ...(shape.matched ? { matched: shape.matched } : {}),
    };
  };
  if (looksBoundary(s)) {
    const bad = shapeFor("boundary");
    if (bad) return { layer: "method", reports: [...reports, bad] };
    reports.push({ pass: true, code: "ok", detail: "红线/禁令形态" });
    return { layer: "boundary", reports };
  }
  if (looksMethodology(s) && !hasDilemma(s)) {
    reports.push({ pass: false, code: "methodology", detail: "方法论（怎么做），不含取舍" });
    return { layer: "method", reports };
  }
  if (hasDilemma(s)) {
    const bad = shapeFor("values");
    if (bad) return { layer: "method", reports: [...reports, bad] };
    reports.push({ pass: true, code: "ok", detail: "含取舍/两难结构" });
    return { layer: "values", reports };
  }
  if (isTraitSentence(s)) {
    const bad = shapeFor("identity");
    if (bad) return { layer: "method", reports: [...reports, bad] };
    reports.push({ pass: true, code: "ok", detail: "第一人称特质句" });
    return { layer: "identity", reports };
  }
  reports.push({ pass: false, code: "dilemma_missing", detail: "既非红线、又无取舍结构、也非特质句" });
  return { layer: null, reports };
}

export interface EvaluateOptions extends GateContext {
  /** true=检查是否与既有条目重复（同层）。 */
  checkDuplicate?: boolean;
}

/** 全量闸门评估；返回每条闸结果，pass=全部通过。 */
export function evaluateCandidate(text: string, opts: EvaluateOptions): GateReport[] {
  const s = stripBullet(text);
  const cfg = opts.config;
  const out: GateReport[] = [];
  if (s.length === 0) return [{ pass: false, code: "empty", detail: "空文本" }];

  const maxChars = cfg.maxItemChars[opts.layer] ?? 160;
  // 存量导入（用户/面板亲手写进槽里的原话）不因超字数被静默丢弃：2026-11-05 生产实测
  // 29 条 strict_rule 里有 4 条（124~144 字）被 boundary 120 字上限判 too_long 直接消失，
  // 而红线段此刻已被人格 boundary 接管——等于用户亲手写的四条红线从注入面被抹掉。
  // 丢弃用户原话比注入一行略长的禁令危险得多；长度治理交给渲染层（budget/maxItems 硬上限）。
  const lenUnits = personaLength(s);
  if (!opts.legacy && lenUnits > maxChars) {
    out.push({ pass: false, code: "too_long", detail: `${s.length} 字符（折算 ${lenUnits} 字）> 单条上限 ${maxChars}` });
  }

  // 事件句/阶段词/专名三针对「会被注入的层」永远是硬门：legacy 只放宽形态（红线字数、两难），
  // 绝不放宽「会过期」——否则存量导入就是把污染原样搬进人格层。
  // method 池按定义就是收这些被拒内容的审计池（不注入），对它不设这三针。
  const injecting = opts.layer !== "method";
  if (injecting) {
    if (!opts.legacy) {
      const shape = personaShape(s, opts.layer, opts.config);
      out.push(
        shape.pass
          ? { pass: true, code: "ok", detail: shape.detail }
          : {
              pass: false,
              code: "task_specific",
              detail: shape.detail,
              ...(shape.matched ? { matched: shape.matched } : {}),
            },
      );
    }
    const ev = isEventSentence(s);
    out.push(
      ev.hit
        ? { pass: false, code: "event_sentence", detail: "事件/进度报告，会随任务过期", matched: ev.matched }
        : { pass: true, code: "ok", detail: "非事件句" },
    );
    const st = isStageBound(s);
    out.push(
      st.hit
        ? { pass: false, code: "stage_word", detail: "阶段词，不是身份", matched: st.matched }
        : { pass: true, code: "ok", detail: "无阶段词" },
    );
    if (!opts.legacy) {
      out.push(
        survivesProjectSwap(s)
          ? { pass: true, code: "ok", detail: "换项目仍成立" }
          : { pass: false, code: "project_bound", detail: "换项目即不成立" },
      );
    }
  }

  if (opts.layer === "values" || opts.layer === "identity") {
    out.push(
      hasDilemma(s) || opts.legacy
        ? { pass: true, code: "ok", detail: "两难测试通过/存量豁免" }
        : { pass: false, code: "dilemma_missing", detail: "价值必须在冲突中显形，未检出取舍结构" },
    );
  }

  if (opts.layer === "boundary") {
    const max = opts.legacy ? 200 : cfg.redlineMaxChars;
    const redlineLen = personaLength(s);
    out.push(
      redlineLen <= max
        ? { pass: true, code: "ok", detail: "红线长度合规" }
        : { pass: false, code: "redline_shape", detail: `红线 ${s.length} 字符（折算 ${redlineLen} 字）> ${max}` },
    );
  }

  if (opts.layer === "relationship") {
    out.push(
      opts.legacy || hasVerbatimSupport(s, opts.userCorpus, cfg.verbatimMinChars)
        ? { pass: true, code: "ok", detail: opts.legacy ? "存量导入：槽内原文即来源" : "有用户原话逐字支撑" }
        : { pass: false, code: "verbatim_missing", detail: "关于「他」的判断缺逐字原话支撑" },
    );
  }

  /* —— 正向判据（只对新候选；存量导入不追溯）——
   * 为什么必须正向：2026-11-05 生产 52 条 persona 全是「我不会瞎编」这类禁令/方法论，
   * 因为旧判据只问「像不像人格」，不问「你凭什么知道」。
   * 真人格有出处：stance（我站哪边）+ cost（我放弃了什么）+ episode（哪两次具体的事）。 */
  if (!opts.legacy && (opts.layer === "identity" || opts.layer === "values" || opts.layer === "self")) {
    out.push(
      hasStance(s) || (opts.layer === "self" && hasSelfCommitment(s))
        ? { pass: true, code: "ok", detail: "有第一人称立场或取舍" }
        : { pass: false, code: "stance_missing", detail: "只有描述，没有「我站哪边」（身份/价值必须点名立场）" },
    );
  }

  if (!opts.legacy && opts.layer === "self") {
    out.push(
      hasSelfCommitment(s)
        ? { pass: true, code: "ok", detail: "是对自己的承诺/边界，不是对人的描述" }
        : { pass: false, code: "self_missing", detail: "自我模型必须写成「我答应自己/我不愿变成/我怕自己…」" },
    );
  }

  if (!opts.legacy && opts.layer === "values") {
    out.push(
      hasIntrinsicValue(s)
        ? { pass: true, code: "ok", detail: "指向非效率的内在价值" }
        : { pass: false, code: "intrinsic_missing", detail: "价值必须指向体面/尊严/诚实/好奇等「没有产出也要守」的东西" },
    );
  }

  if (!opts.legacy && opts.layer === "relationship" && opts.personName) {
    out.push(
      s.includes(opts.personName) || /(?:他|她|你)/u.test(s)
        ? { pass: true, code: "ok", detail: "关系判断点名了具体的人" }
        : { pass: false, code: "relationship_person_missing", detail: `关系判断必须点名「${opts.personName}」或「他/你」，不能是泛泛的协作合同` },
    );
  }

  if (!opts.legacy && opts.layer === "values") {
    out.push(
      hasCostWording(s)
        ? { pass: true, code: "ok", detail: "点明了放弃/代价" }
        : { pass: false, code: "cost_missing", detail: "价值必须说出为此放弃了什么，否则只是口号" },
    );
  }

  if (!opts.legacy && (opts.layer === "identity" || opts.layer === "values" || opts.layer === "self" || opts.layer === "narrative")) {
    const need = opts.layer === "narrative" ? 1 : Math.max(1, cfg.minEpisodeEvidence ?? 2);
    const have = countEpisodeEvidence(opts.evidenceEpisodeIds);
    out.push(
      have >= need
        ? { pass: true, code: "ok", detail: `挂在 ${have} 个真实 episode 上` }
        : { pass: false, code: "episode_missing", detail: `只挂 ${have} 个 episode（该层需 ≥${need}）：没有出处的判断是臆造` },
    );
  }

  if (!opts.legacy && opts.layer === "voice") {
    out.push(
      isSelfVoice(s)
        ? { pass: true, code: "ok", detail: "voice 是第一人称自述" }
        : { pass: false, code: "voice_self_missing", detail: "voice 必须写「我」怎么说话，不能是第三人称描述用户" },
    );
    const v = verifyVoiceFewShots(opts.voiceFewShots, opts.userCorpus, cfg.verbatimMinChars);
    out.push(
      v.pass
        ? { pass: true, code: "ok", detail: v.detail }
        : { pass: false, code: "voice_quote_missing", detail: v.detail },
    );
  }

  if (!opts.legacy && opts.layer === "narrative") {
    if (!hasOriginWording(s)) {
      out.push({ pass: false, code: "narrative_method", detail: "narrative 没有来路（后来/当初/以前），不是来历" });
    } else if (looksMethodology(s) && !hasCostWording(s)) {
      out.push({ pass: false, code: "narrative_method", detail: "narrative 在讲方法论，没有讲代价" });
    } else {
      out.push({ pass: true, code: "ok", detail: "有来路与代价" });
    }
  }

  if (!opts.legacy) {
    out.push(evidenceIndependence(opts.evidenceOrigins, cfg));
  }

  // 预算不是准入条件（2026-11-05 生产导入实证）：存量 29 条红线 2372 字，若按 900 字预算
  // 准入，只有前 11 条能进池、其余 18 条在导入时就被判死——用户原话直接丢失，且账本里看不出来。
  // 预算属于渲染面：渲染超帽逐条记 omitted（可见、可解释、可调），池子只受 maxItems 约束。
  out.push({ pass: true, code: "ok", detail: `预算由渲染层治理（本层上限 ${cfg.budget[opts.layer] ?? 0} 字）` });

  const churn = churnGate(opts.layer, opts.existing, opts.now, cfg);
  out.push(churn);

  if (opts.checkDuplicate) {
    const dup = opts.existing.find(
      (i) => i.layer === opts.layer && i.state !== "frozen" && textSimilarity(i.text, s) >= 0.92,
    );
    out.push(
      dup
        ? { pass: false, code: "duplicate", detail: `与既有条目近重复 ${dup.itemId}` }
        : { pass: true, code: "ok", detail: "无近重复" },
    );
  }

  return out;
}

/** 变更率闸：窗口内同层 update 次数已达上限则拒。 */
export function churnGate(
  layer: SoulLayer,
  existing: PersonaItem[],
  now: string,
  cfg: SoulMaintenanceConfig,
): GateReport {
  const nowMs = Date.parse(now);
  const windowMs = cfg.windowDays * 24 * 3600 * 1000;
  const rewrites = existing.filter((i) => {
    if (i.layer !== layer) return false;
    // 冻结/已并条目不再变化：它们是被退役的存量槽或历史副本，不能继续占用
    // 「新人格的改写额度」。否则一次槽迁移（10 条 relationship 冻结前各被刷新过）
    // 会把该层此后 7 天全部锁死（2026-11-05 实拍：relationship 候选只差 churn_exceeded）。
    if (i.state === "frozen" || i.state === "merged") return false;
    // 只数「真的改过正文」，不数生命周期状态迁移。降级/冻结也会刷新 updatedAt，
    // 若拿 updatedAt 当改写时间，一次降级就把同层此后 7 天的准入全部锁死
    // （2026-11-05 生命周期端到端实拍：identity 降级后新候选只差 churn_exceeded）。
    const rewriteAt = typeof (i.meta as { lastRewriteAt?: unknown } | undefined)?.lastRewriteAt === "string"
      ? String((i.meta as { lastRewriteAt: string }).lastRewriteAt)
      : "";
    const t = Date.parse(rewriteAt);
    return Number.isFinite(t) && nowMs - t <= windowMs;
  }).length;
  return rewrites >= cfg.windowRewrites
    ? {
        pass: false,
        code: "churn_exceeded",
        detail: `${cfg.windowDays} 天内同层已改写 ${rewrites} 次（上限 ${cfg.windowRewrites}）`,
      }
    : { pass: true, code: "ok", detail: `窗口内改写 ${rewrites}/${cfg.windowRewrites}` };
}

export function allPass(reports: GateReport[]): boolean {
  return reports.every((r) => r.pass);
}

export function failedCodes(reports: GateReport[]): GateCode[] {
  return reports.filter((r) => !r.pass).map((r) => r.code);
}
