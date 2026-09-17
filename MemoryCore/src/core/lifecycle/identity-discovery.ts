/**
 * identity-discovery —— 身份自发现（SOUL-PIPELINE §2.2，GROW 模式复用）。
 *
 * 灵魂公式"此刻的你"的材料源：LLM 从对话中自发现身份事实（我是谁/我的职责/我的红线），
 * 提案制 + 分级门采纳后写入 core_memory slots。
 *
 * 分级门（用户拍板 2026-09-15）：
 *   - identity（描述类）：多源一致 ≥ minEvidence + observed → 高置信自动采纳
 *   - core_value / strict_rule（红线类）：→ pending 列表（永不自动写入——Panel 人工采纳）
 *
 * 与 anchor-growth 的关系：同构不同对象——锚=价值参照系（core_values），身份=自我认知（core_memory slots）。
 * 共享：采样/冷却/状态机/证据重算模式；差异：slot 白名单/分级门/无 weight。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { selectSampleRows, DISCOVER_SAMPLE_CAP, DISCOVER_TRUNCATE_CHARS } from "../../gateway/core-values-discover.js";

export interface IdentityDiscoveryConfig {
  enabled: boolean;
  minEvidence: number;
  maxPerPass: number;
  intervalHours: number;
}

export const DEFAULT_IDENTITY_DISCOVERY_CONFIG: IdentityDiscoveryConfig = {
  enabled: true,
  minEvidence: 3,
  maxPerPass: 2,
  intervalHours: 24,
};

export interface IdentityDiscoveryResult {
  ran: boolean;
  adopted: number;
  pending: number;
  reason?: "disabled" | "no-llm" | "store-unsupported" | "interval" | "no-new-corpus" | "no-corpus" | "error";
}

export const DISCOVERY_SYSTEM_PROMPT = [
  "你是团队身份提炼顾问。从样本记忆中提炼\"这个 agent/团队是谁\"的身份事实。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（描述类：我是谁/我的职责/我的角色）或 "core_value"（价值观：什么是对的/什么最重要）或 "strict_rule"（红线：绝不做的事/必须遵守的规则）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. 只提炼身份层面的持续事实（我是谁/我信什么/我绝不做什么），不提一次性任务或事件。",
  "2. 【身份判据】会随任务完成/阶段推进而过时的内容（项目进度、阶段状态、当前待办）不是身份——不要写入 identity；",
  "   只提炼跨状态持续的事实（角色、职责、关系、工作纪律）。",
  "3. 已有身份事实如果仍然准确，不要重复提交；如果已经过时/不准确/有重要更新（如角色演化、关系变化），提出修订版——",
  "   content 给出修订后全文，rationale 说明变化原因。修订会以新版本替换旧内容（旧版本留痕）。",
  "3. 宁缺毋滥：证据不足的主题不要提。",
  "4. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"}]，无提议输出 []。",
].join("\n");

// DS-SOUL-MEMORY-002 P1 双视角：user prompt 主语修正（O15：「他是谁」）+ agent 自我层
// （行为可证=提案必须能被样本中的 agent 侧行为/对话文本支撑）。仅 selfIdentity.enabled
// 时使用；legacy prompt 保留原样（逐位现状含 LLM 行为）。
const DISCOVERY_SYSTEM_PROMPT_DUAL = [
  "你是团队身份提炼顾问。从样本记忆中同时提炼两组身份事实：用户身份（他是谁）与 agent 自我（我是谁）。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（用户身份：他是谁/他的职责/他的角色）或 "self_identity"（agent 自我：我反复承担的职责/我做出的承诺/我执行过的红线/我稳定的工作风格）或 "core_value"（价值观：什么是对的/什么最重要）或 "strict_rule"（红线：绝不做的事/必须遵守的规则）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. identity 只提炼用户身份层面的持续事实（他是谁/他信什么/他的纪律）；self_identity 只提炼 agent 自我的持续事实，第一人称产出（我……），且必须能在样本中找到 agent 侧行为或对话文本支撑——纯用户侧事实不要写成 self_identity。",
  "2. 【身份判据】会随任务完成/阶段推进而过时的内容（项目进度、阶段状态、当前待办）不是身份——不要写入；只提炼跨状态持续的事实（角色、职责、关系、工作纪律）。",
  "3. 已有身份事实如果仍然准确，不要重复提交；如果已经过时/不准确/有重要更新（如角色演化、关系变化），提出修订版——content 给出修订后全文，rationale 说明变化原因。修订会以新版本替换旧内容（旧版本留痕）。",
  "4. 宁缺毋滥：证据不足的主题不要提。",
  "5. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"},…]（slot 取 identity/self_identity/core_value/strict_rule），无提议输出 []。",
].join("\n");

// 采样/截断常量与采样器复用 core-values-discover 导出（GROW-IDENT v2，禁第二份）。

/** 身份事实演化状态键（per-agent） */
function stateKey(tenant: CoreTenant | undefined, kind: string): string {
  if (!tenant || (tenant.teamId === "default" && tenant.userId === "default" && tenant.agentId === "default")) {
    return `identity_${kind}`;
  }
  return `identity_${kind}:${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])}`;
}

export async function runIdentityDiscovery(deps: {
  store: IMemoryStore;
  llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> };
  config?: Partial<IdentityDiscoveryConfig>;
  /** DS-SOUL-MEMORY-002 P1：agent 自我层双视角开关（scheduler 传 coreMemory.selfIdentity）。
   *  intervalHours：enabled=true 时覆盖本 worker 冷却（灵魂节奏独立于锚发现节奏，F15 分池；
   *  enabled=false 时绝不读取——逐位现状）。 */
  selfIdentity?: { enabled: boolean; maxPerPass: number; intervalHours?: number };
  logger?: Logger;
  now?: () => Date;
}): Promise<IdentityDiscoveryResult> {
  const cfg: IdentityDiscoveryConfig = { ...DEFAULT_IDENTITY_DISCOVERY_CONFIG, ...(deps.config ?? {}) };
  if (cfg.enabled === false) {
    return { ran: false, adopted: 0, pending: 0, reason: "disabled" };
  }
  // DS-SOUL-MEMORY-002 P1：灵魂自发现节奏独立于锚发现（F15 分池）——enabled=true 时
  // selfIdentity.intervalHours 覆盖冷却；enabled=false 不读（逐位现状）。
  if (deps.selfIdentity?.enabled === true && deps.selfIdentity.intervalHours !== undefined) {
    cfg.intervalHours = deps.selfIdentity.intervalHours;
  }
  const store = deps.store;
  const logger = deps.logger;
  if (!deps.llmRunner) {
    return { ran: false, adopted: 0, pending: 0, reason: "no-llm" };
  }
  if (!store.queryL1Records || !store.upsertCore || !store.readCore) {
    return { ran: false, adopted: 0, pending: 0, reason: "store-unsupported" };
  }

  const now = deps.now ?? (() => new Date());
  try {
    let tenants: CoreTenant[];
    if (typeof store.listL1TenantTriplets === "function") {
      tenants = ((await Promise.resolve(store.listL1TenantTriplets())) ?? []).map((t: unknown) => {
        const r = t as { teamId: string; userId: string; agentId: string };
        return { teamId: r.teamId || "default", userId: r.userId || "default", agentId: r.agentId || "default" };
      });
    } else {
      tenants = [{ teamId: "default", userId: "default", agentId: "default" }];
    }
    if (tenants.length === 0) return { ran: false, adopted: 0, pending: 0, reason: "no-corpus" };

    let ranAny = false;
    let adopted = 0;
    let pending = 0;

    for (const tenant of tenants) {
      try {
        const state = readState(store, tenant);
        const nowMs = now().getTime();
        // 冷却：距上次尝试 ≥ intervalHours
        if (state.lastAttemptAt) {
          const last = Date.parse(state.lastAttemptAt);
          if (Number.isFinite(last) && nowMs - last < cfg.intervalHours * 3600_000) continue;
        }
        // 语料基线：无新增 → 跳过
        const corpusCount = typeof store.countL1 === "function" ? Number(store.countL1(tenant)) || 0 : 0;
        if (corpusCount === 0 || (state.lastCorpusCount !== null && state.lastCorpusCount !== undefined && corpusCount <= state.lastCorpusCount)) continue;

        // GROW-IDENT v2（SOP 2026-09-17 修复）：采样复用 selectSampleRows——此前裸
        // slice(0,50) 建立在无过滤查询 ASC 序上，取的是最旧 50 条：语料超上限后新记忆
        // 永远进不了样本窗（身份自生长对新语料失明，违背自生长原则）。采样器语义 =
        // updated 降序 + 高显著（≥0.8）优先 + cap 截断；证据重算语料仍走全量不变。
        const rows = (store.queryL1Records(tenant) ?? []) as Parameters<typeof selectSampleRows>[0];
        const sample = selectSampleRows(rows, DISCOVER_SAMPLE_CAP)
          .map((r) => String(r.content ?? "").slice(0, DISCOVER_TRUNCATE_CHARS));
        const corpus = rows.map((r) => String(r.content ?? ""));

        // 已有 slots（去重）
        const existing = (store.readCore(tenant) ?? []) as Array<{ slot: string; content: string }>;
        const existingSummaries = existing.map((s) => `[${s.slot}] ${s.content}`);

        const prompt = buildIdentityPrompt(sample, existingSummaries);
        const dual = deps.selfIdentity?.enabled === true;
        const raw = await deps.llmRunner.run({
          prompt,
          systemPrompt: dual ? DISCOVERY_SYSTEM_PROMPT_DUAL : DISCOVERY_SYSTEM_PROMPT,
          taskId: "identity-discovery",
          // GROW-EVO P2.1（用户裁定）对齐（SOP 2026-09-17）：0 = 不限制 maxTokens/超时
          //（llm-runner 语义）——此前 16384 + 缺省 120s 超时是 O8 同款确定性失败病。
          timeoutMs: 0,
          maxTokens: 0,
        });

        const proposals = parseProposals(String(raw ?? ""));
        let adoptedThis = 0;
        let pendingThis = 0;

        // 分级门（用户裁定 A 2026-09-15）：identity 描述类跳过证据重算——综合提炼 content
        // 无法逐字匹配语料（与锚的 label 不同形态）；escapeXmlTags 消毒在写入路径，
        // GROW-MAINT 类重验证为后续纠偏层。core_value/strict_rule（红线类）→ pending 永不自动写入。
        const identityProps: string[] = [];
        const selfProps: string[] = [];
        const maxSelf = dual ? Math.max(1, deps.selfIdentity?.maxPerPass ?? 2) : 0;
        for (const p of proposals) {
          if (p.slot === "identity") {
            // 身份采纳门（硬约束执行）：状态模式剥离——prompt 软判据三轮复发后升级为
            // 代码执行（第一轮枚举式 + 第二轮结构式，stripIdentityStateResidue 单一源）。
            const cleaned = stripIdentityStateResidue(p.content);
            if (!cleaned) {
              // 整条提案全是状态陈述 → 整体拒收（不静默，留痕）
              logger?.info?.(`[identity-discovery] identity proposal rejected (state residue only): ${p.content.slice(0, 60)}`);
            } else if (isIdentityImposition(cleaned)) {
              // P2 SOP（B）：强加身份/人设注入 → 拒收留痕
              logger?.info?.(`[identity-discovery] identity proposal rejected (identity imposition): ${p.content.slice(0, 60)}`);
            } else {
              identityProps.push(cleaned);
            }
          } else if (p.slot === "self_identity" && dual) {
            // P1（DS-SOUL-MEMORY-002）：agent 自我层——同一 strip 门（单一源）；
            // 「行为可证」为双视角 prompt 硬约束，确定性侧只做状态剥离弱校验。
            const cleaned = stripIdentityStateResidue(p.content);
            if (!cleaned) {
              logger?.info?.(`[identity-discovery] self_identity proposal rejected (state residue only): ${p.content.slice(0, 60)}`);
            } else if (isIdentityImposition(cleaned)) {
              // P2 SOP（B）：用户口播人设（"AI 是女儿"类）→ 拒收留痕
              logger?.info?.(`[identity-discovery] self_identity proposal rejected (identity imposition): ${p.content.slice(0, 60)}`);
            } else {
              selfProps.push(cleaned);
            }
          } else if (p.slot === "core_value" || p.slot === "strict_rule") {
            // O13（P2）：pending 落点——红线类提案永不自动写入，持久化到 core_pending 供
            // Panel 人工采纳/拒绝（feature-detect：无方法的 store 保持纯计数现状）。
            const ev = recountEvidence(p.content, corpus);
            const persisted = (store as { upsertPendingCore?: (slot: string, content: string, evidence: number, tenant?: unknown) => boolean }).upsertPendingCore?.(p.slot, p.content, ev, tenant);
            pendingThis++;
            logger?.info?.(`[identity-discovery] pending ${p.slot}: ${p.content.slice(0, 60)} (evidence=${ev}${persisted ? ", persisted" : ""})`);
          } else {
            pendingThis++;
          }
        }
        // identity slot 单行语义：多提案合并为 bulleted 身份描述，version++ 演化
        if (identityProps.length > 0) {
          // P2 SOP（A）：演化合并——existing ∪ 本轮新事实（新事实消毒后入列，existing 行不二次转义）
          const existingIdentity = existing.find((s) => s.slot === "identity")?.content;
          const merged = mergeIdentityFacts(existingIdentity, identityProps.map((c) => escapeXmlTags(c)));
          const ok = store.upsertCore("identity", merged, "identity-discovery", tenant);
          if (ok) {
            logReplacing("identity", existing, logger);
            adoptedThis = 1;
            logger?.info?.(`[identity-discovery] adopted identity (${identityProps.length} facts)`);
            // P2：identityRefs 回填（20 字切片弱口径；F14 遗忘保护/GROW-MAINT 重验证的数据前提）
            for (const fact of identityProps) {
              const slice = identityFactSlice(fact);
              if (!slice) continue;
              for (const r of rows) {
                if (String((r as { content?: string }).content ?? "").includes(slice)) {
                  const rid = String((r as { record_id?: string }).record_id ?? "");
                  if (rid) (store as { backfillMemoryRef?: (rid: string, key: "identityRefs", label: string, t?: unknown) => boolean }).backfillMemoryRef?.(rid, "identityRefs", slice, tenant);
                }
              }
            }
          }
        }
        // self_identity slot 单行语义与 identity 同构：bulleted 合并、version++ 演化
        if (selfProps.length > 0) {
          // P2 SOP（A）：演化合并（同 identity；先截断本轮 maxPerPass 再并入）
          const existingSelf = existing.find((s) => s.slot === "self_identity")?.content;
          const mergedSelf = mergeIdentityFacts(existingSelf, selfProps.slice(0, maxSelf).map((c) => escapeXmlTags(c)));
          const okSelf = store.upsertCore("self_identity", mergedSelf, "identity-discovery", tenant);
          if (okSelf) {
            logReplacing("self_identity", existing, logger);
            adoptedThis += 1;
            logger?.info?.(`[identity-discovery] adopted self_identity (${Math.min(selfProps.length, maxSelf)} facts)`);
          }
        }
        adopted += adoptedThis;
        pending += pendingThis;

        writeState(store, tenant, { lastAttemptAt: now().toISOString(), lastCorpusCount: corpusCount });
        ranAny = true;
        logger?.info?.(`[identity-discovery] agent=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} corpus=${corpusCount} proposals=${proposals.length} adopted=${adoptedThis}`);
      } catch (err) {
        logger?.warn?.(`[identity-discovery] agent error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger?.info?.(`[identity-discovery] ran: agents=${tenants.length} adopted=${adopted} pending=${pending}`);
    return { ran: ranAny, adopted, pending };
  } catch (err) {
    logger?.warn?.(`[identity-discovery] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, adopted: 0, pending: 0, reason: "error" };
  }
}

// ── 身份采纳门：状态残留剥离（单一源，导出供测试） ──
// 第一轮（枚举式，2026-09-15）：已知状态表述的字面剥离。
// 第二轮（结构式，REG-REMAINING-002 #2，2026-09-16）：枚举可被 LLM 发明的新表述绕过
// （三轮复发实证）——升级为结构判据：日期引用（\d{4}[-年]）与阶段编号（P\d）是状态
// 陈述的结构标志，身份内容（角色/职责/关系/纪律）不应含时间坐标；命中 → 剥离所在句。
// 人工清洗（Panel / core-memory write API）保持最后兜底（单行内容，清洗成本 30 秒）。
const STATE_PHRASE_RES = [
  /（当前[^）]*）|\(当前[^)]*\)/g,
  /（截至[^）]*）|\(截至[^)]*\)/g,
  /已全部落地[^。；\n]*[。；]?/g,
  /进入观察期[^。；\n]*[。；]?/g,
];
const STATE_DATE_RE = /\d{4}[-年]\d{0,2}/;
const STATE_PHASE_RE = /P\d/;

// DS-SOUL-MEMORY-002 P1（O14）：身份修订旧文留痕——merge 成功后打一行 replacing 日志。
// 非结构化、诚实低成本：旧文仅在日志层可回溯（upsertCore 自带 version++ 演化）；
// 截断 200 字防日志膨胀；旧槽为空（首次写入）不打。
function logReplacing(
  slot: string,
  existing: Array<{ slot: string; content: string }>,
  logger?: Logger,
): void {
  const old = existing.find((s) => s.slot === slot);
  if (old?.content) logger?.info?.(`[identity-discovery] replacing ${slot} (old content): ${old.content.slice(0, 200)}`);
}

export function stripIdentityStateResidue(content: string): string {
  const s = String(content ?? "");
  if (!s) return "";
  // 切分先于枚举（审查实测修正）：枚举模式的 [。；]? 会吞句界，若先枚举后切分，
  // 相邻干净句会被并入状态句遭过度剥离。顺序：按句切分（保留分隔符）→ 逐句枚举
  // 剥离 → 结构判据（日期/阶段编号）→ 空句/状态句丢弃。
  return s
    .split(/(?<=[。；;！？\n])/)
    .map((seg) => {
      let t = seg;
      for (const re of STATE_PHRASE_RES) t = t.replace(re, "");
      return t;
    })
    .filter((t) => t.trim() !== "" && !STATE_DATE_RE.test(t) && !STATE_PHASE_RE.test(t))
    .join("")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ── helpers ──

function buildIdentityPrompt(samples: string[], existing: string[]): string {
  const sampleText = samples.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const existingText = existing.length > 0 ? existing.map((e) => `- ${e}`).join("\n") : "（空，无已有身份事实）";
  return `## 样本记忆（最近 ${samples.length} 条）\n\n${sampleText}\n\n## 已有身份事实（不得重复）\n\n${existingText}\n\n请提炼身份事实提案。`;
}

function parseProposals(raw: string): Array<{ slot: string; content: string; rationale: string }> {
  let cleaned = (raw ?? "").trim();
  if (!cleaned) return [];
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  // P1（DS-SOUL-MEMORY-002）：+self_identity。enabled=false 时幻觉提案落 else→pending（无害且诚实）。
  const valid = new Set(["identity", "core_value", "strict_rule", "self_identity"]);
  const out: Array<{ slot: string; content: string; rationale: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const slot = typeof o.slot === "string" ? o.slot : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!slot || !content || !valid.has(slot)) continue;
    out.push({ slot, content, rationale: typeof o.rationale === "string" ? o.rationale : "" });
  }
  return out;
}

function recountEvidence(content: string, corpus: string[]): number {
  let hits = 0;
  for (const c of corpus) {
    if (c.includes(content.slice(0, Math.min(content.length, 20)))) hits++;
  }
  return hits;
}

// ── state helpers ──
// GROW-EVO：独立键族（identity_* 前缀）——与 anchor-growth 的状态互不覆盖
// （共用 getAnchorGrowthState 会让身份写入清掉锚的 lastAdoptedAt → 锚 24h 冷却失效）。
function readState(store: IMemoryStore, tenant: CoreTenant): { lastAttemptAt?: string; lastCorpusCount?: number } {
  try {
    const raw = (store as unknown as { getIdentityDiscoveryState?: (t?: CoreTenant) => unknown }).getIdentityDiscoveryState?.(tenant);
    if (raw && typeof raw === "object") return raw as { lastAttemptAt?: string; lastCorpusCount?: number };
  } catch { /* fall through */ }
  return {};
}
function writeState(store: IMemoryStore, tenant: CoreTenant | undefined, state: { lastAttemptAt: string; lastCorpusCount: number }): void {
  try {
    (store as unknown as { setIdentityDiscoveryState?: (s: unknown, t?: CoreTenant) => void }).setIdentityDiscoveryState?.(state, tenant);
  } catch { /* best-effort */ }
}


/**
 * P2（spec §5 F15 身份分支/F14）：身份事实 20 字切片弱口径单源——identityRefs 回填
 * 与 GROW-MAINT 身份重验证共用（20 字足以锚定事实、又不因长句改写而失配）。
 */
export function identityFactSlice(fact: string): string {
  return fact.replace(/^-\s*/, "").trim().slice(0, 20);
}

// ── P2 SOP Round2 实证弱点修正 ─────────────────────────────────────────────

/** 身份槽事实上限（cap 8）：宁缺毋滥，防演化合并无限膨胀。 */
const IDENTITY_MAX_FACTS = 8;

/** 对抗人设注入模式（第三方把 agent 当作某身份 ≠ 行为可证自我认知）。 */
const IDENTITY_IMPOSITION_PATTERNS: RegExp[] = [
  /身份设定/,
  /把\s*我\s*当(作|成)/,
  /(认|视)\s*我\s*(为|作)/,
  /让\s*我\s*以.{0,8}身份/,
  /(叫我|让我)\s*扮演/,
  /(说|称)\s*我\s*(是|为)/,
];

/**
 * T9 实证弱点修正（B）：主语一致性门——用户口播的"身份设定/把我当作…"是第三方强加人设，
 * 不是从 agent 自身行为证得的自我认知；进 self_identity 即为提示注入成功通道。
 * 单一源：与 stripIdentityStateResidue 同层挂载（strip 拦状态陈述，本门拦强加身份）。
 */
export function isIdentityImposition(content: string): boolean {
  return IDENTITY_IMPOSITION_PATTERNS.some((re) => re.test(content));
}

/**
 * T9 实证弱点修正（A）：身份槽演化合并——existing ∪ new（bulleted 行级去重，cap 上限）。
 * store.upsertCore 保持 REPLACE 语义（面板/人工直写依赖整行替换）；组合只在本 worker，
 * 单提案运行不再抹掉既有事实（spec §2.7"version++ 演化"的正确实现）。
 * newFacts 需已消毒（调用方 escapeXmlTags 后传入）——existing 行不二次转义。
 */
export function mergeIdentityFacts(existingContent: string | undefined, newFacts: string[]): string {
  const norm = (s: string) => s.replace(/^-\s*/, "").trim();
  const seen = new Set<string>();
  const out: string[] = [];
  const existingLines = (existingContent ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-") && l.length > 1);
  // 对抗审查A1（饥饿修复）：先收集全部去重，再 slice(-cap) 保留最新——existing 在前的
  // 早退式 cap 会让槽满后新事实永不进入（演化停滞）。
  for (const line of [...existingLines, ...newFacts.filter(Boolean).map((f) => (f.startsWith("- ") ? f : "- " + f))]) {
    const key = norm(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.slice(-IDENTITY_MAX_FACTS).join("\n");
}
