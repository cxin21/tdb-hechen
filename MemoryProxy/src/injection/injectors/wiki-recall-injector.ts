// MemoryProxy/src/injection/injectors/wiki-recall-injector.ts
import type { AgentContext, ContextBlock, HookPriority, InjectionHook } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { AssetCapabilityFlags } from "../types.js";
import type { WikiRecallConfig } from "../../types.js";
import type { CoreKnowledgeClient, KnowledgeItem } from "../../knowledge/core-client.js";
import type { WikiRetrieveClient, WikiSearchHit } from "../../knowledge/wiki-retrieve-client.js";
import {
  applyRecallBudget,
  normalizeScores,
  renderWikiRecallBlock,
  renderWikiRecallBlockJit,
  type WikiRecallRenderEntry,
} from "../../knowledge/wiki-recall-utils.js";
// I-4（Task19+20 fix1）：逐轮诊断日志走分级 logger 而非 console.debug。
// Node 里 console.debug === console.log（纯别名），原写法"降 debug"实为必然进
// stdout 的假降噪。report/log.ts 的 emit() 按 LOG_LEVEL_PRIORITY 过滤（默认
// minLevel=info 时 debug 直接丢弃；backend 未启用时静默），才是真分级降噪。
import { log } from "../../report/log.js";

const TAG = "[wiki-recall-injector]";

/** WikiRecallInjector 缺省参数（config.wikiRecall 缺失/整段时兜底）。导出 getter 仅供同形验证断言。
 * 权威单一源=本文件（#48 CI 加固：原定义在 injection/index.ts barrel，Linux CI 下测试端
 * 顶层 const binding 经模块图求值顺序解析为 undefined——改为函数声明（提升语义，TDZ 免疫），
 * 内部 const 不导出；index re-export 保兼容）。 */
const DEFAULT_WIKI_RECALL_CONFIG: WikiRecallConfig = {
  enabled: true,
  perWikiLimit: 8,
  globalTopK: 5,
  minScore: 0.02,
  hop: 0,
  decay: 0.5,
  maxTotalChars: 0,
  minInjectNormScore: 0.6,
  // W5（T18-B）：新增结构页权重 other/log/index/schema = 0.3（结构页同时在
  // wiki-recall-injector 排尾不竞争 top-K，权重为兜底乘法项）；既有 3 项保留。
  typeWeights: { entity: 0.6, concept: 0.9, overview: 0.6, other: 0.3, log: 0.3, index: 0.3, schema: 0.3 },
  // C3（2026-09-10）domainRouter 默认退役：09-09 隔离实验（锚点 evals/recall-golden/
  // runs/2026-09-10T04-07-38.json，B on vs E off 同语料快照）实证——部署工作点
  // （tw09/rel0.6/absGate1.5）router 对 posRecall 单变量贡献=0（0.66 vs 0.66）、
  // negInjected 恒 +2（13 vs 11），且 W4 boost→归一→注入门耦合未解。
  // **显式退役标记**：keywords 空表 → injector 跨库软定域恒 no-op（能力形状保留，
  // 重开只需填 keywords）。重开 router 前必须：(a) 先归档 router-on 实验；
  // (b) 先解耦 W4（boost 作用于归一前分数、直接受注入门放大）——独立任务。
  domainRouter: { boost: 1.5, keywords: {} },
};

export function defaultWikiRecallConfig(): WikiRecallConfig {
  return DEFAULT_WIKI_RECALL_CONFIG;
}

/** 码点长度（与 applyRecallBudget 的预算口径一致；surrogate-safe）。 */
function countCodePoints(s: string): number {
  return Array.from(s).length;
}

export interface WikiRecallInjectorConfig {
  enabled: boolean;
  /** 每个绑定 wiki 各自检索多少条（默认 8）。 */
  perWikiLimit: number;
  /** 合并后全局保留多少条（默认 5）。 */
  globalTopK: number;
  /** 召回相关度下限（默认 0.02）。 */
  minScore: number;
  /** 图展开 hop 数；默认 0 = 不启用（V3 决策）。 */
  hop: number;
  /** hop decay（默认 0.5，reserved；仅 hop>0 时随请求下发）。 */
  decay: number;
  /** 注入块总字符上限（code points）；<=0 表示不限制。 */
  maxTotalChars: number;
  /**
   * 注入门槛：归一化后 normScore（0~1，最高=1.0）低于此值的候选不注入。
   * 默认 0.6 —— 丢弃相对"这批最高分"明显偏低的泛条目，避免低相关片段污染上下文。
   * <=0 或缺失表示不启用门槛（注入全部 topK）。
   */
  minInjectNormScore?: number;
  /**
   * 按 type 降权系数（可选）。合并/归一前先把每条的原始 score 乘上对应系数，
   * 用于压低"命名/索引"型节点（entity/concept）被相对归一顶成高分的噪音。
   * 例：{ entity: 0.6, concept: 0.8 } —— source/other 不配则按 1（不降）。
   */
  typeWeights?: Record<string, number>;
  /**
   * 绝对相关门控阈值（可选，默认关闭）。对带 `absScore`（引擎未归一化向量相关分）
   * 的候选生效：低于此值的不注入（宁缺毋滥）。<=0 / 缺失 = 不启用。
   * 刻度需按实际 embedding 校准后再设，避免误伤真召回。
   */
  minInjectAbsScore?: number;
  /**
   * P0-3（issue #2 FTS 穿透，可选默认关闭）：纯 FTS 命中（absScore===undefined——向量
   * 不可用/NON_EMBED_TYPES 结构页）的最低 score 门槛，低于此值不注入（宁缺毋滥）。
   * 刻度：hop=0 时 server score = weightedFuse 加权融合分（[0,1]；仅 FTS 命中 ≈
   * 0.4×字面路 min-max，双通道命中不再走此门而走 minInjectAbsScore）；hop>0 时 score
   * 为 BM25 原始尺度（未归一）与本门刻度不可比——hop!==0 时代码强制关闭本门。
   * <=0 / 缺失 = 不启用（逐位现状）。
   */
  minInjectFtsScore?: number;
  /**
   * P0-3（issue #2 短 query 跳过，可选默认关闭）：短 query / 寒暄 query 跳过整轮
   * wiki 召回——查询本身就是噪音源（bigram 前缀 OR 对 2-4 字 query 几乎全库命中）。
   * minChars：清洗后 query 码点长度 < minChars 跳过（0=不启用）；patterns：子串命中
   * 任一即跳过（寒暄词表，如 ["你好","在吗","谢谢","收到"]）。两者独立生效。
   */
  skipQuery?: { minChars?: number; patterns?: string[] };
  /**
   * 跨库软定域（可选，默认不启用）。`keywords` 按 wiki 名给领域词；query 命中某 wiki
   * 的领域词越多，该 wiki 命中在跨库并池前乘的 boost 越大（`1 + hits/3 * boost`）。
   * 仅 boost、不删除；无任何 wiki 命中 = 全部权重 1 = 保持现状（防 under-recall）。
   * 例：{ boost: 1.5, keywords: { "Coding-WiKi": ["结算","金额","冲回","合同"], "Standards-WiKi": ["规范","并发","异常"] } }
   */
  domainRouter?: { boost?: number; keywords: Record<string, string[]> };
  /**
   * Task 6（P1 recall-quality）：wiki JIT 瘦身注入 tri-state（可选，缺省 undefined）。
   * - `false`：强制现行全量注入（逃生门——不支持 tool 取文的接入面用）；
   * - `true`：强制 JIT 短块（运维覆盖 / live 验收通道）；
   * - 缺省（undefined）：跟随 meta 能力位 `wiki_jit.enabled`
   *   （ctx.metadata.custom.assetCapabilities.wiki_jit；缺省 false = shadow-first 默认关）。
   */
  jit?: boolean;
}

export interface WikiRecallInjectorDeps {
  /** Core knowledge client —— 真实装配（Task 5）用它走 listAgentKnowledgeIds + listKnowledgeByIds 解析绑定。 */
  knowledgeClient: CoreKnowledgeClient;
  /** 按各绑定 wiki 各自 service_url 构造检索客户端（跨端点 wiki 安全）。
   *  第二个参数 serviceId 是当前请求的租户标识（会话 spaceId），用于检索请求的
   *  x-tdai-service-id 头；缺省时由装配端回退 config.knowledge.serviceId。 */
  retrieveClientFactory: (serviceUrl: string, serviceId?: string) => WikiRetrieveClient;
  /** 解析当前请求的 TDAI identity；test 注入 mock，真实装配绑定 getTdaiIdentity。 */
  identityResolver: (ctx: AgentContext) => ReturnType<typeof getTdaiIdentity> | undefined;
  /** 解析当前 agent 绑定的 wiki 资源列表。默认真实实现走 knowledgeClient；test 注入 fake。 */
  listBoundWiki: (
    ctx: AgentContext,
    teamId: string,
    agentId: string | undefined,
    userKey: string | undefined,
    spaceId: string | undefined,
  ) => Promise<KnowledgeItem[]>;
}

/**
 * user.before 动态团队 wiki 召回注入器（test-bed，方向 B）。
 *
 * 流程：enabled 门 → 身份解析 → 提取干净 user_query → 解析绑定 wiki →
 * 按各 wiki 端点并行检索 → 合并、归一化评分 → 渲染 <tdai_recalled_wiki> →
 * 预算截断后注入到最新用户消息之前。
 *
 * 顺序沿用服务端 RRF 返回序，不二次 rescore；normalizeScores 仅用于展示。
 */
export class WikiRecallInjector implements InjectionHook {
  id = "wiki-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 1; // right after memory recall
  description = "Auto-recall team wiki snippets per turn (test-bed, direction B)";
  cacheStrategy = "none" as const;

  constructor(
    private config: WikiRecallInjectorConfig,
    private deps: WikiRecallInjectorDeps,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    if (!this.config.enabled) return [];
    const identity = this.deps.identityResolver(ctx);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    // 用「干净的真实 user_query」作检索词而非整条原始消息 blob（去掉 harness 噪声）。
    const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
    if (!query) return [];

    // P0-3（issue #2）：短 query / 寒暄 query 整轮跳过 wiki 召回（缺省 off=逐位现状，
    // config-first）。bigram 前缀 OR 检索对超短 query 天然全库命中，寒暄 query 检索
    // 只产出噪音——直接跳过比事后过滤更省（不发 per-wiki 检索请求）。
    // 对抗审查修复（#3 major）：CJK 词改「去标点/空白后全等」匹配——子串命中会把
    // "好的，那我们继续评审网关重构方案" 这类真实任务 query 误杀整轮召回；只有
    // 消息本身就是寒暄（"好的"/"谢谢，辛苦了"→去标点后≠词表项，不跳）才跳过。
    // 纯 ASCII 词（"OK"）保持词边界正则（"OKR" 不误杀）。跳过时升 log.info（生产
    // 可见），带 team/agent/query 片段留遥测痕迹。
    const skipCfg = this.config.skipQuery;
    if (skipCfg) {
      const qLen = [...query].length;
      const minChars = skipCfg.minChars ?? 0;
      const normalizedQuery = query.replace(/[\s\p{P}\p{S}]+/gu, "");
      const hitPattern = (skipCfg.patterns ?? []).find((p) => {
        if (!p) return false;
        if (/^[\x20-\x7E]+$/.test(p)) {
          return new RegExp(`(?:^|[^A-Za-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9])`, "i").test(query);
        }
        return normalizedQuery === p;
      });
      if ((minChars > 0 && qLen < minChars) || hitPattern) {
        log.info(
          `${TAG} skip-query: chars=${qLen} minChars=${minChars} pattern=${hitPattern ?? "-"} team=${identity.teamId} agent=${identity.agentId} ` +
          `query="${query.slice(0, 60)}${query.length > 60 ? "…" : ""}" → skip wiki recall`,
        );
        return [];
      }
    }

    const session = (ctx.metadata.custom as any)?.session ?? {};
    const userKey = session.user_key as string | undefined;
    const spaceId = session.space_id as string | undefined;

    // 【诊断】当前请求的检索语境：租户 + 干净 query + 配置参数。
    // W10/I-4：逐轮诊断日志走分级 logger（report/log.ts，LOG_LEVEL_PRIORITY 过滤
    // —— 默认 minLevel=info 时不输出；LOG_LEVEL=debug + console backend 时可见）。
    // 不用 console.debug：Node 里它是 console.log 的别名，必然进 stdout（假降噪）。
    // query 截断——不把用户消息全文写进日志（隐私 + 噪音双考虑）。
    log.debug(`${TAG} recall-start team=${identity.teamId} agent=${identity.agentId} spaceId=${spaceId ?? "-"} query="${query.slice(0, 100)}${query.length > 100 ? "…" : ""}" perWikiLimit=${this.config.perWikiLimit} globalTopK=${this.config.globalTopK} minScore=${this.config.minScore} hop=${this.config.hop}`);

    const bound = await this.deps.listBoundWiki(ctx, identity.teamId, identity.agentId, userKey, spaceId);
    const allBound = bound.map((r) => `${r.type}:${r.knowledge_id}(${r.name})`);
    const wikis = bound.filter((r) => r.type === "wiki");
    // 【诊断】绑定解析结果：全部绑定 vs 过滤后(wiki 类型) —— 若 Coding-WiKi 不在
    // bound 里，这里就能看出槽位缺失（召回范围不足的根因可能在这）。
    log.debug(`${TAG} bound-all=[${allBound.join(", ")}] bound-wikis=[${wikis.map((w) => w.knowledge_id).join(", ")}]`);
    if (wikis.length === 0) {
      log.debug(`${TAG} no bound wiki, skip recall`);
      return [];
    }

    // 对所有绑定 wiki 并行检索 —— 各按自己的 service_url 端点。
    // 每个 wiki 独立 try/catch：检索失败（含 retrieveClientFactory 抛错，
    // 如 service_url 为空/畸形导致 baseUrl.replace 抛出）只影响该 wiki，降级为
    // []，绝不让整个 execute() 拒绝。规范 §3.4/§5.2 的单点故障隔离。
    const groups = await Promise.all(
      wikis.map(async (w) => {
        try {
          // 检索与 listBoundWiki 用同一租户（会话 spaceId）——不一致会导致
          // config.knowledge.serviceId 与数据实际租户错位 → 404 wiki not found。
          const hits = await this.deps.retrieveClientFactory(w.service_url, spaceId).search({
            wikiId: w.knowledge_id,
            query,
            limit: this.config.perWikiLimit,
            minScore: this.config.minScore,
            ...(this.config.hop > 0 ? { hop: this.config.hop, decay: this.config.decay } : {}),
          });
          // 【诊断】每个 wiki 实际返回的命中条数 + 每条的标题/原始分数，用于判断
          // 该 wiki 召回多少、是否出现"该命中却 0 条/分数极低被压"的情况。
          const top = hits.slice(0, 3).map((h) => `${h.title}(${h.score.toFixed(2)})`).join(" | ");
          log.debug(`${TAG} wiki-hits wiki=${w.knowledge_id}(${w.name}) count=${hits.length} top=["${top}"]`);
          return hits.map((h) => ({ ...h, wikiName: w.name }));
        } catch (err) {
          // 错误路径保留 warn 必打（W10/I-4 纪律：降噪只压逐轮诊断 debug，
          // 不压真实故障可见性；warn 不经分级过滤的 debug 门，始终可见）。
          console.warn(`${TAG} per-wiki recall failed wiki=${w.name} serviceUrl=${w.service_url} wikiId=${w.knowledge_id} reason=${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }),
    );

    // 跨库软定域：query 命中某 wiki 领域词 → 该 wiki 命中 boost（仅加权、不删除；
    //   无命中=权重1=现状）。缓解"业务正例被异库稀释 + 元 query 跨库低分噪音靠前"。
    const routerCfg = this.config.domainRouter;
    let groupsToMerge = groups;
    if (routerCfg && Object.keys(routerCfg.keywords ?? {}).length > 0) {
      const boost = routerCfg.boost ?? 1.5;
      const hitsPerWiki = new Map<string, number>();
      for (const [wName, kws] of Object.entries(routerCfg.keywords ?? {})) {
        const n = kws.filter((k) => k && query.includes(k)).length;
        if (n > 0) hitsPerWiki.set(wName, Math.min(n, 3));
      }
      if (hitsPerWiki.size > 0) {
        groupsToMerge = groups.map((hits, i) => {
          const w = wikis[i];
          const hitsN = hitsPerWiki.get(w.name) ?? 0;
          const weight = hitsN > 0 ? 1 + (hitsN / 3) * boost : 1;
          return hits.map((h) => ({ ...h, score: h.score * weight }));
        });
      }
    }

    // Type-aware downweight: entity/concept 是"命名/索引"节点，标题精确命中易被
    // 相对归一顶成 1.0（"按钮"/"复合语义模型"等）。在跨库并池+归一前按 type 乘
    // 系数降权，使其不再与正文 source/concept 平起平坐。保守、可配置、无校准风险。
    const typeWeights = this.config.typeWeights ?? {};
    const allRaw: Array<WikiSearchHit & { wikiName: string }> = groupsToMerge.flat();
    const all = Object.keys(typeWeights).length > 0
      ? allRaw.map((h) => ({ ...h, score: h.score * (typeWeights[String(h.type)] ?? 1) }))
      : allRaw;
    // 【诊断】合并水池大小 —— 若远小于 绑定wiki数×perWikiLimit，说明有 wiki 召回不足/失败。
    log.debug(`${TAG} merged-pool=${all.length} (boundWikis=${wikis.length}, perWikiLimit=${this.config.perWikiLimit})`);
    if (all.length === 0) return [];

    // W5（T18-B）结构页降权排尾：log/index/schema/purpose/overview 等结构页在
    // MemoryKnowledge 侧永不向量化（NON_EMBED_TYPES）→ 永无 absScore → absGate 结构性
    // 无效，却以高原始分挤进注入位 rank 1-4。这里把它们从竞争池单独拎出附到列表尾部
    //（保持其存在——历史信息仍有价值——但不再与正文竞争 top-K），首个附 [structural] 标注。
    // 结构集合与 MemoryKnowledge/src/engines/wiki/manager.ts 的 NON_EMBED_TYPES 对齐
    //（MemoryProxy 侧无法 import MemoryKnowledge，复制常量并锚定来源；manager.ts:195）。
    const STRUCTURAL_WIKI_TYPES = new Set(["index", "schema", "purpose", "overview", "log"]);
    const isStructural = (h: WikiSearchHit): boolean => STRUCTURAL_WIKI_TYPES.has(String(h.type));
    const structural = all.filter(isStructural);
    const bodyPool = all.filter((h) => !isStructural(h));

    // T15-C 降级可见：本轮命中全部无 absScore（引擎未回传向量相关分）→ 视为 FTS-only
    // 降级，注入块头部标注 [degraded: fts-only]。简化裁决（brief）：knowledge 侧探针
    // 成本高，降级判据直接用"合并后全部命中无 absScore"，在 injector 合并后判断一次。
    const degradedFtsOnly = all.every((h) => h.absScore === undefined);

    // ③ 绝对相关门控（宁缺毋滥，补相对门控挡不住"每池最高=1.0"的缺陷）：
    //    仅对带 absScore（引擎回传的未归一化向量相关分）的候选生效 —— 低于阈值的
    //    丢弃；不带 absScore（纯 FTS 命中，向量不可用）不在此判，仍由相对门控兜底。
    //    absScore 刻度需按实际 embedding 校准，故默认不启用（<=0 = 关）。
    //    （W5：结构页已先拎出，不进本门控池。）
    const absGate = this.config.minInjectAbsScore ?? 0;
    // P0-3（issue #2 FTS 穿透）：minInjectFtsScore（缺省 0=关=逐位现状，config-first）——
    // 纯 FTS 命中（absScore===undefined：向量不可用 / NON_EMBED_TYPES 结构页）不再
    // 无门槛穿透 absGate。门槛刻度 = hop=0 weightedFuse 融合分（[0,1]；仅 FTS 命中
    // ≈ 0.4×字面路 min-max）；双通道命中走 absGate（1/distance 刻度），两门独立生效。
    // Spec 审查修正（c2）：hop>0 时 server score 为 BM25 原始尺度（未归一），与本门
    // [0,1] 刻度不可比——代码显式设防（hop!==0 时强制关），不再仅靠配置注释约束。
    const ftsGate = (this.config.hop ?? 0) === 0 ? (this.config.minInjectFtsScore ?? 0) : 0;
    const gateActive = absGate > 0 || ftsGate > 0;
    const pool = gateActive
      ? bodyPool.filter(
          (h) =>
            (absGate <= 0 || h.absScore === undefined || h.absScore >= absGate) &&
            (ftsGate <= 0 || h.absScore !== undefined || h.score >= ftsGate),
        )
      : bodyPool;

    // NOTE: order = server order (RRF) per wiki；normalize 仅用于评分。
    // ① 必须先按 normScore 降序排序再截 topK —— normalizeScores 不改变数组顺序，
    //    若直接 slice(0, topK) 会按"绑定顺序拼接后的原顺序"截取，导致排在数组前面的
    //    wiki（如 Standards）挤掉后面 wiki（如 Coding）的高分命中（实测缺陷）。
    //    见 2026-09-07 排障：采购合同主键精准页 norm=1.0 曾被 Standards 0.5- 挤掉。
    // ② 再按 minInjectNormScore 门槛过滤 —— 归一化后明显偏低（相对这批最高分）的
    //    泛条目不注入，避免低相关片段污染上下文（用户需求：得分过低就不召回）。
    const threshold = this.config.minInjectNormScore ?? 0;
    const normalized: Array<WikiSearchHit & { wikiName: string; normScore: number }> = threshold > 0
      ? normalizeScores(pool)
          .sort((a, b) => b.normScore - a.normScore)
          .slice(0, this.config.globalTopK)
          .filter((n) => n.normScore >= threshold)
      : normalizeScores(pool)
          .sort((a, b) => b.normScore - a.normScore)
          .slice(0, this.config.globalTopK);
    if (normalized.length === 0 && structural.length === 0) {
      log.debug(`${TAG} 全部候选人低于 minInjectNormScore=${threshold}，跳过注入`);
      return [];
    }
    // 【诊断】最终注入 topK 的明细（来源 wiki + 归一化分 + 标题）—— 判断"谁该进
    // 前五"是否被挤出（如 Coding 精准命中却不在 topK 里）。
    // W10 修复：原为 `${TAG} final-topK=' + ${...}` —— `' + ` 是模板字符串里的
    // 字面量（拼接 bug），输出形如 `final-topK=' + [{...}]`。改为纯插值并降 debug。
    log.debug(`${TAG} final-topK=${JSON.stringify(normalized.map((n) => ({ wiki: n.wikiName, normScore: n.normScore, title: n.title })))}`);
    // W5：结构页附尾（保持存在但不竞争 top-K）；归一化分仅在结构页子集内展示，
    // 首个附 [structural] 标注（renderWikiRecallBlock 格式锁定，标注走 title 后缀）。
    // S3（T18 审计 M-1）：附尾数量封顶 MAX_STRUCTURAL_TAIL —— 结构页不竞争 top-K
    // 也不进 absGate 池，一轮捞回大量结构页（log/index/schema 全中）时附尾会无界
    // 挤占注入预算；超出 cap 直接丢弃并打 debug 日志（可诊断，不静默）。
    const structuralNorm = structural.length > 0 ? normalizeScores(structural) : [];
    const MAX_STRUCTURAL_TAIL = 3;
    const droppedStructural = Math.max(0, structuralNorm.length - MAX_STRUCTURAL_TAIL);
    if (droppedStructural > 0) {
      log.debug(`${TAG} structural-tail cap: drop=${droppedStructural} kept=${MAX_STRUCTURAL_TAIL} (MAX_STRUCTURAL_TAIL=${MAX_STRUCTURAL_TAIL})`);
    }
    const structuralEntries: WikiRecallRenderEntry[] = structuralNorm.slice(0, MAX_STRUCTURAL_TAIL).map((n, i) => ({
      wikiName: n.wikiName,
      type: n.type,
      title: i === 0 ? `${n.title} [structural]` : n.title,
      score: n.score,
      normScore: n.normScore,
      snippet: n.snippet,
      path: n.path,
      hop: n.hop,
    }));
    const entries: WikiRecallRenderEntry[] = [
      ...normalized.map((n) => ({
        wikiName: n.wikiName,
        type: n.type,
        title: n.title,
        score: n.score,
        normScore: n.normScore,
        snippet: n.snippet,
        path: n.path,
        hop: n.hop,
      })),
      ...structuralEntries,
    ];
    if (entries.length === 0) return [];
    // Task 6（P1 recall-quality）：JIT 瘦身注入 —— 双渲染对比 + tri-state 路由。
    // 缺省（config.jit 未设）跟随 meta 能力位 wiki_jit.enabled（shadow-first 默认
    // 关 = legacy）；jit:false 是逃生门（不支持 tool 取文的接入面）；jit:true 为
    // 运维/live 验收强制通道。两种渲染都算（纯字符串拼接，成本可忽略），journal
    // 记录实际 chars 与「若走另一形态会注入 chars」对比（P50/P95 数据源）。
    const jitMode = this.resolveJitMode(ctx);
    const legacyRendered = renderWikiRecallBlock(entries);
    const jitRendered = renderWikiRecallBlockJit(entries);
    const rawRendered = jitMode ? jitRendered ?? legacyRendered : legacyRendered;
    if (!rawRendered) return [];
    const jitWouldBe = jitMode ? legacyRendered : jitRendered ?? "";
    // T15-C：降级标注插在块头标签之后（render 格式锁定，不动 utils）。
    const annotated = degradedFtsOnly
      ? rawRendered.replace(
          "<tdai_recalled_wiki>",
          // I-1 复核修补：两义措辞 —— absScore 全缺失可能是向量层降级，也可能是
          // 相关度门滤除（absGate/相对门控），禁止假警报式单因断言。
          "<tdai_recalled_wiki>\n[degraded: fts-only] 本轮向量召回无贡献（向量层降级或相关度门滤除），命中项均无向量相关分（absScore 缺失），召回质量可能不完整。",
        )
      : rawRendered;
    const budgeted = applyRecallBudget(annotated.split("\n"), this.config.maxTotalChars, 0);
    const rendered = budgeted.join("\n");

    // Task 6 journal（wiki 注入无既有 journal 钩子——recall journal 属 MemoryCore，
    // 挂点=injector 日志通道 log.info 单行；chars 按码点计，与预算口径一致）。
    log.info(
      `${TAG} journal mode=${jitMode ? "jit" : "legacy"} chars=${countCodePoints(rendered)}`
      + ` jitWouldBeChars=${countCodePoints(jitWouldBe ?? "")} entries=${entries.length}`
      + ` wikis=${wikis.map((w) => w.name).join(",")}`
      + ` team=${identity?.teamId ?? "-"} agent=${identity?.agentId ?? "-"}`
      + ` degradedFtsOnly=${degradedFtsOnly}`,
    );

    return [
      {
        type: "text",
        content: rendered,
        metadata: {
          source: this.id,
          count: entries.length, // W5：含附尾结构页（真实注入条数）
          wikis: wikis.map((w) => w.name),
          degradedFtsOnly,
          // Task 6：JIT 放量观测字段（mode / 实际 chars / 若另一形态的 chars）
          jitMode: jitMode ? "jit" : "legacy",
          chars: countCodePoints(rendered),
          jitWouldBeChars: countCodePoints(jitWouldBe ?? ""),
        },
      },
    ];
  }

  /**
   * Task 6：JIT tri-state 路由。config.jit 显式值优先（false=强制 legacy 逃生门，
   * true=强制 JIT）；缺省跟随 meta 能力位 `wiki_jit.enabled`
   * （ctx.metadata.custom.assetCapabilities.wiki_jit；flags 缺省/缺席 = false，
   * shadow-first 默认关）。
   */
  private resolveJitMode(ctx: AgentContext): boolean {
    if (this.config.jit === false) return false;
    if (this.config.jit === true) return true;
    const caps = (ctx.metadata?.custom as { assetCapabilities?: AssetCapabilityFlags } | undefined)
      ?.assetCapabilities;
    return caps?.wiki_jit === true;
  }
}

/**
 * 默认绑定 wiki 资源解析（Task 5 装配用）。
 *
 * - agent 有 userKey：走 per-agent 绑定视图 —— `listAgentKnowledgeIds` 取该
 *   agent 被固定绑定的 knowledge_id 集合（可能为 []），再 `listKnowledgeByIds`
 *   联查明细，过滤 type==="wiki"。
 * - 无 agent / 无 userKey：降级为 team 全量 `listKnowledge`，过滤 type==="wiki"。
 *
 * spaceId 透传为 per-call serviceId（kernel 按 tenant 路由）。
 * 纯函数，便于 test 注入 fake CoreKnowledgeClient。
 */
export async function resolveBoundWikiResources(
  teamId: string,
  agentId: string | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
  client: CoreKnowledgeClient,
): Promise<KnowledgeItem[]> {
  const serviceId = spaceId || undefined;
  if (agentId && userKey) {
    const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId });
    // 【诊断】per-agent 绑定视图的原始 knowledge_id 列表 —— 若这里不含 Coding-WiKi，
    // 则召回范围先天缺 Coding（召回"只有 Standards"的根因之一）。
    log.debug(`${TAG} resolveBound per-agent team=${teamId} agent=${agentId} spaceId=${spaceId ?? "-"} knowledgeIds=[${ids.join(", ")}]`);
    if (ids.length === 0) return [];
    const all = await client.listKnowledgeByIds(teamId, ids, { serviceId });
    const out = all.filter((r) => r.type === "wiki");
    log.debug(`${TAG} resolveBound per-agent 明细=${all.map((r) => `${r.type}:${r.knowledge_id}`).join(", ")} → wiki=${out.map((r) => r.knowledge_id).join(", ")}`);
    return out;
  }
  const all = await client.listKnowledge(teamId, { serviceId });
  const out = all.filter((r) => r.type === "wiki");
  log.debug(`${TAG} resolveBound team-fallback team=${teamId} spaceId=${spaceId ?? "-"} 明细=${all.map((r) => `${r.type}:${r.knowledge_id}`).join(", ")} → wiki=${out.map((r) => r.knowledge_id).join(", ")}`);
  return out;
}

/**
 * WikiRecallInjector 注册门控。
 *
 * 与知识工具注入器的门控对齐（injectors 含 "knowledge" 且 knowledge 启用 +
 * serviceToken 非空），额外叠加一个 `wikiRecall.enabled !== false` 开关
 * （wikiRecall 未配置时视为启用）。
 */
export function shouldRegisterWikiRecallInjector(config: {
  injection?: { injectors?: string[] };
  knowledge?: { enabled?: boolean; serviceToken?: string };
  wikiRecall?: { enabled?: boolean };
}): boolean {
  return (config.injection?.injectors?.includes("knowledge") ?? false)
    && config.knowledge?.enabled === true
    && !!config.knowledge?.serviceToken
    && config.wikiRecall?.enabled !== false;
}