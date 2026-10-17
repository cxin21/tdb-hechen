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
import { isUsableQueryVec, scoreAnchorRows, selectAnchorRows, type AnchorEmbedder } from "./soul-anchor-scorer.js";
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
  /** #29（R5）：情境锚选择触发门——价值锚行数 > maxRows 才启用；shadow 先行：只报告不裁剪、
   *  渲染逐位现状。#42（票 D / D9）：相似度打分器接线——enabled 缺省 false（shadow 报告随
   *  向量可用性升级逐锚分形态）；enabled=true=转正（threshold 硬门+top-K 重排渲染行）。
   *  embedder/queryEmbedding 为运行时注入（config 不携带向量）；任一缺席→回退现状形态
   *  （宁缺毋滥不造分）。 */
  anchorSelect?: {
    maxRows?: number;
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
    };
  };
  /** #32（R5）：能力自述清单（运行时实况，只读派生置身份段尾「## 我能做什么」）。
   *  零落库；一致性合同=渲染行=传入清单（顺序保持）；策展 ≤5 行由调用方负责；
   *  缺省 undefined=不渲染=逐位现状。cacheKey 含清单指纹（字节影响面）。 */
  capabilities?: string[];
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

    soulVer = computeSoulVersion(slots, activeAll, opts?.moodTier?.tier);
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
        ? `,scorer=1,${opts.anchorSelect.scorer.threshold ?? 0},${
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
      `r=${opts?.selfIdentityEnabled ? 1 : 0},${opts?.budgetSelfChars ?? 0},${opts?.budgetIdentityChars ?? 0},${opts?.maxRelationLines ?? 0},${opts?.budgetAnchorChars ?? 0},${opts?.budgetPersonChars ?? 0},${opts?.budgetCharacterChars ?? 0},${opts?.characterTensionEnabled ? 1 : 0},${opts?.anchorSelect?.maxRows ?? 0},${opts?.capabilities ? fnv1a32Hex(opts.capabilities.join("\n")) : ""}${scorerSig}`,
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
    // ── 身份段：此刻的你 ──
    // #40 审查 I-1 口径（①设计内确认，2026-10-16）：本外门同时门住 capabilities 段——
    // 零 soul 数据（无 slot 无价值锚）的 agent 不渲染能力段。依据：能力自述属六属性
    // 自我叙事、随身份段承载（宁缺毋滥+信封语义=身份块表达记忆衍生的自我）；空自我
    // 时的工具能力由协议层 tools 清单功能性覆盖，不产出「半灵魂」块。若未来需要
    // 空数据 agent 也出能力段，须先定空数据 soulVersion 语义（#33 冻结范围）再改独立外门。
    if (slots.length > 0 || activeAll.length > 0) {
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
        const budget = budgetFor(s.slot);
        const content = budget !== undefined ? truncateByLines(s.content, budget) : s.content;
        const label = labelFor(s.slot);
        lines.push(dual && label ? `（${label}）- [${s.slot}] ${content}` : `- [${s.slot}] ${s.content}`);
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
        const decoratedPairs = activeStable
          .map((v) => {
            const desc = anchorDescOf(v);
            // R2 episode 门（2026-10-04 何晨令「不属于灵魂而是记忆内容的部分不得放入灵魂注入」）：
            // desc 为具体事件叙述（commit hash/编号/HTTP/日期等硬特征）→ 非灵魂级说明 → 整条跳过
            //（宁缺毋滥；存量混事件锚随此门即刻退出注入，语义级混入交生成端 prompt 负面清单）。
            if (desc === "" || looksLikeEpisode(desc)) return null;
            return { row: renderAnchor(v, desc), desc };
          })
          .filter((x): x is { row: string; desc: string } => x !== null);
        const decorated = decoratedPairs.map((p) => p.row);
        // #42：打分选择接线——转正（scorer.enabled=true 且 embedder/可用查询向量在位）=
        // threshold 硬门 + top-K 重排渲染行；缺省关/shadow/向量缺席 → decorated 原样（逐位现状）。
        const scorerCfg = opts?.anchorSelect?.scorer;
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
              selected = selectAnchorRows(await scoreAnchorRows(decoratedPairs, qv, scorerCfg.embedder), {
                maxRows: opts?.anchorSelect?.maxRows,
                threshold: scorerCfg.threshold ?? 0,
              }).map((s) => s.row);
            } catch (err) {
              // #42 审查加固（F2/I-2）：embed 失败非致命——整体回退未选择现状（部分打分=选择语义
              // 不一致，宁缺毋滥），沿 mood compute non-fatal 先例；soul 前缀不再整轮丢失。
              logger?.warn?.(
                `[soul-anchor-scorer] score failed (non-fatal, fallback to unselected): ${err instanceof Error ? err.message : String(err)}`,
              );
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
        const budgeted = applyAnchorBudget(selected, opts?.budgetAnchorChars ?? 0);
        // #29（R5）：情境锚选择 shadow 门——行数超 maxRows 只报告不裁剪（检索式裁剪对抗
        // 锚稳定性=身份漂移入口），渲染逐位现状；转正（#42 enabled=true）后选择已生效、不触发报告。
        // #42：shadow 报告随向量可用性升级为逐锚分形态 `锚N(0.xxx)`（查询向量在位才升级；
        // 无向量=回退 #29 原形态清单快照——宁缺毋滥不造分）。
        if (opts?.anchorSelect?.maxRows != null && budgeted.length > opts.anchorSelect.maxRows) {
          // #42：shadow 报告（enabled=false/未配置）随向量可用性升级逐锚分形态；转正后选择已生效
          // 不触发报告。M-1 锁：预算截断（budgeted<decoratedPairs）→ 升级失效回退原形态。
          // F1/I-4：报告向量走同一懒解析（可用门），缺席=原形态不造分。
          const shadowScorer = scorerCfg?.enabled === true ? undefined : scorerCfg;
          const shadowMaxRows: number = opts.anchorSelect.maxRows; // 窄化后捕获（闭包内引用，TS18048 规避）
          const emitPlainReport = () => {
            // M-4：enabled=true 向量缺席的回退报告措辞 ≠ 缺省同形（可观测性：运维可区分两种状态）。
            const tail =
              scorerCfg?.enabled === true ? "（仅报告不裁剪，转正已开但向量缺席回退）" : "（仅报告不裁剪，转正待 D9/ADR）";
            logger?.warn?.(
              `[soul-anchor-select] shadow: rows=${budgeted.length} > maxRows=${shadowMaxRows}${tail}: ` +
                budgeted.map((r) => r.slice(0, Math.max(r.indexOf("("), 1))).join(","),
            );
          };
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
      // #24-C1（2026-10-16 用户授权拍板，r5-24 定案）：红线独立段「## 不可逾越（红线）」置
      // soul-identity 段尾（禁令动词框架+保留团队话语关键词，段名进 #33 词表）；原文直出禁改写
      //（无预算/无截断/无转写——不变量语义）；无 strict_rule 整段省略（宁缺毋滥）。
      // 批次声明：本批（#24-C1+F8）为第二次渲染布局跳变；slots 数据未变 → soulVersion 语义不变，
      // 布局随进程重启缓存自然刷新（soulPrefixCache 为进程内存态）。
      const redlineLines = dual
        ? ordered
            .filter((s) => s.slot === "strict_rule" && typeof s.content === "string" && s.content.trim() !== "")
            .map((s) => `- [strict_rule] ${s.content}`)
        : [];
      // #32（R5）：能力自述段「## 我能做什么」——只读派生（数据=调用方传入的运行时实况，
      // 本层零落库零派生逻辑）；逐行 1:1 渲染（一致性合同：渲染行=传入清单，顺序保持），
      // 行数策展（3-5 行）由调用方负责；缺省 undefined=不渲染=逐位现状。
      const capLines = (opts?.capabilities ?? [])
        .filter((c) => typeof c === "string" && c.trim() !== "")
        .map((c) => `- ${c}`);
      if (lines.length > 0 || redlineLines.length > 0 || capLines.length > 0) {
        const sections: string[] = [];
        if (lines.length > 0) sections.push(`## 此刻的你\n${lines.join("\n")}`);
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
      // R5 #22（2026-10-16）：感受段清单与价值锚行同门——desc 空/episode 叙述锚不入清单
      //（消 shadow-first 式悬空裸关键词，anchorDescOf 单一源见上）；滤后仍 value_id 稳定序（立项②）。
      const gated = directional
        .map((v) => {
          const desc = anchorDescOf(v);
          return !desc || looksLikeEpisode(desc) ? null : { v, desc };
        })
        .filter((x): x is { v: (typeof directional)[number]; desc: string } => x !== null);
      // R5 #23（2026-10-16）→ 形态翻修（2026-10-17 用户裁决「首要悬浮行乱」）：首要锚不除名，
      // 以 `label（首要：detail）` 内联后缀呈现在其 value_id 排序位（V6-1d 选取与排序解耦不变；
      // 首句 ≤SOUL_TOP_DESC_MAX_CHARS 语义不变，渲染失败=无句界且超限 → 无内联子句、
      // 该锚降级纯 label 保留清单位，宁缺毋滥不丢成员）。首要子句仅 top weight>0 才附（P51 守卫）；
      // 预算门（#10 T4）只管纯 label 清单项，首要内联子句为详述不占清单预算；
      // 缺省 0=无预算逐位现状（config-first）。布局字节跳变一次声明，soulVersion 不变。
      const topDetail = (r: (typeof gated)[number]): string => {
        const d = r.desc;
        // R5-F8：首句截取与价值锚行同句界集（SENTENCE_CUTS 单一源；此处取首个边界=首句语义，
        // 价值锚行取末边界=完整句集合语义——位置语义各自保留，界集统一）
        let firstCut = -1;
        for (const c of SENTENCE_CUTS) {
          const i = d.indexOf(c);
          if (i >= 0 && (firstCut < 0 || i < firstCut)) firstCut = i;
        }
        const detail = firstCut >= 0
          ? (firstCut + 1 <= SOUL_TOP_DESC_MAX_CHARS ? singleLine(d.slice(0, firstCut + 1)) : "")
          : (d.length <= SOUL_TOP_DESC_MAX_CHARS ? d : "");
        return detail ? escapeXmlTags(detail) : "";
      };
      const feelLine = (header: string, dirRows: typeof gated): string | null => {
        if (dirRows.length === 0) return null;
        const top = [...dirRows].sort((a, b) => (b.v.weight ?? 0) - (a.v.weight ?? 0) || String(a.v.value_id ?? a.v.label).localeCompare(String(b.v.value_id ?? b.v.label)))[0];
        // 逐位现状（R5 自审 P51）：weight>0 门——零权/负权锚不出首要内联子句、纯 label 保留清单位
        const detail = (top.v.weight ?? 0) > 0 ? topDetail(top) : "";
        const list = dirRows
          .filter((r) => r !== top || detail === "")
          .map((r) => escapeXmlTags(r.v.label));
        const budgeted = applyAnchorBudget(list, opts?.budgetAnchorChars ?? 0);
        if (budgeted.length === 0 && !detail) return null;
        // 形态翻修：dirRows 已 value_id 序——首要锚在其排序位附内联后缀，其余按 applyAnchorBudget
        // 前缀保留依次消费（budgeted 是 list 的前缀，按 label 匹配回位安全，被裁剪项整项丢弃）。
        const items: string[] = [];
        let bi = 0;
        for (const r of dirRows) {
          if (r === top && detail) {
            items.push(`${escapeXmlTags(r.v.label ?? "")}（首要：${detail}）`);
          } else if (bi < budgeted.length && budgeted[bi] === escapeXmlTags(r.v.label)) {
            items.push(budgeted[bi]);
            bi++;
          }
        }
        return `${header}${items.join("；")}`;
      };
      const feel: string[] = [];
      const posLine = feelLine("驱动我行动的价值：", gated.filter((r) => r.v.valence === 1));
      const negLine = feelLine("提醒我审慎的价值：", gated.filter((r) => r.v.valence === -1));
      if (posLine) feel.push(posLine);
      if (negLine) feel.push(negLine);
      // S-FEEL-1（M1）：近期基调行——soul-feeling 块尾新行（档位+样本数，不出连续值防伪精度；
      // opts.moodTier 缺省=不 push=逐位现状）。文案不含「我感到」字样（§1.5 主语越界防线）。
      if (opts?.moodTier) {
        const tierLabel = opts.moodTier.tier === "positive" ? "偏积极" : opts.moodTier.tier === "strained" ? "偏承压" : "平稳";
        feel.push(`近期基调：${tierLabel}（近 ${opts.moodTier.sampleCount} 条经历的情感聚合）`);
      }
      // #34（S13/R5）：当下状态行——soul-feeling 尾块（依赖 #37 soul.tail 接口语义；
      // 会话级不落库，状态机数据源归 #28）。topValue 缺省 → directional（gated）权重最高锚
      //（复用已算结构，不发明第二套评估）；无 state=逐位现状（不 push）。
      if (opts?.state) {
        const dirTop = [...gated].sort((a, b) => (b.v.weight ?? 0) - (a.v.weight ?? 0) || String(a.v.value_id ?? a.v.label).localeCompare(String(b.v.value_id ?? b.v.label)))[0];
        const stateLine = renderStateLine(opts.state, dirTop ? escapeXmlTags(dirTop.v.label ?? "") : undefined);
        if (stateLine) feel.push(stateLine);
      }
      if (feel.length > 0) parts.push(`<soul-feeling>\n## 当下的状态\n${feel.join("\n")}\n</soul-feeling>`);
    }
  } catch (err) {
    logger?.warn?.(`[soul] assemble failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
  if (soulVer) {
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