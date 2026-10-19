/**
 * soul-assembler —— 灵魂组装器（SOUL-PIPELINE §2.2，Phase 1）。
 *
 * 灵魂公式：此刻的你 + 过去的记忆 + 当下的感受 → 下一刻的你。
 * 本模块产出注入块前缀（身份段 + 感受段）；记忆段由既有 relevant-memories 块承载（零改动）。
 *
 * 设计决策：
 * - 加法式：前缀拼在既有块前，排序/过滤/消毒语义零回归。
 * - 身份材料：core_memory slots（identity 自发现产出）+ core_values 价值锚（自发现 + valence 方向）。
 * - 感受段：锚的 valence 方向合成（趋近/审慎）——moodSign 的可读形态。
 * - 全部材料 escapeXmlTags（程序化组装与写入路径同级消毒）。
 * - 宁缺毋滥：无材料 → 空串（不注入空段）。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
// #42（ADR0003-P3 票 D / D9）：锚相似度打分器（确定性 cosine，shadow-first；本模块管选择/报告语义）。
import { isUsableQueryVec, scoreAnchorRows, selectAnchorRows, selectAnchorRowsMmr, type AnchorEmbedder } from "./soul-anchor-scorer.js";
// T4（方案 Task 4，2026-10-17）：#42 shadow 定标落盘——行为零变化旁路采集（fail-safe 降级）。
import { appendAnchorShadowRow } from "./soul-anchor-shadow-sink.js";
// #52 P1（2026-10-18）：红线段渲染单一源——多行 strict_rule 槽逐行打 tag+剥行首自身弹头
//（旧渲染只首行带 tag 且不剥弹头 = 生产畸形实锚）；MemoryProxy 侧逐位镜像 + 契约测试钉等价。
import { renderStrictRuleSectionLines } from "./soul-redline-render.js";
// 灵魂注入去重单一源（2026-10-18 生产实测驱动）：红线近重复行（Jaccard/containment/保长）
// 与价值锚 label 包含对（完整句优先）——只做选择不改写（真实性边界），门由调用方配置携带。
import {
  dedupeAnchorPairs,
  dedupeAnchorPairsEmbedding,
  dedupeNearDuplicateLines,
  suppressAnchorOverlapRows,
} from "./soul-dedupe.js";
import type { Logger } from "../types.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { looksLikeEpisode } from "./episode-gate.js";
import { renderStateLine, type SoulState } from "./soul-state.js";

/**
 * D-1（2026-09-21，用户拍板"全做"）：F17 截断改按行（事实）边界。
 *
 * 旧行为（§2.7 F17 字符 slice）截在事实句中间——注入块以残句喂 LLM，主语完整性破损
 *（2026-09-21 活体实证：self 600 字符截于"如 identit"）。新行为：逐行累积预算内整行、
 * 超限行整体丢弃（宁缺毋滥）；无一行可用时退回首行字符截断（槽不空，避免整段注入丢失）。
 * A/B 新旧对照 ≥10 组（真实生产槽内容）见 UI 对话验收记录与 spec §2.7 注记。
 */
export function truncateByLines(content: string, budget: number): string {
  if (budget <= 0 || content.length <= budget) return content;
  const lines = content.split("\n");
  if (lines.length <= 1) return content.slice(0, budget);
  let acc = "";
  for (const line of lines) {
    const next = acc ? `${acc}\n${line}` : line;
    if (next.length > budget) break;
    acc = next;
  }
  // 无任何完整行可用（首行即超预算）→ 首行字符截断兜底（宁缺毋滥不等于整段清空）
  if (!acc) return content.slice(0, budget);
  return acc;
}

/**
 * #10 T4（2026-10-14）：锚列表行注入预算——价值锚行/重要的人行/品格行三处共用。
 * 粒度=整项（票面定案）：按入参顺序（value_id 稳定序）累积（"；" 分隔计长），超预算
 * 从尾丢整项，不截半句（裸 desc 门已保证每项非空，截半句只会产生断尾残句）。
 * 例外：首项即超预算 → 保首项整句（槽不空原则，与 truncateByLines 的兜底同精神，
 * 但不做字符切片——宁超勿断）。
 * maxChars ≤ 0 = 无预算 = 原样返回（缺省 0=逐位现状，config-first 铁律；放量在配置层）。
 */
export function applyAnchorBudget(items: string[], maxChars: number): string[] {
  if (!maxChars || maxChars <= 0) return items;
  const kept: string[] = [];
  let acc = "";
  for (const item of items) {
    const next = acc ? `${acc}；${item}` : item;
    if (next.length > maxChars && kept.length > 0) break;
    acc = next;
    kept.push(item);
  }
  return kept;
}

/**
 * R5 #23（2026-10-16）：「首要」详述首句长度单一源（V7 方案A 80 字常量化，原代码内联魔法数）。
 * 首要子句渲染规则：首句（句边界 [。！？；!?\n] 截取）≤ 该值 → 首要子句带首句；
 * 无句界且全文 ≤ 该值 → 带全文；否则首要子句省略、该锚退回感受段清单成员（宁缺毋滥不丢成员）。
 */
export const SOUL_TOP_DESC_MAX_CHARS = 80;

/**
 * T3（方案 Task 3，2026-10-17）：承诺块行数上限单一源——「我的承诺：」只渲染最新
 * 3 条 open 承诺（createdAt desc，最新在前）。宁缺毋滥：上限防承诺累积成第二份
 * 调试清单；存量可见性由 D8 账本（soul_promise_events/Panel 待办栏）承载。
 */
export const SOUL_PROMISE_RENDER_MAX = 3;

/**
 * v18-d（何晨拍板「全做」2026-10-05）：desc 悬空尾判定单一源（高置信断尾门）。
 * 置空判据只留确定性特征：剥尾引号[”"』」']后尾悬空标点[，、,]（截断在句读处 =
 * 后面还有内容被掐，语义未完态明确）。
 * 长度判据已删除（复跑实锤：合法锚 desc「所有结论须以真实代码与测试取证背书」17 字与
 * 断尾残句「何晨一贯要求系统行为」10 字区间完全重叠，任何阈值都同时误杀/放行——低置信
 * 不判，宁缺毋滥 ≠ 宁枉勿纵）。断尾半句根治面 = ①写入口 sanitizeDescription truncated 门
 * （60 字窗口截断无句读 = 确定性断尾 → 置空）；②存量断尾 desc 走 G-ANCHORDESC-WRITE
 * gated 回填。消费方：soul-assembler 渲染两处（价值锚行/person 行）+
 * pending-adopt-merge.sanitizeDescription 写入口（gateway→core/hooks 引用方向合法）。
 */
export function isDanglingTail(s: string): boolean {
  if (typeof s !== "string") return false;
  const bare = s.replace(/[”"』」']+/gu, "");
  return /[，、,]$/.test(bare);
}

function valenceDir(v: number | null | undefined): string {
  if (v === 1) return "趋近";
  if (v === -1) return "审慎";
  if (v === 0) return "中性";
  return "";
}

/** P2（spec §2.7）：人物锚关系方向词——与主题价值方向（审慎）区分（回避≠审慎）。 */
function personDir(v: number | null | undefined): string {
  if (v === 1) return "趋近";
  if (v === -1) return "回避";
  if (v === 0) return "中性";
  return "";
}

/** DS-SOUL-MEMORY-002 P1（F17）：段级渲染选项。缺省（undefined）= 旧渲染字节级一致。 */
export interface SoulRenderOptions {
  selfIdentityEnabled?: boolean;
  budgetSelfChars?: number;
  budgetIdentityChars?: number;
  /** F17（审计补齐）：重要的人 行数上限（weight DESC 截断）；缺省 5=原行为。 */
  maxRelationLines?: number;
  /** S-FEEL-1（M1）：近期情绪基调（mood-line.ts 聚合产出；缺省 undefined=基调行不渲染=逐位现状）。
   *  soulVersion 指纹只纳入 tier 不纳入 sampleCount（三值化控 KV 抖动——设计 §1.3；
   *  count 文本随任一指纹变化刷新，陈旧性为已登记取舍）。 */
  moodTier?: { tier: "positive" | "neutral" | "strained"; sampleCount: number } | null;
  /** #34（S13/R5）：会话级当下状态（soul-feeling 尾块行；不参与 soulVersion 指纹，参与 cacheKey）。 */
  state?: SoulState | null;
  /** S-CHAR-2（M2/P5）：品格行渲染门（缺省 false=逐位现状：品格锚混渲染于价值锚行）。
   *  开启：价值锚行排除 character（与感受段 theme-only filter 对齐）+「我是谁」小节尾部「我的品格：」行。 */
  characterTensionEnabled?: boolean;
  /** #10 T4：价值锚行总长预算（整锚粒度，join("；") 计长；缺省 0=无预算=逐位现状）。 */
  budgetAnchorChars?: number;
  /** #10 T4：重要的人 行总长预算（整人粒度；缺省 0=无预算=逐位现状）。 */
  budgetPersonChars?: number;
  /** #10 T4：品格行总长预算（整锚粒度；缺省 0=无预算=逐位现状）。 */
  budgetCharacterChars?: number;
  /** #30（S9/R5）：soul 快照旁路落账门（缺省 true=纯增量持久化，不触碰注入字节；
   *  false=运维关闭开关）。指纹变化后首次渲染 append 一行（last-hash 去重防膨胀）。 */
  snapshotsEnabled?: boolean;
  /** #52 D3（双通道 slots 去重）：per-turn 身份两行省略门——缺省 true（undefined 同）=逐位
   *  现状；显式 false=dual（selfIdentityEnabled=true）路径跳过（我是谁）[self_identity] 与
   *  （我心中的他）[identity] 两行 slots 行（会话头时机已承载，逐轮省略）；红线段
   *  （strict_rule 仍走红线段）、价值锚行、重要的人、品格行、感受段（含当下状态/近期基调）、
   *  capabilities 段照常渲染。legacy（dual=false）不适用（身份行是 legacy 路径唯一身份载体，
   *  不静默丢失）。布局级渲染门：进 prefix cacheKey（false 才进键段）；不进 soulVersion
   *  （ADR0003 批次纪律：布局变更不翻 sv，soulVer 只由数据驱动）。 */
  perTurnSlots?: boolean;
  /** #29（R5）：情境锚选择触发门——价值锚行数 > maxRows 才启用；shadow 先行：只报告不裁剪、
   *  渲染逐位现状。#42（票 D / D9）：相似度打分器接线——enabled 缺省 false（shadow 报告随
   *  向量可用性升级逐锚分形态）；enabled=true=转正（threshold 硬门+top-K）；#52 D3 选项C：
   *  仅 rows.length > maxRows（发生裁剪）时按 cosine desc 重排渲染行，rows ≤ maxRows 不重排
   *  （value_id 声明序）。embedder/queryEmbedding 为运行时注入（config 不携带向量）；任一
   *  缺席→回退现状形态（宁缺毋滥不造分）。 */
  anchorSelect?: {
    maxRows?: number;
    /** T4（方案 Task 4，2026-10-17）：#42 shadow 定标落盘门——缺省关（零写盘零采集）。
     *  true=shadow 打分真实发生时（rows>maxRows + embedder + 可用查询向量）追加一行
     *  定标 jsonl（wouldSelect/actuallySelected/agree）；file 缺省
     *  data/logs/soul-anchor-shadow.jsonl。行为零变化旁路（渲染字节不受影响）。 */
    shadowSink?: { enabled?: boolean; file?: string };
    scorer?: {
      enabled?: boolean;
      threshold?: number;
      queryEmbedding?: Float32Array | null;
      embedder?: AnchorEmbedder | null;
      /** #42 审查加固（F1 生产接线）：懒解析 provider——auto-recall 注入（cachedQueryEmbedding
       *  与检索路共享 TTL 去重）；仅转正选择或 shadow 报告真正需要向量时才调（缺省配置零 embed）。
       *  与 queryEmbedding 二选一，显式向量优先；解析失败/缺席→回退现状（宁缺毋滥不造分）。 */
      queryEmbeddingProvider?: (() => Promise<Float32Array | null | undefined>) | null;
      /** #42 审查加固：查询原文（cacheKey 指纹源——queryText 优先于向量量化，零 embed 成本）。 */
      queryText?: string | null;
      /** 灵魂注入质量轮（2026-10-19）：MMR 多样性 λ（val=λ·rel−(1−λ)·maxSim，缺省 0.7）。
       *  生产实证纯 cosine top-K 会把语义近重复锚（如「取证」族）整团选入价值锚块；MMR 在
       *  scoreAnchorRows 产出的向量上做贪心多样性选择（零额外 embed）。λ=1 退化为纯 top-K。 */
      mmrLambda?: number;
      /** 锚 desc 并行预嵌软预算（ms；0=关=逐位现状）：超预算抛错→catch 回退声明序锚行，
       *  本轮渲染标记降级（**不写** soulPrefixCache/soul 快照——降级渲染不冒充完整质量渲染
       *  污染缓存与账本）；in-flight embed 继续落缓存，下一请求得完整 MMR。
       *  生产默认 1200（config anchorSelect.scorer.embedBudgetMs）。 */
      embedBudgetMs?: number;
    };
  };
  /** #32（R5）：能力自述清单（运行时实况，只读派生置身份段尾「## 我能做什么」）。
   *  零落库；一致性合同=渲染行=传入清单（顺序保持）；策展 ≤5 行由调用方负责；
   *  缺省 undefined=不渲染=逐位现状。cacheKey 含清单指纹（字节影响面）。 */
  capabilities?: string[];
  /** T3（方案 Task 3，2026-10-17）：承诺块渲染门——未来性注入面（#35/D8 承诺层）。
   *  缺省 false（config-first 缺省关=逐位现状，零新增注入）；true 时 buildSoulPrefix
   *  经 store.listSoulPromises（可选方法，types.ts:813）拉取 open 承诺，身份段
   *  「我的承诺：」行渲染最新 SOUL_PROMISE_RENDER_MAX 条（createdAt desc，content
   *  逐字直出）。承诺集参与 soulVersion（-pm 指纹段，承诺变化必重渲染）。 */
  promisesEnabled?: boolean;
  /** 灵魂注入去重轮（2026-10-18，生产实测驱动）：红线近重复行去重门——缺省 undefined/off
   *  =逐位现状（段级选项语义 :117 同款）。开启：renderStrictRuleSectionLines 输出上做独立
   *  后处理 pass（不动单一源文件契约）：归一全同 / char-bigram Jaccard ≥ 阈值（缺省 0.45，
   *  标定=生产 14 行全量 pairwise：真重复 0.608 / 最大语义异对 0.266）/ containment ≥0.9
   *  （≥8 bigram 护栏）；保长规则=归一后更长者胜（更具体不变量留在注入面）；kept 行体逐字
   *  保留（不截断/不改写/不合并——真实性边界=选择而非改写）。渲染布局影响面：进 prefix
   *  cacheKey（srd=1[@阈值] 段）；不进 soulVersion（slots 数据未变）。
   *  maxLines：红线行数硬上限（渲染面治理——红线墙挤占身份段；0=不设限=缺省逐位现状；
   *  去重后截断保前 N=renderStrictRuleSectionLines 输出序=数据权重序；dropped 落 debug）。
   *  suppressAnchorOverlap：跨段抑制——价值锚 desc 与红线行语义重复时锚行让位（红线是硬
   *  约束承载面，重复的价值锚行属冗余注入；jaccard 通道 + 可选 embedding cosine 通道）；
   *  缺省 false=两段独立渲染=逐位现状。cacheKey 含 sup/max 段。 */
  strictRuleDedup?: {
    enabled?: boolean;
    jaccardThreshold?: number;
    maxLines?: number;
    suppressAnchorOverlap?: boolean;
  };
  /** 同轮：价值锚 label 近重复去重门——缺省 undefined/off=逐位现状。开启：decoratedPairs
   *  （desc 门后）上做归一 label 全同 / 双向包含（短侧 ≥2 字护栏）判定，择优保留：
   *  (1) desc 完整句（句末标点）胜（生产实锚：根因=事故叙事 vs 根因优先=完整原则句）；
   *  (2) desc 更长者胜；(3) 平手保首现（value_id 稳定序，不抖动）；winner 原位替换。
   *  在 #42 scorer 消费前执行（被去重锚不进 embed 成本与 top-K 选择面）；进 cacheKey（ad=1）。
   *  embeddingThreshold：第二通道——desc 向量 cosine ≥ 阈值判近重复（label 包含抓不住的同义
   *  改写对，如「一手证据」vs「取证先行」）；缺省 0=关=逐位现状；embedder 复用
   *  anchorSelect.scorer.embedder（不在位时通道静默跳过=仅 label 通道）；标定 0.85
   *  （同义改写对 0.86-0.94 vs 最大语义异对 <0.62）；进 cacheKey（adEmb 段）。 */
  anchorDedup?: { enabled?: boolean; embeddingThreshold?: number };
}

/** 立项①（2026-09-23 拍板）：attrs_json 安全解析（description/role/aliases；损坏→undefined 宁缺毋滥）。 */
function attrsOf(attrsJson?: string): { description?: string; role?: string; aliases?: string[] } | undefined {
  if (!attrsJson || attrsJson === "{}") return undefined;
  try {
    const p = JSON.parse(attrsJson);
    return p && typeof p === "object" ? (p as { description?: string; role?: string; aliases?: string[] }) : undefined;
  } catch {
    return undefined;
  }
}

/** 立项③：灵魂指纹（soulVersion）——双槽内容 ∪ 锚集合的稳定哈希（fnv-1a 32bit，零依赖）。
 *  未变化=桥接端可复用上轮 soul 字节（KV cache 连续性）；变化=立即重注入（人格不冻结）。 */
export function computeSoulVersion(
  slots: Array<{ slot: string; content: string }>,
  values: Array<{ value_id?: string; label?: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string }>,
  moodTier?: string,
): string {
  // S-FEEL-1（M1/IF-2）：moodTier 缺省 undefined → payload 与现状逐字节一致（快照守卫断言）；
  // 只纳入档位（三值化控 KV 抖动——设计 §1.3），不纳入样本数。
  const payloadBase = {
    s: slots.map((x) => [x.slot, x.content]),
    v: values
      .map((x) => [x.value_id ?? x.label, x.label, x.weight ?? 0, x.valence ?? null, x.state ?? "active", x.node_type ?? "theme", x.attrs_json ?? "{}"])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  const payload = JSON.stringify(moodTier !== undefined ? { ...payloadBase, m: moodTier } : payloadBase);
  return `sv-${fnv1a32Hex(payload)}`;
}

/** FNV-1a 32bit（零依赖）→ 8 位十六进制（无前缀）。
 *  R5-F1（2026-10-16 对抗审查）：乘法用 Math.imul 保持 32 位语义——原 (h*0x01000193)>>>0
 *  中间积最高 ~7.2e16 超 2^53 精度丢失，非标准 FNV-1a；现与 MemoryProxy
 *  soul-overlap-journal.ts 同算法。>>>0 仍必须保留（Math.imul 返回带符号 int32，
 *  负数 toString(16) 会产出 sv--xxx 双横线畸形——P14/P50 探针抓到后修正）。
 *  R5-F2：sv（人格指纹=slots/values/mood）与快照 contentHash（渲染字节哈希）共用
 *  本算法但语义不同——同 sv 可有多个布局 payload，contentHash 逐一入账不互抑。 */
function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 立项③ TDB 内部完整实现（2026-09-23 拍板）：soul 前缀会话级缓存——指纹未变化跳过渲染，
 *  变化时重渲染并打「人格变更」日志（审计面）。Map 按租户隔离，上限 100 条。
 *  零外部依赖——整个优化闭环在 TDB 内核完成。 */
const soulPrefixCache = new Map<string, { version: string; text: string; snapshotted?: boolean }>();
const SOUL_CACHE_MAX = 100;

/** #42 审查加固（F3 静默错红线）：scorer.enabled=true 但向量面缺席（embedder/query 向量均不在位）
 *  =配置生效承诺落空且零提示——进程内告警一次（重启复位），指向运行时注入侧排查。
 *  不随请求重复告警（每轮刷屏反稀释）；导出 reset 仅供单测可见（同 resetAnchorVectorCacheForTest 先例）。 */
let soulScorerMisconfigWarned = false;
export function resetSoulScorerMisconfigWarnForTest(): void {
  soulScorerMisconfigWarned = false;
}

export async function buildSoulPrefix(
  store: IMemoryStore,
  tenant: CoreTenant,
  logger?: Logger,
  opts?: SoulRenderOptions,
  metaOut?: { soulVersion?: string },
): Promise<string> {
  const parts: string[] = [];
  let soulVer = '';
  let cacheKey = '';
  // 质量轮（2026-10-19）：降级渲染旗标——scorer embed 失败/超预算回退声明序时置位；
  // 函数尾 soulPrefixCache/soul 快照写入门守卫（降级串不得冒充完整渲染入缓存/账本）。
  let soulRenderDegraded = false;
  try {
    const slots = ((await Promise.resolve(store.readCore?.(tenant))) ?? []) as Array<{ slot: string; content: string }>;
    const values = ((await Promise.resolve(store.listValues?.(tenant))) ?? []) as Array<{ value_id?: string; label: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string }>;
    const activeAll = values.filter((v) => v.state === undefined || v.state === "active");
    // P2（spec §2.7）：person 锚分流——主题锚渲染不变（undefined → theme 旧库兼容）；
    // 人物锚进「重要的人」行（weight DESC，行数上限 opts.maxRelationLines 缺省 5），不与价值审慎/趋近语义混淆。
    // S-CHAR-2（M2/P5）：渲染门开启时价值锚行排除 character（品格迁「我的品格：」行）；关断=逐位现状。
    const active = opts?.characterTensionEnabled === true
      ? activeAll.filter((v) => v.node_type !== "person" && v.node_type !== "character")
      : activeAll.filter((v) => v.node_type !== "person");
    const personRows = activeAll
      .filter((v) => v.node_type === "person")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, opts?.maxRelationLines ?? 5)
      // 立项②（2026-09-23 拍板）：取舍按 weight、渲染按 value_id 稳定排序（KV cache 前缀连续性）
      .sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)));

    // T3（未来性渲染面）：承诺数据面——gate=opts.promisesEnabled（config-first 缺省关：
    // 关断零查询零渲染零指纹附加=逐位现状）；store 无该方法 → 空清单（可选方法契约）。
    // 客户端二次滤 status（store 忽略 status 参数也不漏渲非 open）；content 空/非串行剔除。
    const promiseRows = opts?.promisesEnabled === true
      ? (((await Promise.resolve(store.listSoulPromises?.(tenant, { status: "open", limit: 1000 }))) ?? []) as Array<{ content: string; status: string; createdAt: string }>)
          .filter((p) => p.status === "open" && typeof p.content === "string" && p.content.trim() !== "")
      : [];
    soulVer = computeSoulVersion(slots, activeAll, opts?.moodTier?.tier);
    // T3：承诺集参与指纹（承诺变化=自我陈述变化=必须重渲染，人格不冻结）。指纹段
    // 仅 gate on 时附加（关断时 sv 字节与现状一致——快照守卫/旧调用点零破坏）；
    // 指纹源=createdAt+content 确定性序列化排序（序稳定，不依赖 store 返回序）。
    if (opts?.promisesEnabled === true) {
      const pmFp = fnv1a32Hex(
        promiseRows
          .map((p) => `${p.createdAt}\u0000${p.content}`)
          .sort()
          .join("\n"),
      );
      soulVer = `${soulVer}-pm${pmFp}`;
    }
    if (metaOut) metaOut.soulVersion = soulVer;

    // 立项③：指纹→缓存命中跳渲染 / 变更重渲染+人格变更日志
    // #10 T4：缓存键含渲染参数指纹——soulVersion 只由数据算出，同数据不同渲染参数
    // （dual/预算/行数上限）必须换缓存，否则旧渲染串在新参数下复活。
    // moodTier.sampleCount 的陈旧性为 S-FEEL-1 已登记取舍（指纹只含 tier），此处不重复纳入。
    // #42：scorer 签名并入 cacheKey——转正（enabled=true）时渲染依赖查询向量（每请求变），
    // 必须换缓存键防「上一查询的选择串在新请求复活」。
    // #42 审查加固（I-1 对齐设计定案）：签名仅在 enabled===true 时非空——shadow/缺省渲染与
    // 查询无关，不加段（cacheKey 与现状逐字节同构，部署升级不冷启动）；enabled=true 无向量时
    // 段仍存在（`,scorer=1,t,`）但渲染与 shadow 同字节，无害。
    // #42 审查加固（I-3 接受留痕）：指纹源=queryText 原文 fnv1a32Hex（零 embed 成本）；32 位
    // 碰撞窗口=同租户同参数下两不同 queryText 同 8hex → 单请求陈旧选择（进程内 100 条 FIFO、
    // 短时效、非行为错分）——与锚向量缓存「碰撞=静默错分」不对称，接受并留痕；无 queryText
    // 才量化显式 queryEmbedding（provider 不在指纹期解析——指纹只换键不触发 embed）。
    const scorerSig =
      opts?.anchorSelect?.scorer?.enabled === true
        ? `,scorer=1,${opts.anchorSelect.scorer.threshold ?? 0},mmr=${opts.anchorSelect.scorer.mmrLambda ?? 0.7},eb=${opts.anchorSelect.scorer.embedBudgetMs ?? 0},${
            opts.anchorSelect.scorer.queryText
              ? fnv1a32Hex(opts.anchorSelect.scorer.queryText)
              : opts.anchorSelect.scorer.queryEmbedding
                ? fnv1a32Hex(
                    Array.from(opts.anchorSelect.scorer.queryEmbedding, (v) => (Math.round(v * 1e4) / 1e4).toString(36)).join(","),
                  )
                : ""
          }`
        : "";
    cacheKey = [
      `${tenant.teamId}|${tenant.userId}|${tenant.agentId}`,
      `r=${opts?.selfIdentityEnabled ? 1 : 0},${opts?.budgetSelfChars ?? 0},${opts?.budgetIdentityChars ?? 0},${opts?.maxRelationLines ?? 0},${opts?.budgetAnchorChars ?? 0},${opts?.budgetPersonChars ?? 0},${opts?.budgetCharacterChars ?? 0},${opts?.characterTensionEnabled ? 1 : 0},${opts?.anchorSelect?.maxRows ?? 0},${opts?.capabilities ? fnv1a32Hex(opts.capabilities.join("\n")) : ""}${opts?.perTurnSlots === false ? ",pt=0" : ""}${opts?.promisesEnabled === true ? ",pm=1" : ""}${opts?.strictRuleDedup?.enabled === true ? `,srd=1${opts.strictRuleDedup.jaccardThreshold != null ? `@${opts.strictRuleDedup.jaccardThreshold}` : ""}${opts.strictRuleDedup.maxLines ? `,max=${opts.strictRuleDedup.maxLines}` : ""}${opts.strictRuleDedup.suppressAnchorOverlap === true ? ",sup=1" : ""}` : ""}${opts?.anchorDedup?.enabled === true ? `,ad=1${opts.anchorDedup.embeddingThreshold ? `,adEmb=${opts.anchorDedup.embeddingThreshold}` : ""}` : ""}${scorerSig}`,
      // #34：state 参与 cacheKey（进程内缓存正确性）但**不参与 soulVersion 指纹**
      //（指纹隔离断言见 soul-state.test.ts）——state 混入指纹=每轮前缀缓存全失效。
      // 确定性序列化（toFixed 固定位+topValue 原文），不依赖 JSON 键序。
      `st=${opts?.state ? `${Number(opts.state.valence).toFixed(3)},${Number(opts.state.arousal).toFixed(3)},${opts.state.topValue ?? ""}` : "na"}`,
    ].join("|");
    const cached = soulPrefixCache.get(cacheKey);
    if (cached && cached.version === soulVer) {
      logger?.debug?.(`[soul] prefix cache hit ${soulVer}`);
      // #30：缓存命中路径的快照补账——进程内渲染过≠已落账（写失败/中途关断重开）。
      // snapshotted 旗标=已确认落账（或确认无需写）→ 零额外查询；未确认才做一次
      // last-hash 去重检查（payload=缓存文本=同指纹同渲染，字节一致）。
      if (opts?.snapshotsEnabled !== false && !cached.snapshotted && cached.text !== "") {
        try {
          // R5-F2：contentHash=渲染字节哈希（非 sv）——同 sv 不同布局（渲染参数变体）
          // 各自成行，账本对注入字节完整可查。
          const contentHash = fnv1a32Hex(cached.text);
          const lastHash = await Promise.resolve(store.readLastSoulSnapshotHash?.(tenant));
          if (lastHash !== contentHash && store.writeSoulSnapshot) {
            await Promise.resolve(store.writeSoulSnapshot(tenant, {
              ts: new Date().toISOString(),
              contentHash,
              payloadJson: cached.text,
              trigger: "render",
            }));
          }
          cached.snapshotted = true;
        } catch (err) {
          // R5-F5：吞错单点在调用方（store 直接抛出）；失败不置旗标 → 下次渲染自动补账。
          logger?.warn?.(`[soul] soul snapshot capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return cached.text;
    }
    if (cached) {
      logger?.info?.(`[soul] 人格变更 ${cacheKey}: ${cached.version} → ${soulVer}`);
    }
    // R5 #22（2026-10-16）：desc 判定单一源提升至函数作用域——价值锚行与感受段清单共用同一
    // desc 门（句边界截取 + isDanglingTail 悬空清洗），两处过滤口径不再漂移。
    // R5-F8（2026-10-16 用户授权拍板）：共享句界集（全角/半角/换行）单一源——价值锚行、
    // 感受段首要子句、person/品格行 desc 截取统一从 SENTENCE_CUTS 取界，消句界不对称
    //（第二路审查 F8）；截取结果内联换行折叠单行（desc 多行渲染缺陷一并消除）。
    const SENTENCE_CUTS = ["。", "！", "？", "；", "!", "?", "\n"] as const;
    const lastSentenceCut = (s: string): number => {
      let cut = -1;
      for (const c of SENTENCE_CUTS) {
        const i = s.lastIndexOf(c);
        if (i > cut) cut = i;
      }
      return cut;
    };
    const singleLine = (s: string): string => s.replace(/\s*\n+\s*/g, " ").trim();
    const anchorDescOf = (v: { attrs_json?: string }): string => {
      const s = typeof attrsOf(v.attrs_json)?.description === "string" ? String(attrsOf(v.attrs_json)?.description).trim() : "";
      if (!s) return "";
      const cut = lastSentenceCut(s);
      if (cut >= 0) return singleLine(s.slice(0, cut + 1));
      return isDanglingTail(s) ? "" : s;
    };
    // ── 身份段：此刻的我（公式术语「此刻的你」见 :4；2026-10-19 用户拍板方案 A 自白体） ──
    // #40 审查 I-1 口径（①设计内确认，2026-10-16）：本外门同时门住 capabilities 段——
    // 零 soul 数据（无 slot 无价值锚）的 agent 不渲染能力段。依据：能力自述属六属性
    // 自我叙事、随身份段承载（宁缺毋滥+信封语义=身份块表达记忆衍生的自我）；空自我
    // 时的工具能力由协议层 tools 清单功能性覆盖，不产出「半灵魂」块。若未来需要
    // 空数据 agent 也出能力段，须先定空数据 soulVersion 语义（#33 冻结范围）再改独立外门。
    // T3/T6-F1（2026-10-17）：承诺块属身份内容——仅承诺在场（slots/values 全空）也渲染
    // <soul-identity>（未来性=「此刻的你」的一部分）；gate off 时 promiseRows=[] 门不变。
    if (slots.length > 0 || activeAll.length > 0 || promiseRows.length > 0) {
      const lines: string[] = [];
      // DS-SOUL-MEMORY-002 P1 四段渲染（gated）：非 dual 路径保持 `- [slot] content`
      // 原样且不做截断——逐位现状；dual 路径 self/identity 行分别带（我是谁）/（我心中的他）
      // 前缀（multi-line content 仅首行带前缀），F17 预算超限 slice 截断（宁缺毋滥，无省略号）。
      const dual = opts?.selfIdentityEnabled === true;
      const budgetFor = (slot: string): number | undefined =>
        !dual ? undefined
          : slot === "self_identity" ? (opts?.budgetSelfChars ?? 600)
          : slot === "identity" ? (opts?.budgetIdentityChars ?? 900)
          : undefined;
      const labelFor = (slot: string): string =>
        slot === "self_identity" ? "我是谁" : slot === "identity" ? "我心中的他" : "";
      // 渲染顺序=spec §2.7 不变量（:143-144：self 段在 identity 段前），不依赖 readCore 返回序；
      // stable 分区保持其余 slot 原相对序。legacy 路径（dual=false）保持原序逐位现状。
      const ordered = dual
        ? [...slots].sort((a, b) => {
            const rank = (slot: string) => (slot === "self_identity" ? 0 : slot === "identity" ? 1 : 2);
            return rank(a.slot) - rank(b.slot);
          })
        : slots;
      for (const s of ordered) {
        // #31 探针 P24（R5，2026-10-16）：空白槽内容不渲染空 `[slot] ` 行
        //（宁缺毋滥，与锚 desc 空跳过同哲学；生产 slots 无空内容=逐位现状不变）。
        if (typeof s.content !== "string" || s.content.trim() === "") continue;
        // #24-C1（2026-10-16 用户授权拍板）：dual 路径 strict_rule 是不变量（invariant）而非性格
        // 倾向，改置 soul-identity 段尾独立红线段渲染（见下方块组装），不再混入身份叙事；
        // legacy 路径（dual=false）逐位不动。
        if (dual && s.slot === "strict_rule") continue;
        // #52 D3（双通道 slots 去重）：perTurnSlots=false 时 dual 路径跳过身份两行
        //（（我是谁）[self_identity] /（我心中的他）[identity]——会话头时机已承载，逐轮省略）；
        // strict_rule 不在此行内（上面已 continue，仍走红线段），其余段照常。
        // legacy 路径不适用（身份行是 legacy 唯一身份载体，见 SoulRenderOptions 注）。
        if (dual && opts?.perTurnSlots === false && (s.slot === "self_identity" || s.slot === "identity")) continue;
        const budget = budgetFor(s.slot);
        const content = budget !== undefined ? truncateByLines(s.content, budget) : s.content;
        const label = labelFor(s.slot);
        lines.push(dual && label ? `（${label}）- [${s.slot}] ${content}` : `- [${s.slot}] ${s.content}`);
      }
      // #24-C1（2026-10-16 用户授权拍板，r5-24 定案）：红线独立段「## 不可逾越（红线）」置
      // soul-identity 段尾（禁令动词框架+保留团队话语关键词，段名进 #33 词表）；原文直出禁改写
      //（无预算/无截断/无转写——不变量语义）；无 strict_rule 整段省略（宁缺毋滥）。
      // #52 P1（2026-10-18）：渲染改单一源 renderStrictRuleSectionLines——多行 strict_rule 槽
      // 逐条独立成行、逐行带 [strict_rule] tag、剥行首自身弹头（旧 `- [strict_rule] ${content}`
      // 只给首行打 tag 且不剥内容自带 `- ` 弹头 = 生产畸形 `- [strict_rule] - …` + 续行全裸）。
      // 去重轮（2026-10-18）：红线近重复行独立后处理 pass（不动单一源文件契约；kept 行体逐字
      // 保留=选择而非改写；≤1 行零成本直通）。dropped 落 debug 日志。
      // 灵魂注入质量轮（2026-10-19 上移+治理）：红线行计算上移至锚块之前——跨段抑制
      //（suppressAnchorOverlap）需要先有红线行再筛锚行（依存方向：锚筛红线 → 红线先行）；
      // maxLines=渲染面治理（红线墙挤占身份段注入预算，生产实拍 10 条 strict_rule 占段 60%；
      // 去重后截断保前 N=单一源输出序；0=不设限=逐位现状）。真实性边界不变：去重/截断均为
      // 整行选择（drop），kept 行体逐字不动，不发生改写。
      const redlineLinesRaw = dual ? renderStrictRuleSectionLines(ordered) : [];
      let redlineLines = redlineLinesRaw;
      if (opts?.strictRuleDedup?.enabled === true && redlineLinesRaw.length > 1) {
        const dd = dedupeNearDuplicateLines(redlineLinesRaw, { jaccardThreshold: opts.strictRuleDedup.jaccardThreshold });
        if (dd.dropped.length > 0) {
          logger?.debug?.(
            `[soul-dedupe] strict_rules dropped ${dd.dropped.length}/${redlineLinesRaw.length}: ${dd.dropped.map((d) => d.reason).join("; ")}`,
          );
          redlineLines = dd.kept;
        }
      }
      const redlineMaxLines = opts?.strictRuleDedup?.maxLines ?? 0;
      if (redlineMaxLines > 0 && redlineLines.length > redlineMaxLines) {
        const droppedByCap = redlineLines.slice(redlineMaxLines);
        logger?.debug?.(
          `[soul-dedupe] strict_rules capped ${droppedByCap.length}/${redlineLines.length} by maxLines=${redlineMaxLines}`,
        );
        redlineLines = redlineLines.slice(0, redlineMaxLines);
      }
      if (active.length > 0) {
        // 立项②：渲染顺序按 value_id 稳定排序（weight 只用于取舍/排序上限，不决定注入序）
        const activeStable = [...active].sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)));
        // 灵魂注入质量轮（2026-10-04 何晨令「禁止无意义、不明确的内容和仅有关键词无说明的锚点注入」）：
        // desc 空/空白锚整条跳过（宁缺毋滥禁裸关键词形态）；desc 尾悬空半句清洗（句边界，
        // v18-d 起判定单一源 = isDanglingTail，与 pending-adopt-merge.sanitizeDescription 复用）；
        // 全部锚无 desc → 行省略不造裸串。（anchorDescOf 已提升至段作用域：R5 #22 感受段同门复用）
        const renderAnchor = (v: (typeof activeStable)[number], desc: string): string => {
          const descSeg = desc !== "" ? `：${escapeXmlTags(desc)}` : "";
          // 呈现层翻修（2026-10-16 用户拍板「有问题的现在直接优化」）：权重内隐——weight 消费于
          // 排序/门控/首要选取（立项② value_id 稳定排序不变），渲染面不再暴露伪精度数字；
          // V6-1b「weight 显示」决策退役，weightLabel 函数随之移除。
          const dir = valenceDir(v.valence);
          return `${escapeXmlTags(v.label)}${dir ? `(${dir})` : ""}${descSeg}`;
        };
        // #42（票 D / D9）：decoratedPairs 保留 desc 供打分（渲染字节与既有 decorated 逐位一致）。
        // 去重轮：label 随行携带（soul-dedupe 判定源）；anchorDedup 在 scorer 消费前执行
        //（被去重锚不进 embed 成本与 top-K 选择面），dropped 落 debug 日志可核对。
        let decoratedPairs = activeStable
          .map((v) => {
            const desc = anchorDescOf(v);
            // R2 episode 门（2026-10-04 何晨令「不属于灵魂而是记忆内容的部分不得放入灵魂注入」）：
            // desc 为具体事件叙述（commit hash/编号/HTTP/日期等硬特征）→ 非灵魂级说明 → 整条跳过
            //（宁缺毋滥；存量混事件锚随此门即刻退出注入，语义级混入交生成端 prompt 负面清单）。
            if (desc === "" || looksLikeEpisode(desc)) return null;
            // T4：valueId 随行携带——shadow 定标行按 valueId 归集（渲染字节零变化）。
            return { row: renderAnchor(v, desc), desc, valueId: String(v.value_id ?? v.label), label: String(v.label ?? "") };
          })
          .filter((x): x is { row: string; desc: string; valueId: string; label: string } => x !== null);
        // #42：scorer 配置提前解析（anchorDedup embedding 通道复用同一 embedder——单一依赖面）。
        const scorerCfg = opts?.anchorSelect?.scorer;
        if (opts?.anchorDedup?.enabled === true && decoratedPairs.length > 1) {
          const dd = dedupeAnchorPairs(decoratedPairs);
          if (dd.dropped.length > 0) {
            logger?.debug?.(
              `[soul-dedupe] anchors dropped ${dd.dropped.length}/${decoratedPairs.length}: ${dd.dropped.map((d) => `${d.label}→${d.keptLabel}`).join(",")}`,
            );
            decoratedPairs = dd.pairs;
          }
        }
        // 灵魂注入质量轮（2026-10-19 第二通道）：desc 向量 cosine 语义近重复去重——label 双向
        // 包含抓不住的同义改写对。阈值诚实标定注记（生产 22 锚 × doubao-embedding-vision
        // 2048dims 实测 231 对：top=0.669、p50=0.406，真重复对与非重复对无分离阈值）——
        // 绝对 cosine 门跨嵌入模型不可移植：0.85 在本生产模型下为诚实 no-op（通道机制保留，
        // 供更高分离度的嵌入模型/未来换模型时启用）；本模型下的实际去扎堆由 MMR 多样性选择
        // 承担（soul-anchor-scorer.ts selectAnchorRowsMmr）。embedder 缺席/阈值 0=通道静默跳过
        //（仅 label 通道，逐位现状）；失败非致命（内部降级全保留 + 外层兜底 warn）。
        const adEmbThreshold = opts?.anchorDedup?.embeddingThreshold ?? 0;
        if (
          opts?.anchorDedup?.enabled === true &&
          adEmbThreshold > 0 &&
          decoratedPairs.length > 1 &&
          typeof scorerCfg?.embedder === "function"
        ) {
          try {
            const dd2 = await dedupeAnchorPairsEmbedding(decoratedPairs, scorerCfg.embedder, adEmbThreshold, { logger });
            if (dd2.dropped.length > 0) {
              logger?.debug?.(
                `[soul-dedupe] anchors embedding-dropped ${dd2.dropped.length}/${decoratedPairs.length}: ${dd2.dropped.map((d) => `${d.label}→${d.keptLabel}(${d.reason})`).join(",")}`,
              );
              decoratedPairs = dd2.pairs;
            }
          } catch (err) {
            logger?.warn?.(
              `[soul-dedupe] embedding dedup failed (non-fatal, label-channel result kept): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const decorated = decoratedPairs.map((p) => p.row);
        // #42：打分选择接线——转正（scorer.enabled=true 且 embedder/可用查询向量在位）=
        // threshold 硬门 + top-K；#52 D3 选项C：仅 rows.length > maxRows（发生裁剪）时按
        // cosine desc 决定保留集与顺序，rows ≤ maxRows 不重排（value_id 声明序，不抖动）；
        // 缺省关/shadow/向量缺席 → decorated 原样（逐位现状）。（scorerCfg 已上提至 anchorDedup 块前解析）
        // #42 审查加固（F1 懒解析 + I-4 可用门）：查询向量解析=显式 queryEmbedding ?? provider() ?? null，
        // 每次 buildSoulPrefix 调用至多解析一次（转正选择与 shadow 报告共用）；退化向量（零范数/空）
        // 视同缺席。缺省配置（scorer 未配置/关）零解析零 embed（F1 零成本保证）。
        let queryVecResolved = false;
        let queryVec: Float32Array | null = null;
        const resolveQueryVec = async (): Promise<Float32Array | null> => {
          if (!scorerCfg || queryVecResolved) return queryVec;
          queryVecResolved = true;
          const raw =
            scorerCfg.queryEmbedding ??
            (typeof scorerCfg.queryEmbeddingProvider === "function" ? await scorerCfg.queryEmbeddingProvider() : null);
          queryVec = isUsableQueryVec(raw) ? raw : null;
          return queryVec;
        };
        let selected = decorated;
        if (scorerCfg?.enabled === true) {
          const qv = await resolveQueryVec();
          if (typeof scorerCfg.embedder === "function" && qv) {
            try {
              // 灵魂注入质量轮（2026-10-19）：MMR 多样性选择——scoreAnchorRows 产出锚向量随行
              // 携带（零额外 embed），λ<1 时对发生裁剪的池贪心去扎堆（selectAnchorRowsMmr 内部
              // 触发门与 #52 D3 选项C 同款：仅 pool>maxRows 才重排，未裁剪=声明序原样）；
              // mmrLambda 缺席/≥1 → selectAnchorRows 纯 top-K 逐位现状。
              const mmrLambda = scorerCfg.mmrLambda ?? 0.7;
              const scoredRows = await scoreAnchorRows(decoratedPairs, qv, scorerCfg.embedder, {
                maxRows: opts?.anchorSelect?.maxRows,
                embedBudgetMs: scorerCfg.embedBudgetMs,
              });
              selected = (
                mmrLambda > 0 && mmrLambda < 1
                  ? selectAnchorRowsMmr(scoredRows, {
                      maxRows: opts?.anchorSelect?.maxRows,
                      threshold: scorerCfg.threshold ?? 0,
                      lambda: mmrLambda,
                    })
                  : selectAnchorRows(scoredRows, {
                      maxRows: opts?.anchorSelect?.maxRows,
                      threshold: scorerCfg.threshold ?? 0,
                    })
              ).map((s) => s.row);
            } catch (err) {
              // #42 审查加固（F2/I-2）：embed 失败非致命——整体回退未选择现状（部分打分=选择语义
              // 不一致，宁缺毋滥），沿 mood compute non-fatal 先例；soul 前缀不再整轮丢失。
              // 质量轮（2026-10-19）：降级渲染**不写** soulPrefixCache/soul 快照（见函数尾
              // soulRenderDegraded 写入门）——降级锚序（声明序）若被缓存，embed 预算后到齐的完整
              // MMR 渲染会被同键旧降级串遮蔽，直到缓存驱逐。in-flight embed 已在后台落缓存。
              logger?.warn?.(
                `[soul-anchor-scorer] score failed (non-fatal, fallback to unselected): ${err instanceof Error ? err.message : String(err)}`,
              );
              soulRenderDegraded = true;
              selected = decorated;
            }
          } else if (!soulScorerMisconfigWarned) {
            // #42 审查加固（F3）：显式 enabled=true 但向量面缺席=静默错——进程内告警一次（重启复位），
            // 指向运行时注入侧排查（#41 C1 同款「门在、实参缺」的运维可观测补偿）。
            soulScorerMisconfigWarned = true;
            logger?.warn?.(
              `[soul-anchor-scorer] enabled=true but embedder=${typeof scorerCfg.embedder === "function"} queryVec=${qv !== null} → selection inactive（检查 auto-recall 运行时注入：embedder/queryEmbeddingProvider）`,
            );
          }
        }
        // #10 T4：整锚预算——超预算从尾丢整锚（value_id 稳定序头部保留），0=无预算逐位现状
        //（let：跨段抑制可能收窄集合，shadow 报告/shadowSink/渲染共用抑制后集合——观测面=实际注入面）
        let budgeted = applyAnchorBudget(selected, opts?.budgetAnchorChars ?? 0);
        // 灵魂注入质量轮（2026-10-19）：红线/价值锚跨段抑制——价值锚 desc 与红线行语义重复时
        // 锚行让位（红线=硬约束承载面优先级更高；软取向原则不重复占注入字数；生产实拍红线值锚
        // desc 与 strict_rule R-A 条目同文重复）。行级 drop、kept 逐字保留（真实性边界同上）；
        // 判定=jaccard 通道+可选 embedding cosine 通道（soul-dedupe.suppressAnchorOverlapRows）；
        // 失败非致命（内部降级 + 外层兜底 warn），回退=不抑制=逐位现状。
        if (opts?.strictRuleDedup?.suppressAnchorOverlap === true && redlineLines.length > 0 && budgeted.length > 0) {
          try {
            const sup = await suppressAnchorOverlapRows(budgeted, redlineLines, {
              jaccardThreshold: opts.strictRuleDedup.jaccardThreshold,
              embedder: typeof scorerCfg?.embedder === "function" ? scorerCfg.embedder : null,
              embeddingThreshold: adEmbThreshold,
            });
            if (sup.dropped.length > 0) {
              logger?.debug?.(
                `[soul-dedupe] anchor-vs-redline suppressed ${sup.dropped.length}/${budgeted.length}: ${sup.dropped.map((d) => `${d.line.slice(0, 24)}…(${d.reason})`).join(",")}`,
              );
              budgeted = sup.kept;
            }
          } catch (err) {
            logger?.warn?.(
              `[soul-dedupe] suppressAnchorOverlap failed (non-fatal, no suppression): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // #29（R5）：情境锚选择 shadow 门——行数超 maxRows 只报告不裁剪（检索式裁剪对抗
        // 锚稳定性=身份漂移入口），渲染逐位现状；转正（#42 enabled=true）后选择已生效、不触发报告。
        // #42：shadow 报告随向量可用性升级为逐锚分形态 `锚N(0.xxx)`（查询向量在位才升级；
        // 无向量=回退 #29 原形态清单快照——宁缺毋滥不造分）。
        const shadowMaxRows: number | undefined = opts?.anchorSelect?.maxRows;
        const emitPlainReport = () => {
          // M-4：enabled=true 向量缺席的回退报告措辞 ≠ 缺省同形（可观测性：运维可区分两种状态）。
          const tail =
            scorerCfg?.enabled === true ? "（仅报告不裁剪，转正已开但向量缺席回退）" : "（仅报告不裁剪，转正待 D9/ADR）";
          logger?.warn?.(
            `[soul-anchor-select] shadow: rows=${budgeted.length} > maxRows=${shadowMaxRows}${tail}: ` +
              budgeted.map((r) => r.slice(0, Math.max(r.indexOf("("), 1))).join(","),
          );
        };
        if (shadowMaxRows != null && budgeted.length > shadowMaxRows) {
          // #42：shadow 报告（enabled=false/未配置）随向量可用性升级逐锚分形态；转正后选择已生效
          // 不触发报告。M-1 锁：预算截断（budgeted<decoratedPairs）→ 升级失效回退原形态。
          // F1/I-4：报告向量走同一懒解析（可用门），缺席=原形态不造分。
          const shadowScorer = scorerCfg?.enabled === true ? undefined : scorerCfg;
          if (shadowScorer && typeof shadowScorer.embedder === "function" && budgeted.length === decoratedPairs.length) {
            const shadowQv = await resolveQueryVec();
            if (shadowQv) {
              try {
                const scored = await scoreAnchorRows(decoratedPairs, shadowQv, shadowScorer.embedder);
                // M-1 复核：scoreOf 按 row 字符串键——重复 row ⇔ 同 label/dir/weight/desc ⇒ 同向量
                // ⇒ 同 score，覆写无害；报告分不错配。
                const scoreOf = new Map(scored.map((s) => [s.row, s.score]));
                logger?.warn?.(
                  `[soul-anchor-select] shadow: rows=${budgeted.length} > maxRows=${shadowMaxRows}（仅报告不裁剪）: ` +
                    budgeted
                      .map((r) => {
                        const sc = scoreOf.get(r);
                        const head = r.slice(0, Math.max(r.indexOf("("), 1));
                        return sc !== undefined ? `${head}(${sc.toFixed(3)})` : head;
                      })
                      .join(","),
                );
              } catch (err) {
                // F2/I-2：shadow 打分失败非致命——原形态报告（只报告不裁剪语义不变）。
                logger?.warn?.(
                  `[soul-anchor-scorer] shadow score failed (non-fatal, fallback report form): ${err instanceof Error ? err.message : String(err)}`,
                );
                emitPlainReport();
              }
            } else {
              emitPlainReport();
            }
          } else {
            emitPlainReport();
          }
        }
        // #52 P3（2026-10-18）：shadowSink 采集与报告门解耦——旧实现 sink 落在 rows>maxRows
        // 报告门内，生产实证 rows=11 ≤ maxRows=12 → 永不触发=D9 定标数据黑洞（且转正态
        // enabled=true 时 shadowScorer=undefined 同样零采集）。新语义：sink enabled 且打分
        // 前提成立（embedder 在位+预算截断未破坏行匹配+查询向量可用）即落一行定标 jsonl，
        // rows≤maxRows 的分布同样是定标材料。渲染字节零影响（旁路）；真实性红线不变：
        // 无向量/打分失败零采集=不造数。wouldSelect=假设转正（threshold 硬门+top-K）会
        // 保留的 valueId 集（maxRows 未配置=不裁剪 → 全集）；actuallySelected=本轮实际渲染
        // 集合（shadow 不重排=value_id 声明序，#52 D3 选项C）；agree=两者去重集合相等
        //（转正态=活跃选择与重算镜像的一致性金丝雀）。二次 scoreAnchorRows 命中
        // anchorVectorCache（键=desc 原文）=零重复 embed。
        if (opts?.anchorSelect?.shadowSink?.enabled === true && scorerCfg && typeof scorerCfg.embedder === "function" && budgeted.length === decoratedPairs.length) {
          try {
            const sinkQv = await resolveQueryVec();
            if (sinkQv) {
              const rowToValueId = new Map(decoratedPairs.map((p) => [p.row, p.valueId]));
              const sinkScored = await scoreAnchorRows(decoratedPairs, sinkQv, scorerCfg.embedder);
              const wouldSelect =
                shadowMaxRows != null
                  ? selectAnchorRows(
                      await scoreAnchorRows(decoratedPairs, sinkQv, scorerCfg.embedder, { maxRows: shadowMaxRows }),
                      { maxRows: shadowMaxRows, threshold: scorerCfg?.threshold ?? 0 },
                    ).map((s) => rowToValueId.get(s.row) ?? "")
                  : budgeted.map((r) => rowToValueId.get(r) ?? r);
              const actuallySelected = budgeted.map((r) => rowToValueId.get(r) ?? r);
              const keyOf = (xs: string[]) => [...new Set(xs)].sort().join("\u0000");
              appendAnchorShadowRow(
                opts.anchorSelect.shadowSink.file ?? "data/logs/soul-anchor-shadow.jsonl",
                {
                  ts: new Date().toISOString(),
                  agentId: tenant.agentId,
                  threshold: scorerCfg?.threshold ?? 0,
                  rowsScored: sinkScored.map((s) => ({ valueId: rowToValueId.get(s.row) ?? "", score: Math.round(s.score * 10000) / 10000 })),
                  wouldSelect,
                  actuallySelected,
                  agree: keyOf(wouldSelect) === keyOf(actuallySelected),
                },
                logger,
              );
            }
          } catch (err) {
            // #52 P3：采集失败非致命——渲染零影响（fail-safe 降级，与 sink 模块同级语义）。
            logger?.warn?.(
              `[soul-anchor-scorer] shadow sink failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (budgeted.length > 0) {
          // 呈现层翻修（2026-10-16 用户拍板）：单行「；」串（9 锚 ~470 字符无换行）→「价值锚：」
          // 标题行 + 逐锚列表行（- 前缀）；内容稳定即 KV 稳定，换行无损。
          lines.push("价值锚：", ...budgeted.map((r) => `- ${r}`));
        }
      }
      // P2：重要的人 行——数据驱动（无 person 行 → 省略）；role 缺失只省 role 段
      if (personRows.length > 0) {
        const personDecorated = personRows.map((v) => {
            // V6-1e：attrsOf 统一解析（含 description）——「label(role·方向)：描述」与价值锚行同构；
            // 2026-10-04 勘误（UR-15，台账 61 号）：生产 active person 锚 2/2 有 description（cdcfe5c 终判），
            // 描述段=活跃路径；空 desc 行走下方三元回退为无描述形态（G-ANCHORDESC-WRITE 策略另行拍板）。
            const a = attrsOf(v.attrs_json) ?? {};
            const d = personDir(v.valence);
            const role = a.role ? `${escapeXmlTags(a.role)}·` : "";
            // R2b person 行 desc 门（2026-10-04 自主拍板·渲染一致性补全）：trim→句边界清洗（半句悬空
            // 置空，与价值锚行/品格行同构）→episode 门（混具体事件叙述置空）。与价值锚行「整锚跳过」
            // 不同构：person 锚=灵魂五段成员本身，门只把 desc 段降级为无描述形态（V6-1e 设计内合法
            // 形态），不抹人；gated G-ANCHORDESC-WRITE 存量回填另行拍板不在此处。
            const rawDesc = typeof a.description === "string" ? a.description.trim() : "";
            // R5-F8：句界集单一源（SENTENCE_CUTS，见 anchorDescOf 处）+ 单行折叠
            const cutP = lastSentenceCut(rawDesc);
            const pDescClean = rawDesc === ""
              ? ""
              : cutP >= 0 ? singleLine(rawDesc.slice(0, cutP + 1)) : isDanglingTail(rawDesc) ? "" : rawDesc;
            const pDesc = pDescClean !== "" && !looksLikeEpisode(pDescClean) ? `：${escapeXmlTags(pDescClean)}` : "";
            return `${escapeXmlTags(v.label)}(${role}${d})${pDesc}`;
          });
        // #10 T4：整人预算——超预算从尾丢整人（value_id 稳定序头部保留），0=无预算逐位现状
        const personBudgeted = applyAnchorBudget(personDecorated, opts?.budgetPersonChars ?? 0);
        if (personBudgeted.length > 0) {
          // 呈现层翻修同构（2026-10-16）：逐人列表行（- 前缀），role·方向 语义保留（无 weight 段）。
          lines.push("重要的人：", ...personBudgeted.map((r) => `- ${r}`));
        }
      }
      // S-CHAR-2（M2/P5）：品格行——「我是谁」小节尾部（数据驱动，无品格锚 → 省略宁缺毋滥）；
      // 渲染门=opts.characterTensionEnabled（M2 缺省关断）。A/B 对象：开启时价值锚行不再含品格锚。
      const characterRows = opts?.characterTensionEnabled === true
        ? activeAll
            .filter((v) => v.node_type === "character")
            // 立项②同款：渲染按 value_id 稳定排序（KV cache 前缀连续性）
            .sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)))
        : [];
      if (characterRows.length > 0) {
        // 灵魂注入质量轮（2026-10-04）：品格行与价值锚行同构 desc 门——空/半句不入行。
        const charDecorated = characterRows
          .map((v) => {
            const s = typeof attrsOf(v.attrs_json)?.description === "string" ? String(attrsOf(v.attrs_json)?.description).trim() : "";
            if (!s) return null;
            // R5-F8：句界集单一源（SENTENCE_CUTS，见 anchorDescOf 处）+ 单行折叠
            const cut = lastSentenceCut(s);
            const desc = cut >= 0 ? singleLine(s.slice(0, cut + 1)) : (/[，、,]$/.test(s) ? "" : s);
            // R2 episode 门：品格锚 desc 同构禁混具体事件叙述（与价值锚行同门）。
            if (desc === "" || looksLikeEpisode(desc)) return null;
            const dir = valenceDir(v.valence);
            return `${escapeXmlTags(v.label)}${dir ? `(${dir})` : ""}：${escapeXmlTags(desc)}`;
          })
          .filter((x): x is string => x !== null);
        // #10 T4：整锚预算——同价值锚行（0=无预算逐位现状）
        const charBudgeted = applyAnchorBudget(charDecorated, opts?.budgetCharacterChars ?? 0);
        if (charBudgeted.length > 0) {
          // 呈现层翻修同构（2026-10-16）：逐品格列表行（- 前缀）+ 权重内隐（与价值锚行同批）。
          lines.push("我的品格：", ...charBudgeted.map((r) => `- ${r}`));
        }
      }
      // T3（方案 Task 3，2026-10-17）：承诺块——「我的承诺：」+ 逐条列表行（- 前缀），
      // 未来性属性（#35）注入面：open 承诺=对用户立着的义务，属「此刻的你」自我陈述。
      // 渲染门=opts.promisesEnabled（config-first 缺省关=逐位现状）；宁缺毋滥：零 open/
      // 滤后空 → 整行省略不出占位；content 逐字直出（真实性=不改写不截断，创建门 ≤120 字
      // 已约束长度；escapeXmlTags=程序化组装与写入路径同级消毒，语义逐字不变）；行数上限
      // SOUL_PROMISE_RENDER_MAX（最新在前，createdAt desc）。
      if (opts?.promisesEnabled === true && promiseRows.length > 0) {
        const openPromises = [...promiseRows]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, SOUL_PROMISE_RENDER_MAX);
        if (openPromises.length > 0) {
          lines.push("我的承诺：", ...openPromises.map((p) => `- ${escapeXmlTags(p.content)}`));
        }
      }
      // 红线段计算已上移至 slots 循环后（灵魂注入质量轮 2026-10-19：跨段抑制依存方向
      // 「锚行筛红线」→ 红线行先行；maxLines/suppressAnchorOverlap 治理同处——见 slots
      // 循环后红线块与上方「价值锚」锚块内注释）。soulVersion 语义不变（slots 数据未变），
      // 布局随进程重启缓存自然刷新（soulPrefixCache 为进程内存态）。
      // #32（R5）：能力自述段「## 我能做什么」——只读派生（数据=调用方传入的运行时实况，
      // 本层零落库零派生逻辑）；逐行 1:1 渲染（一致性合同：渲染行=传入清单，顺序保持），
      // 行数策展（3-5 行）由调用方负责；缺省 undefined=不渲染=逐位现状。
      const capLines = (opts?.capabilities ?? [])
        .filter((c) => typeof c === "string" && c.trim() !== "")
        .map((c) => `- ${c}`);
      if (lines.length > 0 || redlineLines.length > 0 || capLines.length > 0) {
        const sections: string[] = [];
        if (lines.length > 0) sections.push(`## 此刻的我\n${lines.join("\n")}`);
        if (redlineLines.length > 0) sections.push(`## 不可逾越（红线）\n${redlineLines.join("\n")}`);
        if (capLines.length > 0) sections.push(`## 我能做什么\n${capLines.join("\n")}`);
        parts.push(`<soul-identity>\n${sections.join("\n")}\n</soul-identity>`);
      }
    }

    // ── 感受段：当下的状态（D6 诚实命名，ADR 0003——内容=价值取向 disposition+情绪基线+state，
    // 非第一人称体验；真实性边界=不伪造当下体验）──
    // F-EV12-5（A-5③，spec §2.7「soul-feeling 保持仅主题锚」）：character 锚不入感受段
    //（价值锚行保留 = §7「与主题锚共享注入预算」）；node_type 缺省 theme 旧库兼容。
    // 立项②：感受段与价值锚行同序（value_id 稳定）——pos/neg 清单不再随 weight 漂移
    const directional = [...active]
      .sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)))
      .filter((v) => (v.node_type ?? "theme") === "theme" && (v.valence === 1 || v.valence === -1));
    // S-FEEL-1（M1）：mood 行独立于方向锚（无 ±1 锚时 soul-feeling 块仍可只含基调行，宁缺毋滥不造空段）；
    // moodTier 缺省=门控逐位现状。
    // #34：state 也独可撑块（零锚+无 mood 时 state-only 块仍渲染——当下性是独立信号源）
    if (directional.length > 0 || opts?.moodTier || opts?.state) {
      // 呈现层翻修（2026-10-17 用户 m00227 终审）：驱动/审慎清单行（posLine/negLine）与
      // 首要内联子句（topDetail/feelLine 机制）整体删除——纯去重：identity 价值锚行逐锚
      // 方向标注（趋近/审慎，applyAnchorBudget 消费点保留）已完整承载方向语义。
      // #52 P2（2026-10-18）：dirTop 回退删除（topValue 缺省 → 权重最高方向锚的旧回退）——
      // 生产实证回退产出「眼下最想推进的是用户拍板」（程序性锚名作宾语=语义荒谬）；
      // 新语义：topValue 仅状态机显式写入才渲染，缺省只写状态行（宁缺毋滥）。感受段现仅
      // 承载近期基调（moodTier）与当下状态（state）两行；state 叙事形态见 soul-state.ts
      //（数值留代码层，prompt 只写自然语言自述）。
      const feel: string[] = [];
      // S-FEEL-1（M1）：近期基调行——soul-feeling 块尾新行（档位文案，不出连续值防伪精度；
      // opts.moodTier 缺省=不 push=逐位现状）。文案不含「我感到」字样（§1.5 主语越界防线）。
      // 灵魂注入质量轮（2026-10-19）：去实现细节括号——「（近 N 条经历的情感聚合）」是管线
      // 元数据（样本量/聚合方式），泄露进 prompt 属实现细节外溢（渲染面调研定案：聚合标签
      // 只留存储/统计层，注入面只写自述语义；样本量观测走 soul-state.ts 聚合侧日志）。
      if (opts?.moodTier) {
        const tierLabel = opts.moodTier.tier === "positive" ? "偏积极" : opts.moodTier.tier === "strained" ? "偏承压" : "平稳";
        feel.push(`近期基调：${tierLabel}。`);
      }
      // #34（S13/R5）：当下状态行——soul-feeling 尾块（依赖 #37 soul.tail 接口语义；
      // 会话级不落库，状态机数据源归 #28）。无 state=逐位现状（不 push）。
      if (opts?.state) {
        const stateLine = renderStateLine(opts.state);
        if (stateLine) feel.push(stateLine);
      }
      if (feel.length > 0) parts.push(`<soul-feeling>\n## 当下的状态\n${feel.join("\n")}\n</soul-feeling>`);
    }
  } catch (err) {
    logger?.warn?.(`[soul] assemble failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
  // 质量轮（2026-10-19）写入门：降级渲染（scorer 回退声明序）跳过前缀缓存与快照落账——
  // 降级串入缓存会遮蔽预算后到齐的完整 MMR 渲染（同键旧串复活直到驱逐）；入快照账本则
  // 产生一次性的「人格变更」假阳性行。in-flight embed 已在后台落缓存，下一请求即完整渲染。
  if (soulVer && !soulRenderDegraded) {
    if (soulPrefixCache.size >= SOUL_CACHE_MAX) {
      const oldest = soulPrefixCache.keys().next().value;
      if (oldest !== undefined) soulPrefixCache.delete(oldest);
    }
    const entry: { version: string; text: string; snapshotted?: boolean } = { version: soulVer, text: result };
    // #30（S9/R5，2026-10-16）：soul 快照旁路落账——渲染尾单咽喉 append（at-least-once 语义：
    // 锚变更→指纹变化→下次渲染必经此处）。R5-F2：contentHash=渲染字节哈希（非 sv），
    // last-hash 去重=内容不变零落行防膨胀；同 sv 布局变体各自成行。
    // R5-F5：store 不吞错（直接抛出），吞错单点在此——失败 warn+不置旗标 → 下次渲染自动补账；
    // 空渲染不落行（宁缺毋滥）；写成功（或确认库中已有）→ entry.snapshotted=true，缓存命中零额外查询。
    if (result !== "" && opts?.snapshotsEnabled !== false) {
      try {
        const contentHash = fnv1a32Hex(result);
        const lastHash = await Promise.resolve(store.readLastSoulSnapshotHash?.(tenant));
        if (lastHash !== contentHash && store.writeSoulSnapshot) {
          await Promise.resolve(store.writeSoulSnapshot(tenant, {
            ts: new Date().toISOString(),
            contentHash,
            payloadJson: result,
            trigger: "render",
          }));
        }
        entry.snapshotted = true;
      } catch (err) {
        logger?.warn?.(`[soul] soul snapshot capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    soulPrefixCache.set(cacheKey, entry);
  }
  return result;
}