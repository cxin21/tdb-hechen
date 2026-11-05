/**
 * 人格条目生命周期：准入 → 更新（α 约束）→ 合并 → 降级 → 冻结 → 复活 → 渲染预算。
 *
 * 铁律：
 *  - 只增不减。冻结不删除，合并留指针，任何动作都能回滚（before 快照进账本）。
 *  - 更新不是重写：单次文本差异不超过 α（缺省 0.15）。人格靠连续小步漂移演化，
 *    不靠一次「顿悟」翻修——这同时是防注入与防自我膨胀的结构性约束。
 *  - 预算超限必须显式记账（budget_omit），不许静默砍——静默砍是现有系统最难查的坑。
 */
import {
  allPass,
  diffRatio,
  evaluateCandidate,
  failedCodes,
  stripBullet,
  textHash,
  textSimilarity,
  type GateReport,
} from "./gates.js";
import type {
  EvidenceOrigin,
  PersonaItem,
  PersonaItemState,
  SoulBudgetReport,
  SoulLayer,
  SoulMaintenanceConfig,
} from "./types.js";
import { isInjectedLayer } from "./types.js";

export interface MakeItemInput {
  layer: SoulLayer;
  text: string;
  now: string;
  weight?: number;
  evidenceIds?: string[];
  evidenceDays?: string[];
  evidenceOrigins?: EvidenceOrigin[];
  meta?: Record<string, unknown>;
  aliases?: string[];
}

export function makePersonaItem(input: MakeItemInput): PersonaItem {
  const text = stripBullet(input.text).trim();
  return {
    itemId: `${input.layer}:${textHash(text)}`,
    layer: input.layer,
    text,
    state: "active",
    weight: clamp01(input.weight ?? 0.6),
    evidenceIds: input.evidenceIds ?? [],
    evidenceDays: input.evidenceDays ?? [],
    evidenceOrigins: input.evidenceOrigins ?? ["soul"],
    createdAt: input.now,
    updatedAt: input.now,
    lastEvidenceAt: input.now,
    aliases: input.aliases,
    meta: input.meta,
  };
}

export interface AdmitResult {
  item: PersonaItem | null;
  reports: GateReport[];
  rejected: boolean;
}

/** 准入：全量闸门通过才造条目；否则只返回判定（调用方记 method 池/账本）。 */
export function planAdmit(input: MakeItemInput & {
  existing: PersonaItem[];
  config: SoulMaintenanceConfig;
  userCorpus?: string[];
  legacy?: boolean;
  /** 本条候选挂在哪几个真实事件上（identity/values/narrative 的正向证据）。 */
  evidenceEpisodeIds?: string[];
  /** voice 引用的逐字原话（准入时校验可回溯；通过后写进 meta.fewShot 供渲染）。 */
  voiceFewShots?: { quote: string; recordId: string }[];
}): AdmitResult {
  const text = stripBullet(input.text).trim();
  const used = layerUsedChars(input.layer, input.existing);
  const reports = evaluateCandidate(text, {
    layer: input.layer,
    now: input.now,
    existing: input.existing,
    config: input.config,
    layerUsedChars: used,
    userCorpus: input.userCorpus,
    evidenceOrigins: input.evidenceOrigins,
    evidenceEpisodeIds: input.evidenceEpisodeIds,
    voiceFewShots: input.voiceFewShots,
    legacy: input.legacy,
    personName: input.config.personName,
    checkDuplicate: true,
  });
  if (!allPass(reports)) return { item: null, reports, rejected: true };
  // few-shot 与 episode 出处一起进 meta：persona 表已有 meta JSON 列，注入与审计都从这里读，
  // 不需要为渲染再加列（加列要迁移，且 json 解析已有稳定路径）。
  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (input.evidenceEpisodeIds && input.evidenceEpisodeIds.length > 0) {
    meta.episodeIds = Array.from(new Set(input.evidenceEpisodeIds));
  }
  if (input.voiceFewShots && input.voiceFewShots.length > 0) {
    meta.fewShot = input.voiceFewShots.slice(0, input.config.voiceFewShotPerItem);
  }
  return { item: makePersonaItem({ ...input, text, meta }), reports, rejected: false };
}

export interface UpdateResult {
  ok: boolean;
  item: PersonaItem;
  before: PersonaItem;
  reason: string;
  diff: number;
}

/** 更新：只允许 α 以内的小步改写；超限即拒（并记账）。 */
export function planUpdate(
  item: PersonaItem,
  newText: string,
  now: string,
  cfg: SoulMaintenanceConfig,
): UpdateResult {
  const text = stripBullet(newText).trim();
  const diff = diffRatio(item.text, text);
  const before: PersonaItem = { ...item };
  if (diff > cfg.alpha) {
    return {
      ok: false,
      item,
      before,
      diff,
      reason: `单次改写 diff=${diff.toFixed(3)} > α=${cfg.alpha}（拒绝整块翻修）`,
    };
  }
  return {
    ok: true,
    before,
    diff,
    reason: `α 内更新 diff=${diff.toFixed(3)}`,
    item: { ...item, text, updatedAt: now, aliases: item.aliases },
  };
}

export interface MergePlan {
  survivors: PersonaItem[];
  merged: Array<{ item: PersonaItem; into: string; similarity: number }>;
}

/**
 * 合并：同层内相似度 ≥ threshold 的条目并簇，保留权重最高（同权保留更早）的一条，
 * 其余置 merged 并留 mergedInto + 别名；不删除文本，可拆回。
 */
export function planMerge(
  items: PersonaItem[],
  threshold: number,
  now: string,
  similarity: (a: string, b: string) => number = textSimilarity,
): MergePlan {
  const byLayer = new Map<SoulLayer, PersonaItem[]>();
  for (const it of items) {
    // merged 已经是「并入别人的那条」：再当候选会让它每轮被重新合并一次（同一 itemId 反复重写
    // updatedAt、账本每 tick 追加 merge 行）。合并只对仍在场上的条目做。
    if (it.state === "frozen" || it.state === "merged") continue;
    const list = byLayer.get(it.layer) ?? [];
    list.push(it);
    byLayer.set(it.layer, list);
  }
  const survivors: PersonaItem[] = [];
  const merged: MergePlan["merged"] = [];
  for (const [, list] of byLayer) {
    const ordered = [...list].sort(
      (a, b) => b.weight - a.weight || Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const kept: PersonaItem[] = [];
    for (const it of ordered) {
      const host = kept.find((k) => similarity(k.text, it.text) >= threshold);
      if (!host) {
        kept.push(it);
        continue;
      }
      merged.push({ item: { ...it, state: "merged", mergedInto: host.itemId, updatedAt: now }, into: host.itemId, similarity: similarity(host.text, it.text) });
      host.aliases = Array.from(new Set([...(host.aliases ?? []), it.text]));
      host.updatedAt = now;
    }
    survivors.push(...kept);
  }
  return { survivors, merged };
}

export interface LifecyclePlan {
  items: PersonaItem[];
  degraded: string[];
  frozen: string[];
}

/** 降级/冻结：按「无新证据天数」与矛盾计数触发，均为状态迁移，不删除。 */
export function planLifecycle(items: PersonaItem[], now: string, cfg: SoulMaintenanceConfig): LifecyclePlan {
  const degraded: string[] = [];
  const frozen: string[] = [];
  const out = items.map((it) => {
    if (it.state === "frozen" || it.state === "merged") return it;
    const days = daysSince(it.lastEvidenceAt, now);
    const contradictions = it.contradictions ?? 0;
    if (contradictions >= cfg.freezeContradictions || days > cfg.freezeAfterDays) {
      frozen.push(it.itemId);
      return { ...it, state: "frozen" as PersonaItemState, updatedAt: now };
    }
    if (days > cfg.degradeAfterDays) {
      degraded.push(it.itemId);
      return {
        ...it,
        state: "degraded" as PersonaItemState,
        weight: round3(it.weight * cfg.degradeWeightFactor),
        updatedAt: now,
      };
    }
    return it;
  });
  return { items: out, degraded, frozen };
}

/** 复活：出现新证据即回到 active，权重回到至少 0.5（但不继承冻结前的虚高）。 */
export function planRevive(item: PersonaItem, now: string, evidenceIds: string[]): PersonaItem {
  return {
    ...item,
    state: "active",
    weight: Math.max(item.weight, 0.5),
    lastEvidenceAt: now,
    updatedAt: now,
    evidenceIds: Array.from(new Set([...item.evidenceIds, ...evidenceIds])),
    contradictions: 0,
  };
}

/** 矛盾：计数 +1，达阈值冻结；由「同一层出现反向主张」或用户明确否定触发。 */
export function planContradiction(item: PersonaItem, now: string, cfg: SoulMaintenanceConfig, note?: string): PersonaItem {
  const contradictions = (item.contradictions ?? 0) + 1;
  const freeze = contradictions >= cfg.freezeContradictions;
  return {
    ...item,
    contradictions,
    state: freeze ? "frozen" : item.state,
    updatedAt: now,
    meta: { ...(item.meta ?? {}), lastContradiction: note ?? "", lastContradictionAt: now },
  };
}

// ---------------------------------------------------------------- 渲染

/**
 * 层内渲染序：
 *  - boundary：按 scope 稳定分组（scope 内 weight desc）
 *  - values：weight desc（取舍的可信度）
 *  - 其余：weight desc，degrated 排在后
 */
export function orderForRender(layer: SoulLayer, items: PersonaItem[]): PersonaItem[] {
  const visible = items.filter((i) => i.state === "active" || i.state === "degraded");
  const byState = (a: PersonaItem, b: PersonaItem) => stateRank(a.state) - stateRank(b.state);
  if (layer === "boundary") {
    return [...visible].sort(
      (a, b) => scopeRank(a) - scopeRank(b) || byState(a, b) || b.weight - a.weight,
    );
  }
  return [...visible].sort((a, b) => byState(a, b) || b.weight - a.weight || a.itemId.localeCompare(b.itemId));
}

function stateRank(s: PersonaItemState): number {
  return s === "active" ? 0 : s === "degraded" ? 1 : 2;
}

function scopeRank(i: PersonaItem): number {
  const scope = String((i.meta ?? {}).scope ?? "");
  if (scope === "universal") return 0;
  if (scope === "project") return 1;
  if (scope === "client") return 2;
  return 3;
}

/** 红线层不参与渲染预算裁剪（不变量集：少一条=多一次越界）。上限由 maxItems 兜底。 */
export const BUDGET_EXEMPT_LAYERS: ReadonlySet<SoulLayer> = new Set<SoulLayer>(["boundary"]);

export function layerUsedChars(layer: SoulLayer, items: PersonaItem[]): number {
  return items
    .filter((i) => i.layer === layer && (i.state === "active" || i.state === "degraded"))
    .reduce((n, i) => n + i.text.length, 0);
}

/**
 * 预算渲染：返回渲染行 + 显式省略清单。宁可少注入，也不静默砍——
 * 现有 soul-assembler 用 480 字预算尾丢 6 条且零记录，是本次改造要治的坑。
 */
export function renderLayerWithBudget(
  layer: SoulLayer,
  items: PersonaItem[],
  cfg: SoulMaintenanceConfig,
  opts?: { header?: string; degradedTail?: boolean },
): { text: string; report: SoulBudgetReport } {
  const budget = cfg.budget[layer] ?? 0;
  // 红线层免裁剪：它是「不变量集」，少渲染一条就是多一次越界的机会；上限由 maxItems 兜住。
  const exempt = BUDGET_EXEMPT_LAYERS.has(layer);
  // 按层过滤放在函数内部：调用方传全量也不会把别的层塞进本段（否则同一批条目会在每个标题下重复一遍）。
  const layerItems = items.filter((i) => i.layer === layer);
  const ordered = orderForRender(layer, layerItems);
  const omitted: SoulBudgetReport["omitted"] = [];
  const lines: string[] = [];
  // maxItems 是池子上限的渲染侧兜底：免裁剪层（红线）不设预算，但也不允许无界膨胀。
  const cap = cfg.maxItems[layer] ?? 0;
  let used = 0;
  for (const it of ordered) {
    const line = `- ${it.text}`;
    // voice 的 few-shot 是「我怎么说话」的直接证据：挂在条目下的真实原话，
    // 比任何形容词都更能让模型改口吻。渲染成缩进引用，且计入预算（不能白嫖）。
    const quotes: string[] = [];
    if (layer === "voice") {
      const raw = (it.meta ?? {}).fewShot;
      if (Array.isArray(raw)) {
        for (const q of raw.slice(0, cfg.voiceFewShotPerItem ?? 2)) {
          const text = typeof q === "string" ? q : typeof (q as { quote?: unknown })?.quote === "string" ? String((q as { quote: string }).quote) : "";
          if (text.trim() !== "") quotes.push(`  - 「${text.trim()}」`);
        }
      }
    }
    const block = [line, ...quotes].join("\n");
    const blockChars = block.length;
    if (cap > 0 && lines.length >= cap) {
      omitted.push({
        itemId: it.itemId,
        text: it.text,
        chars: line.length,
        reason: it.state === "degraded" ? "degraded_tail" : "max_items",
      });
      continue;
    }
    if (!exempt && budget > 0 && used + blockChars > budget) {
      omitted.push({
        itemId: it.itemId,
        text: it.text,
        chars: blockChars,
        reason: it.state === "degraded" ? "degraded_tail" : "budget",
      });
      continue;
    }
    lines.push(block);
    used += blockChars;
  }
  // 非可见态也记账（便于审计「为什么不注入」）。
  for (const it of layerItems) {
    if (it.state === "frozen" || it.state === "merged") {
      omitted.push({ itemId: it.itemId, text: it.text, chars: it.text.length, reason: it.state });
    }
  }
  const header = opts?.header ?? layerHeader(layer);
  const body = lines.length > 0 ? `${header}\n${lines.join("\n")}` : "";
  return {
    text: body,
    report: { layer, usedChars: used, budgetChars: budget, rendered: lines.length, omitted },
  };
}

export function layerHeader(layer: SoulLayer): string {
  switch (layer) {
    case "voice":
      return "## 我的说话方式";
    case "identity":
      return "## 我是谁";
    case "self":
      return "## 我对自己";
    case "values":
      return "## 我在冲突里站哪边";
    case "boundary":
      return "## 我不做的事";
    case "relationship":
      return "## 我和他的关系";
    case "narrative":
      return "## 我的来路";
    default:
      return "";
  }
}

/** 完整人格段（注入用）：只渲染注入层，按固定顺序；空层不占位。 */
export function renderPersonaBlock(
  items: PersonaItem[],
  cfg: SoulMaintenanceConfig,
): { text: string; reports: SoulBudgetReport[] } {
  const order: SoulLayer[] = ["voice", "identity", "self", "values", "boundary", "relationship", "narrative"];
  const parts: string[] = [];
  const reports: SoulBudgetReport[] = [];
  for (const layer of order) {
    if (!isInjectedLayer(layer)) continue;
    const layerItems = items.filter((i) => i.layer === layer);
    if (layerItems.length === 0) continue;
    const { text, report } = renderLayerWithBudget(layer, layerItems, cfg);
    reports.push(report);
    if (text) parts.push(text);
  }
  return { text: parts.join("\n\n"), reports };
}

/** 从 core_memory 槽正文拆行（兼容既有弹头与空行）。 */
export function splitSlotLines(content: string | null | undefined): string[] {
  if (!content) return [];
  return content
    .split(/\r?\n/u)
    .map((l) => stripBullet(l).trim())
    .filter((l) => l.length > 0);
}

export function daysSince(iso: string, now: string): number {
  const a = Date.parse(iso);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / 86_400_000;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { failedCodes };
