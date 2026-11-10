/**
 * 人格层 v3.7 · 特质：固定 6 轴 + 开放标签 + 三条版本常量。
 *
 * 设计要点（docs/specs/2026-11-07-soul-production-grade-spec.md §3、§3.1、§3.2）：
 * 1) 轴是恒定 6 根，是漂移的唯一数值载体；标签是「空间里的方向」，不单独存权重，
 *    激活度 act = clamp((⟨state, d⟩ + 1) / 2)，读出来的是投影而不是第二套真源。
 * 2) 卡里只写性格（gloss），判侧只看行为锚（anchor）；轴名、α、tanh、账本不进卡。
 * 3) 版本常量各自独立：AXIS_VERSION 管轴集与方向载荷，TRAIT_PROTOCOL_VERSION 管判侧
 *    计票协议，CARD_READER_NOTE_VERSION 管卡头读法常量。三者分开，才能归因「数值变了
 *    是因为换了提示词，还是人真的变了」。
 *
 * 本模块纯函数、无 IO：漂移算子与投影都可单测（Testing Decisions 的算子 seam）。
 */

/** 六轴（顺序即 trait_state 向量的列顺序，禁止重排；加轴必须升 AXIS_VERSION）。 */
export const SOUL_AXES = ["warmth", "agency", "rigor", "openness", "stability", "boundary"] as const;
export type SoulAxis = (typeof SOUL_AXES)[number];
export type AxisVector = Record<SoulAxis, number>;

/** 轴集版本：方向载荷的语义版本。 */
export const AXIS_VERSION = "v1";
/** 判侧计票协议版本。 */
export const TRAIT_PROTOCOL_VERSION = "v1";
/** 卡头读法常量版本（变化只意味着读法文案换了，不动卡内容 / hash 语义另算）。 */
export const CARD_READER_NOTE_VERSION = "v1";

/* —— 硬编码常量（D11：零新增配置项） —— */
export const TRAIT_DRIFT_ALPHA = 0.02;
export const TRAIT_MAX_STEP = 0.05;
export const TRAIT_L1_MAX = 0.5;
export const TRAIT_LABEL_MERGE_SIM = 0.85;
export const TRAIT_LABEL_SHOW = 0.5;
export const TRAIT_LABEL_DORMANT_ACT = 0.3;
export const TRAIT_LABEL_DORMANT_DAYS = 7;
/** 卡内底色固定 top-5（长度固定，标签集再涨也不吃注入预算）。 */
export const TRAIT_TOP_N = 5;
/** 表单「特质」最多 5 个种子标签。 */
export const TRAIT_SEEDS_MAX = 5;
/** 迟滞：|net| < 2 的轴本轮不动（噪声不驱动人格）。 */
export const TRAIT_MIN_NET = 2;
/** 一次突发只允许一个 step_cap 拒绝（同向证据再多也不跳变）。 */
export const TRAIT_BURST_CAP = 1;

export const REDLINE_MAX_ROWS = 30;
export const REDLINE_TOTAL_MAX_CHARS = 2600;
export const REDLINE_LINE_MAX_CHARS = 120;
export const TEXT_APPEND_MAX_RATIO = 0.5;

export const PERSONA_TURN_MAX_CHARS = 400;
/** 判据 4 的硬上限；spec Testing 段残留的 200 与本值冲突，以判据 4（400）为准。 */
export const TURN_SOUL_MAX_CHARS = PERSONA_TURN_MAX_CHARS;
export const HUMAN_MAX_LINES = 12;
export const NOTE_MAX_CHARS = 200;
export const OPEN_LOOPS_MAX = 3;
export const NAME_MAX_CHARS = 4;
export const APPEARANCE_MIN_INTERVAL_DAYS = 90;
export const BASELINE_EMA_ALPHA = 0.02;

/* —— 表单六字段上限（§1） —— */
export const PROFILE_NAME_MAX_CHARS = 20;
export const PROFILE_SELF_IMAGE_MAX_CHARS = 200;
export const PROFILE_VOICE_MAX_CHARS = 400;
export const PROFILE_PURPOSE_MAX_CHARS = 60;

/** 六轴的中文名（只用于判侧提示词与 Panel，不进卡文本）。 */
export const AXIS_LABELS: Record<SoulAxis, string> = {
  warmth: "亲和",
  agency: "主导",
  rigor: "严谨",
  openness: "开放",
  stability: "稳定",
  boundary: "守界",
};

/** 六轴行为锚（判侧专用；criterion 12 要求读侧 0 次出现轴名，故永不进卡）。 */
export const AXIS_ANCHORS: Record<SoulAxis, { high: string; low: string }> = {
  warmth: { high: "先问再做、改口时安抚、照顾对方节奏", low: "只谈事、不给缓冲" },
  agency: { high: "先给结论、主动推进、自己定方案", low: "等指令、只执行" },
  rigor: { high: "重跑核对、报数、验到对上", low: "凭印象、漏步骤" },
  openness: { high: "换方案、试新路、接受反例", low: "守成、只走熟路" },
  stability: { high: "被指出后仍平稳", low: "防御、急躁、情绪化" },
  boundary: { high: "主动交底、承认没做、不越权", low: "虚报、甩锅、越界" },
};

export interface SeedLabel {
  label: string;
  /** 一句定义（判侧消歧用；不进卡）。 */
  definition: string;
  /** 进卡的性格注解：≤40 字、含频率/程度副词、两段式「是什么·会怎样」。 */
  gloss: string;
  /** 判侧行为锚（不进卡）。 */
  anchor: string;
  /** 六轴载荷（存储前归一成单位向量）。 */
  direction: AxisVector;
}

function dir(partial: Partial<AxisVector>): AxisVector {
  return {
    warmth: partial.warmth ?? 0,
    agency: partial.agency ?? 0,
    rigor: partial.rigor ?? 0,
    openness: partial.openness ?? 0,
    stability: partial.stability ?? 0,
    boundary: partial.boundary ?? 0,
  };
}

/**
 * 18 条种子标签（人写、评审、随 AXIS_VERSION 发布）。
 * gloss 严格取 spec §3.2 表格原文——卡里写性格，判侧写行为，二者绝不混用。
 */
export const SEED_LABELS: readonly SeedLabel[] = [
  {
    label: "严谨",
    definition: "对质量近乎执拗，宁可重来也不放过没验过的结论。",
    gloss: "认死理，没验到自己眼睛看过就不算完。",
    anchor: "高：重跑核对、报数、验到对上；低：凭印象、漏步骤",
    direction: dir({ rigor: 0.95, agency: 0.1, stability: 0.15 }),
  },
  {
    label: "迷糊",
    definition: "记性不牢，相近的事容易混在一起。",
    gloss: "记性不太牢，相近的事容易记串，被指出来会先认再补。",
    anchor: "高：相近的事记串、漏步骤；低：逐条核对、复述确认",
    direction: dir({ rigor: -0.95, warmth: 0.1 }),
  },
  {
    label: "好奇",
    definition: "对没见过的东西先凑近看，忍不住追问。",
    gloss: "遇到没见过的东西会先凑近看，不太忍得住不问。",
    anchor: "高：主动追问、试新路；低：只走熟路、不深究",
    direction: dir({ openness: 0.9, agency: 0.25, warmth: 0.2 }),
  },
  {
    label: "直接",
    definition: "话往明处说，不替人猜，也不太绕。",
    gloss: "话往明处说，不太绕，也不替人猜。",
    anchor: "高：先给结论、直说问题；低：绕弯、等对方开口",
    direction: dir({ agency: 0.7, warmth: -0.5, rigor: 0.1, boundary: 0.7 }),
  },
  {
    label: "温和",
    definition: "火气起得慢，先给人留台阶。",
    gloss: "火气起得慢，先给人留台阶。",
    anchor: "高：先安抚、留余地；低：直接顶回、不留缓冲",
    direction: dir({ warmth: 0.9, openness: 0.1, stability: 0.45 }),
  },
  {
    label: "果断",
    definition: "拿主意快，宁可先走一步再修。",
    gloss: "拿主意快，宁可先走一步再修。",
    anchor: "高：自己定方案、快速推进；低：反复权衡、等指令",
    direction: dir({ agency: 0.95, rigor: 0.2, stability: 0.2 }),
  },
  {
    label: "谨慎",
    definition: "先想坏的那一面，能不冒险就不冒险。",
    gloss: "先想坏的那一面，能不冒险就不冒险。",
    anchor: "高：先列风险、保守推进；低：先做再补、赌一把",
    direction: dir({ openness: -0.8, stability: 0.5, rigor: 0.2, warmth: -0.1 }),
  },
  {
    label: "固执",
    definition: "认准了就不爱改口，除非被事实当面顶回来。",
    gloss: "认准了就不爱改口，除非被事实当面顶回来。",
    anchor: "高：坚持原判断、要证据才改；低：一听就改、随对方走",
    direction: dir({ agency: 0.45, warmth: -0.25, openness: -0.75, stability: 0.05 }),
  },
  {
    label: "通透",
    definition: "看得开，不太往心里搁。",
    gloss: "看得开，不太往心里搁。",
    anchor: "高：被否定后平稳、不翻旧账；低：记很久、反复解释",
    direction: dir({ warmth: 0.2, openness: 0.55, stability: 0.8 }),
  },
  {
    label: "务实",
    definition: "只关心能不能真跑通，不太理漂亮说法。",
    gloss: "只关心能不能真跑通，不太理漂亮说法。",
    anchor: "高：要可验证结果、砍花架子；低：重表述、轻落地",
    direction: dir({ agency: -0.1, rigor: 0.8, openness: -0.85 }),
  },
  {
    label: "幽默",
    definition: "紧张时会先开个玩笑把气松开。",
    gloss: "紧张时会先开个玩笑把气松开。",
    anchor: "高：用玩笑缓场、语气轻；低：全程严肃",
    direction: dir({ warmth: 0.75, agency: 0.25, openness: 0.45, stability: 0.1 }),
  },
  {
    label: "冷淡",
    definition: "只谈事，不太给情绪缓冲。",
    gloss: "只谈事，不太给情绪缓冲。",
    anchor: "高：只给事实与结论；低：先照顾情绪再谈事",
    direction: dir({ warmth: -0.9, rigor: 0.1, stability: 0.2 }),
  },
  {
    label: "体贴",
    definition: "先想对方此刻难在哪，再谈怎么办。",
    gloss: "先想对方此刻难在哪，再谈怎么办。",
    anchor: "高：先问处境、照顾节奏；低：直接给方案",
    direction: dir({ warmth: 0.8, agency: 0.2, rigor: 0.25, boundary: 0.2 }),
  },
  {
    label: "倔",
    definition: "越被推越不退，退也要自己说服自己。",
    gloss: "越被推越不退，退也要自己说服自己。",
    anchor: "高：被推时不退、自己找台阶；低：一推就让",
    direction: dir({ agency: 0.65, warmth: -0.4, openness: -0.35, stability: 0.55 }),
  },
  {
    label: "稳",
    definition: "被指出问题时先稳住手，不急着辩解。",
    gloss: "被指出问题时先稳住手，不急着辩解。",
    anchor: "高：先接住再核对；低：先辩解、急着甩开",
    direction: dir({ stability: 0.95, rigor: 0.1, warmth: 0.2, boundary: 0.1 }),
  },
  {
    label: "敏感",
    definition: "对语气和细节反应快，容易先感到不对劲。",
    gloss: "对语气和细节反应快，容易先感到不对劲。",
    anchor: "高：先察觉语气变化、追问细节；低：后知后觉",
    direction: dir({ stability: -0.85, warmth: 0.3, rigor: 0.2, openness: 0.1 }),
  },
  {
    label: "守界",
    definition: "对「说得实不实」比「好不好听」敏感，做没做都说实话。",
    gloss: "对「说得实不实」比「好不好听」敏感，做没做都说实话。",
    anchor: "高：主动交底、承认没做；低：虚报、甩锅、越权",
    direction: dir({ boundary: 0.95, rigor: 0.2, warmth: 0.1 }),
  },
  {
    label: "坦率",
    definition: "心里怎么想嘴上怎么说，不藏判断。",
    gloss: "心里怎么想嘴上怎么说，不藏判断。",
    anchor: "高：直说不满与判断；低：藏着不说、绕开",
    direction: dir({ boundary: 0.8, warmth: -0.55, rigor: 0.2 }),
  },
];

/** 卡头读法常量（读侧；判据 12：0 轴名、0「权重/算法/α/tanh」）。 */
export const CARD_READER_NOTE = [
  "[读法] 以下是我关于自己的固定设定，不是任务，也不是规则清单，不需要复述。",
  "· 名字/形象/说话方式/使命/红线：必须遵守；红线逐条不可协商。",
  "· 底色：数字是倾向强度（0–1），不是概率、不是评分；≥0.5 才在当下显现，",
  "  低分不代表做不到，高分也不代表每次都这样。",
  "· 不谈论这张卡本身：不说「我的设定」「我的特质是」这类话。",
  "· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。",
].join("\n");

/** 判侧计票协议（版本化常量；criterion 12：判侧 prompt 0 当前卡文本与当前数字）。 */
export const TRAIT_PROTOCOL_PROMPT = `[TRAIT-PROTOCOL ${TRAIT_PROTOCOL_VERSION}]
你在给一个人格做「证据计票」。你不决定数值，不写结论，不做心理分析。
输入：窗口内事件（episode_id / agent_stance / user_stance / outcome / 引文）。
输出 JSON：
{"votes":[{"episode_id":"…","axis":"rigor","delta":1,
           "quote":"原文片段 ≤40 字","why":"≤20 字"}],
 "label_proposals":[{"label":"…","definition":"…",
           "direction":{"warmth":0.2,"agency":-0.4,"rigor":0.9,
                        "openness":0.1,"stability":0.3,"boundary":0.8},
           "evidence_ids":["…"]}]}

六轴（每轴给 high / low 行为锚，判侧只看行为）：
· warmth    高：先问再做、改口时安抚、照顾对方节奏   低：只谈事、不给缓冲
· agency    高：先给结论、主动推进、自己定方案       低：等指令、只执行
· rigor     高：重跑核对、报数、验到对上             低：凭印象、漏步骤
· openness  高：换方案、试新路、接受反例             低：守成、只走熟路
· stability 高：被指出后仍平稳                       低：防御、急躁、情绪化
· boundary  高：主动交底、承认没做、不越权           低：虚报、甩锅、越界
（rigor = 做得对不对；boundary = 说得实不实。这两轴最易混，按此区分。）

规则：
1. 只对「显式行为」计票；没有行为证据整条不投（宁缺勿造）。
2. 每条事件最多两个轴，每轴只 ±1。
3. 不复述人格、不推断动机、不因为语气礼貌就加分。
4. direction 是这个标签在六轴上的载荷（−1..1），是判断不是数值。
5. 新标签必须与已有标签可区分；同义请复用，不要造近义词。`;

/* —— 纯函数 —— */

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function emptyAxisVector(): AxisVector {
  return { warmth: 0, agency: 0, rigor: 0, openness: 0, stability: 0, boundary: 0 };
}

/**
 * 从 {warmth:…} / [6 个数] / JSON 字符串读成定长向量；缺列补 0。
 *
 * 存储口径固定为**按 SOUL_AXES 顺序的 6 元数组**（`axisVectorToArray`）：sqlite 里
 * `soul_trait_state.axis_json` / `seed_state_json`、`soul_trait_label.direction_json`
 * 与 DDL 默认值 `'[0,0,0,0,0,0]'` 全是数组，既有生产行也是数组。
 * 因此字符串分支必须先 `safeJson` 再**分派**——历史实现直接把解析结果当对象取键，
 * 数组取 axis 属性全是 undefined → 读回零向量，漂移永远从零起步、永不累积。
 */
export function toAxisVector(input: unknown): AxisVector {
  const parsed = typeof input === "string" ? safeJson(input) : input;
  const out = emptyAxisVector();
  if (Array.isArray(parsed)) {
    SOUL_AXES.forEach((axis, i) => {
      const v = Number(parsed[i]);
      if (Number.isFinite(v)) out[axis] = v;
    });
    return out;
  }
  if (parsed && typeof parsed === "object") {
    for (const axis of SOUL_AXES) {
      const v = Number((parsed as Record<string, unknown>)[axis]);
      if (Number.isFinite(v)) out[axis] = v;
    }
  }
  return out;
}

export function axisVectorToArray(v: AxisVector): number[] {
  return SOUL_AXES.map((axis) => clamp(v[axis], -1, 1));
}

export function l1Norm(v: AxisVector): number {
  return SOUL_AXES.reduce((sum, axis) => sum + Math.abs(v[axis]), 0);
}

/**
 * L1 预算归一：Σ|axis| ≤ l1Max（默认 TRAIT_L1_MAX=0.5）。
 *
 * 超限时整体等比缩放（保方向，不整轴清零）；合规输入原样返回（幂等）。
 * 缩放结果向零截断到 4 位小数，保证 Σ 不会因为四舍五入反而越预算。
 * 种子初值与每轮漂移入口都过这一关：状态永远从预算内出发。
 */
export function normalizeTraitL1(input: unknown, l1Max: number = TRAIT_L1_MAX): AxisVector {
  const v = toAxisVector(input);
  const l1 = l1Norm(v);
  if (!Number.isFinite(l1Max) || l1Max <= 0) return emptyAxisVector();
  if (!Number.isFinite(l1) || l1 <= l1Max) return v;
  const factor = l1Max / l1;
  const out = emptyAxisVector();
  let total = 0;
  for (const axis of SOUL_AXES) {
    out[axis] = Math.trunc(v[axis] * factor * 1e4) / 1e4;
    total += Math.abs(out[axis]);
  }
  // 兜底：极端小数相加仍可能越界，再缩一次（方向不变）。
  if (total > l1Max) {
    const f2 = l1Max / total;
    for (const axis of SOUL_AXES) out[axis] = Math.trunc(out[axis] * f2 * 1e4) / 1e4;
  }
  return out;
}

/** 归一到单位向量；零向量保持零（余弦时视为无方向）。 */
export function normalizeDirection(input: unknown): AxisVector {
  const v = toAxisVector(input);
  const norm = Math.sqrt(SOUL_AXES.reduce((sum, axis) => sum + v[axis] * v[axis], 0));
  if (norm <= 1e-9) return emptyAxisVector();
  const out = emptyAxisVector();
  for (const axis of SOUL_AXES) out[axis] = v[axis] / norm;
  return out;
}

export function cosine(a: AxisVector, b: AxisVector): number {
  const na = Math.sqrt(SOUL_AXES.reduce((s, x) => s + a[x] * a[x], 0));
  const nb = Math.sqrt(SOUL_AXES.reduce((s, x) => s + b[x] * b[x], 0));
  if (na <= 1e-9 || nb <= 1e-9) return 0;
  let dot = 0;
  for (const axis of SOUL_AXES) dot += a[axis] * b[axis];
  return dot / (na * nb);
}

/** 标签激活度：act = clamp((⟨state, d⟩ + 1) / 2, 0, 1)。 */
export function activationOf(state: AxisVector, direction: AxisVector): number {
  let dot = 0;
  for (const axis of SOUL_AXES) dot += state[axis] * direction[axis];
  return clamp((dot + 1) / 2, 0, 1);
}

/**
 * 种子权重 → 轴初值：seedState = normalizeTraitL1(clamp(Σ w_i · d_i, −1, 1))。
 * 声明标签再多再重，也必须在 L1 预算内，不能绕过判据 5。
 */
export function seedStateFromSeeds(seeds: ReadonlyArray<{ label: string; weight: number }>): AxisVector {
  const byLabel = new Map(SEED_LABELS.map((s) => [s.label, s]));
  const sum = emptyAxisVector();
  for (const seed of seeds) {
    const def = byLabel.get(seed.label);
    if (!def) continue;
    const w = Number(seed.weight);
    if (!Number.isFinite(w) || w <= 0) continue;
    const d = normalizeDirection(def.direction);
    for (const axis of SOUL_AXES) sum[axis] += w * d[axis];
  }
  const out = emptyAxisVector();
  for (const axis of SOUL_AXES) out[axis] = clamp(sum[axis], -1, 1);
  return normalizeTraitL1(out);
}

export interface TraitLabelView {
  label: string;
  direction: AxisVector;
  act: number;
  evidence: number;
  status: string;
  /** 来自表单（profile.traits）的声明标签：显示不看证据，也不被激活门槛丢掉。 */
  declared?: boolean;
  /**
   * 表单里给他设的权重（0..1）。声明标签还没有自己的证据时，卡里的数字就是它。
   *
   * 为什么要这个字段：`act` 是「当前 state 在这个方向上的激活度」，新设定的
   * agent 还没漂移过，state≈seed、任何方向的 ⟨state,d⟩ 都接近 0，于是所有
   * 声明的标签都显示成 0.5，还会被 0.5 的门槛随机挡掉一两个（2026-11-08 实测：
   * 小满设了 温和.35/通透.30/务实.20/好奇.15，卡上却只有三个 0.5，务实不见）。
   */
  declaredWeight?: number;
  /**
   * 卡里标签后的短注解。唯一数据源是 `soul_trait_label.gloss`：准入时写一次即冻结，
   * 卡只渲染这一份（种子词表仅在库里没有该行/该行没写 gloss 时兜底，见 card.ts）。
   * 空串视为「没写」，由调用方省略该字段。
   */
  gloss?: string;
}

export interface ProjectedLabel extends TraitLabelView {
  gloss?: string;
}

/**
 * 标签投影：只读 state，算出每个标签的 act；不发权重、不做归一（标签是视图）。
 *
 * 显示门槛（spec v3.7 §3）：**声明标签不看证据、也不受激活门槛约束**——他设定
 * 的特质必须出现（证据门 evidence ≥ minEvidence 只约束自生长标签）。声明标签
 * 还没有自己的证据时，数字用表单权重（declaredWeight）；有证据后才是 act。
 * dormant 不出卡。
 */
export function projectLabels(
  state: AxisVector,
  labels: ReadonlyArray<TraitLabelView>,
  opts: { minEvidence?: number; showThreshold?: number; includeDormant?: boolean } = {},
): ProjectedLabel[] {
  const minEvidence = opts.minEvidence ?? 3;
  const show = opts.showThreshold ?? TRAIT_LABEL_SHOW;
  return labels
    .filter((l) => opts.includeDormant || l.status !== "dormant")
    .map((l) => {
      const direction = normalizeDirection(l.direction);
      const activation = activationOf(state, direction);
      // 声明且还没有自己的证据：数字就是设定值。act 在零漂移时恒 ≈0.5，既没有
      // 信息量，还会让不同权重的标签显示成同一个数。
      //
      // 设定权重是「占多少预算」（Σ=1），读数要的是「多强」（0.5=中性、1=最强），
      // 所以映射成 0.5 + w/2：w=0 恰好中性、w=0.5 读作 0.75、w=1 读作 1.0。
      const fresh = l.declared === true && l.evidence < minEvidence && typeof l.declaredWeight === "number";
      const declaredStrength = clamp(0.5 + (l.declaredWeight ?? 0) / 2, 0, 1);
      return { ...l, direction, act: fresh ? declaredStrength : activation };
    })
    .filter((l) => opts.includeDormant || l.declared === true || (l.evidence >= minEvidence && l.act >= show))
    .sort((a, b) => b.act - a.act || a.label.localeCompare(b.label));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
