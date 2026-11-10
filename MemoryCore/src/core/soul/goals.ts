/**
 * 目标写者（P3 §4.5）：从「显式承诺」和「计划句」长出 soul_goals 行，走状态机，
 * 并把 working 锚（soul_working_state）压进预算。
 *
 * 三条产品口径（spec §4.5 + 用户拍板）：
 *  - 只从显式承诺与计划长：我答应你/我答应过自己/我计划…；「我希望/我想要/要是能」一律不立目标。
 *    把一个愿望记成承诺，比不记更糟——它会在三天后变成「我答应了却没做到」的假欠账。
 *  - 状态机只认证据：done 要有兑现（后续同一对象的好转/补上），abandoned 要有没守住的证据或我明说不要了；
 *    时间过期只降到 blocked（不是失败，也不是消失），这是「欠着」而不是「没发生过」。
 *  - working 锚只放在意的东西：top1 在做 + top2 到期承诺 + top1 卡住，整块 ≤300 字；
 *    没有就整行不写（clearSoulWorkingState），绝不写「暂无目标」占位。
 *
 * 常量全部写死（用户拍板：不新增配置项/开关/环境变量）。
 * spec：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.5。
 */

import { textHash } from "./gates.js";
import { factsFromEpisode, settlePromises, type HistoryFact } from "./history.js";
import type { SoulEpisode } from "./types.js";
import type {
  SoulGoalDepInsert,
  SoulGoalDepRow,
  SoulGoalEventInsert,
  SoulGoalInsert,
  SoulGoalKind,
  SoulGoalOwner,
  SoulGoalRow,
  SoulGoalStatus,
  SoulWorkingStateUpsert,
} from "../store/soul-event-types.js";
import type { GoalTransitionOptions, GoalTransitionResult } from "../store/soul-goal-store.js";
import { SOUL_GOAL_LIST_DEFAULT_LIMIT, TERMINAL_GOAL_STATUSES } from "../store/soul-goal-store.js";
import type { CoreTenant, SoulPromiseStatus } from "../store/types.js";

/** 标题上限：一句话的目标；再长就是计划书，不是目标。 */
export const GOAL_TITLE_MAX = 56;
/** working 锚整块预算（含标点），超了就按优先级丢整段。 */
export const GOAL_WORKING_MAX_CHARS = 300;
/** 锚里每条的可见长度；300 字里要装 1+2+1 条，只能这么长。 */
export const GOAL_WORKING_TITLE_CLIP = 40;
/** 只在句子前 80 字找时间词：避免把后文的「下周」算到这一句上。 */
export const GOAL_DUE_SEARCH_CHARS = 80;
/** 一句正文最多看多少字（事件 outcome 可能是长段汇报）。 */
export const GOAL_TEXT_SCAN_CHARS = 160;
/** 锚过期时间：没有更近的到期时间就按 24h；过期的锚读侧当没有。 */
export const GOAL_WORKING_TTL_MS = 24 * 3600 * 1000;

/** 过期降级的原因前缀：解阻时要能认出「这是时间造成的阻塞」。 */
export const GOAL_OVERDUE_REASON_PREFIX = "过期未兑现：";
/** 依赖阻塞的原因前缀（同上，用于解阻判定）。 */
export const GOAL_BLOCKED_BY_PREFIX = "等着：";

/** 「我答应你」：对别人说出口的承诺，owner=joint。 */
const PROMISE_TO_OTHER =
  /我(?:答应(?:你|您)|向(?:你|您)(?:保证|承诺)|和(?:你|您)约定|跟(?:你|您)约定|承诺你|承诺您|保证你|保证您)/u;
const PROMISE_TO_OTHER_LEAD =
  /^我(?:答应(?:你|您)?|向(?:你|您)(?:保证|承诺)|和(?:你|您)约定|跟(?:你|您)约定|承诺(?:你|您)?|保证(?:你|您)?)[：:，,、]?\s*/u;
/** 自我承诺事实的包装（history.ts factsFromEpisode 生成，逐字匹配）。 */
const PROMISE_FACT_WRAP = /^我答应过自己：「(.*)」$/u;
/** 计划句：我计划/打算/准备/接下来要…。 */
const PLAN = /我(?:计划|打算|准备|接下来(?:先|会|要|就)?)/u;
const PLAN_LEAD = /^我(?:计划|打算|准备|接下来(?:先|会|要|就)?)(?:先|就|要|会|把|在|于)?[：:，,、]?\s*/u;
/** 愿望词：明确不立目标。只在没有显式承诺/计划时起作用（同一句里说了「我答应你」以承诺为准）。 */
const WISH = /我(?:希望|真希望|想要|很想|梦想|幻想|要是能|如果能|盼着)/u;

const CN_NUM: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function cnNum(raw: string): number {
  if (/^\d+$/u.test(raw)) return Number(raw);
  return CN_NUM[raw] ?? 0;
}

function normalizeSpace(text: string): string {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function clip(text: string, max: number): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** 去掉 acp 信封/markdown 行首/换行，得到一句可读正文（与 history.ts 的 cleanFix 同一口径）。 */
function stripEnvelope(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/<\/?acp[^>]*>/gu, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/gu, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[#>*-]+\s*|\[?acp\]?\s*)/iu, "").trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 取第一句：计划与承诺都在首句里说，后面的执行细节不该进标题。 */
function firstSentence(text: string, max: number): string {
  const s = String(text ?? "").trim();
  if (s === "") return "";
  const cut = s.split(/[。！？；;!?]/u)[0] ?? "";
  return clip(cut.trim(), max);
}

function stripQuotes(text: string): string {
  return String(text ?? "")
    .replace(/^[「"“”'\u2018\u2019]+/u, "")
    .replace(/[」"“”'\u2018\u2019]+$/u, "")
    .trim();
}

function normalizeTitle(title: string): string {
  return normalizeSpace(title)
    .replace(/[「」"“”]/gu, "")
    .toLowerCase();
}

/**
 * 目标 id 确定性：同一 (kind, owner, 归一标题) 只有一行。
 * 这样「同一句话在三天里说了三次」收敛成一条目标 + 三条 reasserted 账本，不刷出三个目标。
 */
export function goalIdFor(args: { kind: SoulGoalKind; owner: SoulGoalOwner; title: string }): string {
  return "g-" + textHash(args.kind + "|" + args.owner + "|" + normalizeTitle(args.title)).slice(0, 16);
}

/**
 * 承诺 → 目标 id：spec §5.1「goal_id 由 promise_id 派生（可反查、重跑不变）」。
 * 与 P0-D 迁移（scripts/lib/soul-event-migration.mjs:432 的 goal-<promise_id>）逐字一致：
 * 迁移建过的目标，写者重跑时必须命中同一行，而不是再长一条 g- 哈希目标。
 */
export function goalIdForPromise(promiseId: string): string {
  const id = String(promiseId ?? "").trim();
  return id === "" ? "" : "goal-" + id;
}

/** 承诺包装的原文（不截断）：id 归一与标题归一都从它出发。 */
function unwrapPromiseBody(text: string): string {
  const s = normalizeSpace(text);
  if (s === "") return "";
  const m = PROMISE_FACT_WRAP.exec(s);
  return stripQuotes(m ? (m[1] ?? "") : s);
}

/**
 * 等价口径的文本键：剥掉承诺包装与引号、折叠空白、去掉句末标点、转小写。
 * 只做确定性归一（「我答应过自己：「X」」与「X」是同一句），不做模糊相似——
 * 相似度阈值会把「改说明」和「改文档」判成一条，那是另一种错账。
 */
export function goalTitleKey(title: string): string {
  return normalizeTitle(unwrapPromiseBody(title)).replace(/[。！？!?.,，、;；\s]+$/u, "");
}

export interface GoalIdentityHit {
  goalId: string;
  /** promise = 命中 promise_id 派生的确定性 id；title = 命中同文本活目标；candidate = 没有可复用的。 */
  reason: "promise" | "title" | "candidate";
}

function liveGoalRows(rows: SoulGoalRow[]): SoulGoalRow[] {
  return rows.filter((row) => !TERMINAL_GOAL_STATUSES.includes(row.status));
}

function earliest(rows: SoulGoalRow[]): SoulGoalRow {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.goal_id < b.goal_id ? -1 : a.goal_id > b.goal_id ? 1 : 0;
  })[0]!;
}

/**
 * 复用判定（同租户由 listSoulGoals 的租户边界保证；只复用 active/blocked，终态不复活）：
 *  1) 候选来自承诺且 promise_id 派生的 goal 还活着 → 用它（承诺与目标的对应关系可反查）；
 *  2) 存在同文本键的活目标 → 用最早那一条（worker 派生与 promise 派生撞同一句话时收敛到一条）；
 *  3) 都没有 → 用候选自己的 id（承诺候选仍是 goal-<promise_id>，其余是 g-<hash>）。
 * 判据是「同文本」或「同 promise_id」，没有相似度。
 */
export function resolveGoalIdentity(args: {
  candidate: GoalCandidate;
  existing: SoulGoalRow[];
  promiseId?: string;
}): GoalIdentityHit {
  const live = liveGoalRows(args.existing);
  const promised = args.promiseId ? goalIdForPromise(args.promiseId) : "";
  if (promised !== "") {
    const hit = live.find((row) => row.goal_id === promised);
    if (hit) return { goalId: hit.goal_id, reason: "promise" };
  }
  const key = goalTitleKey(args.candidate.goal.title);
  if (key !== "") {
    const same = live.filter((row) => goalTitleKey(row.title) === key);
    if (same.length > 0) {
      const row = earliest(same);
      return { goalId: row.goal_id, reason: row.goal_id === promised ? "promise" : "title" };
    }
  }
  if (promised !== "") return { goalId: promised, reason: "promise" };
  return { goalId: String(args.candidate.goal.goal_id ?? ""), reason: "candidate" };
}

/** 按同文本键找活目标（承诺兑现/没守住的跃迁要用：id 可能已被复用改写成 goal-<promise_id>）。 */
export function findLiveGoalByTitle(rows: SoulGoalRow[], title: string): SoulGoalRow | null {
  const key = goalTitleKey(title);
  if (key === "") return null;
  const same = liveGoalRows(rows).filter((row) => goalTitleKey(row.title) === key);
  return same.length > 0 ? earliest(same) : null;
}

/**
 * 依赖边只从结构化的 parent_goal_id 落：父必须在这批目标里、且不能是自己。
 * 没有父就没有边——不按「同事件」「同对象」猜依赖，假边会让无辜目标被卡住。
 */
export function collectGoalDepEdges(goals: SoulGoalRow[]): GoalDepEdge[] {
  const ids = new Set(goals.map((row) => row.goal_id));
  const seen = new Set<string>();
  const out: GoalDepEdge[] = [];
  for (const row of goals) {
    const parent = String(row.parent_goal_id ?? "").trim();
    if (parent === "" || parent === row.goal_id || !ids.has(parent)) continue;
    const key = row.goal_id + "\u0000" + parent;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ goal_id: row.goal_id, depends_on_goal_id: parent, kind: "blocks" });
  }
  return out;
}

export interface GoalDepEdge {
  goal_id: string;
  depends_on_goal_id: string;
  kind: string;
}

/** 从承诺事实的包装里取正文（不是承诺事实就原样返回）。 */
export function unwrapPromiseFact(text: string): string {
  return clip(unwrapPromiseBody(text), GOAL_TITLE_MAX);
}

/**
 * 时间词 → due_at（确定性，只在句子前 80 字找）。认不出返回 null：
 * 没有截止时间的承诺照样记账，但不编一个假期限。
 *
 * 认：N天后 / N天内 / 明天(明早/明晚) / 后天 / 今天(今晚) / 本周(这周) / 下周 / 月底。
 * 统一落到「那天 23:59:59.999Z」——承诺的时限是一整天，不是某个时刻。
 */
export function parseGoalDueAt(text: string, at: string): string | null {
  const base = new Date(at);
  if (Number.isNaN(base.getTime())) return null;
  const head = normalizeSpace(text).slice(0, GOAL_DUE_SEARCH_CHARS);
  if (head === "") return null;
  const endOfDay = (d: Date): string =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)).toISOString();
  const shift = (n: number): Date => {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const span = /(\d+|[一二两三四五六七八九十])\s*天(?:之)?(?:后|内)/u.exec(head);
  if (span) {
    const n = cnNum(span[1] ?? "");
    if (n > 0) return endOfDay(shift(n));
  }
  if (/后天/u.test(head)) return endOfDay(shift(2));
  if (/明天|明日|明早|明晚/u.test(head)) return endOfDay(shift(1));
  if (/今天|今日|今晚/u.test(head)) return endOfDay(shift(0));
  const toWeekEnd = (7 - base.getUTCDay()) % 7;
  if (/下周/u.test(head)) return endOfDay(shift(toWeekEnd + 7));
  if (/本周|这周|这个星期/u.test(head)) return endOfDay(shift(toWeekEnd));
  if (/月底|月末/u.test(head)) {
    return endOfDay(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  }
  return null;
}

export interface GoalCandidate {
  goal: SoulGoalInsert;
  /** 这条目标从哪条事件长出来（账本 event_id 用 "ep:<id>"）。 */
  episodeId: string;
  /** 只有自我承诺事实带得起：用来把 soul_promises 那一行挂上 goal_id。 */
  promiseRef?: { refKey: string; content: string };
}

function makeCandidate(args: {
  kind: SoulGoalKind;
  owner: SoulGoalOwner;
  title: string;
  why: string;
  at: string;
  episodeId: string;
  dueSource?: string;
  promiseRef?: { refKey: string; content: string };
}): GoalCandidate {
  const title = clip(normalizeSpace(args.title), GOAL_TITLE_MAX);
  const commitment = args.kind === "commitment";
  const joint = args.owner === "joint";
  const goal: SoulGoalInsert = {
    goal_id: goalIdFor({ kind: args.kind, owner: args.owner, title }),
    owner: args.owner,
    kind: args.kind,
    title,
    why: clip(args.why, 160),
    priority: commitment ? (joint ? 0.65 : 0.6) : 0.45,
    due_at: parseGoalDueAt(args.dueSource ?? title, args.at),
    confidence: commitment ? 0.7 : 0.5,
    success_criteria: clip("做到「" + title + "」，并把证据留在当时的会话里", 160),
    valid_from: args.at,
    created_at: args.at,
    updated_at: args.at,
  };
  return { goal, episodeId: args.episodeId, promiseRef: args.promiseRef };
}

/**
 * 纯派生：给定事件与事实，产出目标候选（不碰库）。
 * 只认三类来源：承诺事实（自我承诺）、事件正文里的「我答应你」、事件正文里的计划句。
 */
export function deriveGoals(args: { episodes: SoulEpisode[]; facts: HistoryFact[] }): GoalCandidate[] {
  const out: GoalCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: GoalCandidate): void => {
    const key = String(c.goal.goal_id) + "\u0000" + c.episodeId + "\u0000" + String(c.goal.due_at ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  for (const fact of args.facts) {
    if (fact.kind !== "promise") continue;
    const body = unwrapPromiseFact(fact.text);
    if (body === "") continue;
    push(
      makeCandidate({
        kind: "commitment",
        owner: "self",
        title: body,
        why: "这是我对自己立的约束",
        at: isoOrNow(fact.at),
        episodeId: fact.episodeIds[0] ?? "",
        dueSource: body,
        promiseRef: { refKey: fact.object === "这件事" ? "" : fact.object, content: fact.text },
      }),
    );
  }

  const episodes = [...args.episodes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const ep of episodes) {
    const raw = ep.outcome && ep.outcome.trim() !== "" ? ep.outcome : ep.agentStance;
    // 问句既不是承诺也不是计划。firstSentence 会把「？」当断句符切掉，
    // 所以判据要看原始首句里有没有问号（「我计划这样吗？」不该长成目标「这样吗」）。
    if (/^[^。！；;]*[？?]/u.test(stripEnvelope(raw))) continue;
    const text = firstSentence(stripEnvelope(raw), GOAL_TEXT_SCAN_CHARS);
    if (text === "") continue;
    const at = isoOrNow(ep.at);
    if (PROMISE_TO_OTHER.test(text)) {
      const title = clip(normalizeSpace(text.replace(PROMISE_TO_OTHER_LEAD, "")), GOAL_TITLE_MAX);
      if (title === "") continue;
      const asked = firstSentence(stripEnvelope(ep.userStance), 40);
      push(
        makeCandidate({
          kind: "commitment",
          owner: "joint",
          title,
          why: asked !== "" ? "他那边问过：「" + asked + "」" : "我主动答应的",
          at,
          episodeId: ep.episodeId,
        }),
      );
      continue;
    }
    if (PLAN.test(text)) {
      const title = clip(normalizeSpace(text.replace(PLAN_LEAD, "")), GOAL_TITLE_MAX);
      if (title === "") continue;
      const object = normalizeSpace(ep.object);
      push(
        makeCandidate({
          kind: "plan",
          owner: "self",
          title,
          why: object !== "" ? "这件事在推「" + clip(object, 40) + "」" : "我给自己排的下一步",
          at,
          episodeId: ep.episodeId,
        }),
      );
      continue;
    }
    // 没有显式承诺/计划：愿望句不算目标，其它句子也不猜。
    if (WISH.test(text)) continue;
  }
  return out;
}

function isoOrNow(value: string | undefined): string {
  const s = String(value ?? "").trim();
  if (s !== "" && !Number.isNaN(Date.parse(s))) return s;
  return new Date().toISOString();
}

/** 排序：先比截止时间（无到期排最后），再比优先级、再比新建。 */
function sortByUrgency(goals: SoulGoalRow[]): SoulGoalRow[] {
  return [...goals].sort((a, b) => {
    const ad = a.due_at ?? "9999-12-31T23:59:59.999Z";
    const bd = b.due_at ?? "9999-12-31T23:59:59.999Z";
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.goal_id < b.goal_id ? -1 : 1;
  });
}

function dueSuffix(goal: SoulGoalRow, now: string): string {
  if (!goal.due_at) return "";
  const day = goal.due_at.slice(5, 10);
  return "（" + day + (goal.due_at < now ? " 已过" : " 到期") + "）";
}

/** 段落预算：按优先级整段丢（先是「卡住」，再是「欠着」），最后才截断唯一剩下的一段。 */
function fitBudget(parts: string[], max: number): string {
  let kept = [...parts].filter((p) => p !== "");
  while (kept.length > 0) {
    const text = kept.join("；");
    if (text.length <= max) return text;
    if (kept.length === 1) return clip(text, max);
    kept = kept.slice(0, -1);
  }
  return "";
}

/**
 * working 锚：top1 在做（active）+ top2 到期承诺 + top1 卡住（blocked），整块 ≤300 字。
 * 返回 null = 什么都不该写（没有目标/全部终态）——调用侧清行，不写占位。
 */
export function buildWorkingState(args: { goals: SoulGoalRow[]; now: string }): SoulWorkingStateUpsert | null {
  const now = args.now;
  const open = args.goals.filter((g) => g.status === "active" || g.status === "blocked");
  if (open.length === 0) return null;
  const sorted = sortByUrgency(open);
  const focus = sorted.find((g) => g.status === "active") ?? null;
  const blocked = sorted.find((g) => g.status === "blocked") ?? null;
  const dueCommitments = sorted
    .filter(
      (g) =>
        g.status === "active" &&
        (g.kind === "commitment" || g.owner === "joint") &&
        typeof g.due_at === "string" &&
        g.goal_id !== focus?.goal_id,
    )
    .slice(0, 2);
  if (!focus && dueCommitments.length === 0 && !blocked) return null;

  const parts: string[] = [];
  if (focus) parts.push("在做：" + clip(focus.title, GOAL_WORKING_TITLE_CLIP) + dueSuffix(focus, now));
  if (dueCommitments.length > 0) {
    parts.push(
      "欠着：" +
        dueCommitments.map((g) => clip(g.title, GOAL_WORKING_TITLE_CLIP) + dueSuffix(g, now)).join("、"),
    );
  }
  if (blocked) {
    const reason = normalizeSpace(blocked.blocked_reason);
    parts.push(
      "卡住：" +
        clip(blocked.title, GOAL_WORKING_TITLE_CLIP) +
        (reason !== "" ? "（" + clip(reason, 24) + "）" : ""),
    );
  }
  const currentFocus = fitBudget(parts, GOAL_WORKING_MAX_CHARS);
  if (currentFocus === "") return null;

  const dueTimes = [focus, ...dueCommitments, blocked]
    .filter((g): g is SoulGoalRow => Boolean(g && g.due_at))
    .map((g) => g.due_at as string)
    .filter((iso) => iso > now)
    .sort();
  const expiresAt =
    dueTimes.length > 0 ? dueTimes[0]! : new Date(Date.parse(now) + GOAL_WORKING_TTL_MS).toISOString();
  return {
    session_id: "",
    current_goal_id: focus?.goal_id ?? null,
    current_focus: currentFocus,
    open_questions_json: "[]",
    updated_at: now,
    expires_at: expiresAt,
  };
}

/**
 * 「跨三天问承诺能答」的读面：把还没兑现的承诺说成一句人话（供卡/锚/自省共用）。
 * 没有就返回 null——不返回「暂无」这种占位。
 */
export function commitmentAnswer(
  goals: SoulGoalRow[],
  opts?: { now?: string; limit?: number },
): string | null {
  const now = opts?.now ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(5, Math.floor(opts?.limit ?? 3)));
  const open = goals.filter(
    (g) => (g.status === "active" || g.status === "blocked") && (g.kind === "commitment" || g.owner === "joint"),
  );
  if (open.length === 0) return null;
  const lines = sortByUrgency(open)
    .slice(0, limit)
    .map((g) => {
      const due =
        g.due_at === null
          ? ""
          : g.due_at < now
            ? "，已经过期（" + g.due_at.slice(0, 10) + "）"
            : "，" + g.due_at.slice(0, 10) + " 前";
      const blocked =
        g.status === "blocked" && normalizeSpace(g.blocked_reason) !== ""
          ? "（卡着：" + clip(g.blocked_reason, 30) + "）"
          : "";
      return "我答应过「" + g.title + "」" + due + blocked;
    });
  return lines.join("；");
}

/** 写者只依赖这些可选 store 能力（缺失时整体跳过，与人物档案通道同一惯例）。 */
export interface GoalStorePort {
  listSoulEpisodes?: (
    tenant?: CoreTenant,
    opts?: { limit?: number; includeArchived?: boolean },
  ) => SoulEpisode[] | Promise<SoulEpisode[]>;
  listSoulGoals?: (tenant?: CoreTenant, opts?: { limit?: number }) => SoulGoalRow[] | Promise<SoulGoalRow[]>;
  upsertSoulGoal?: (
    tenant: CoreTenant | undefined,
    insert: SoulGoalInsert,
  ) => { row: SoulGoalRow; created: boolean } | Promise<{ row: SoulGoalRow; created: boolean }>;
  insertSoulGoalEvents?: (
    tenant: CoreTenant | undefined,
    rows: SoulGoalEventInsert[],
  ) => { inserted: number } | Promise<{ inserted: number }>;
  transitionSoulGoal?: (
    tenant: CoreTenant | undefined,
    goalId: string,
    to: SoulGoalStatus,
    opts?: GoalTransitionOptions,
  ) => GoalTransitionResult | Promise<GoalTransitionResult>;
  listSoulGoalDeps?: (tenant?: CoreTenant, opts?: { goalId?: string }) => SoulGoalDepRow[] | Promise<SoulGoalDepRow[]>;
  insertSoulGoalDep?: (
    tenant: CoreTenant | undefined,
    row: SoulGoalDepInsert,
  ) => { inserted: number } | Promise<{ inserted: number }>;
  listSoulPromises?: (
    tenant: CoreTenant,
    opts?: { limit?: number; status?: SoulPromiseStatus },
  ) => Array<{ promiseId: string; content: string; status: string; refKey: string }> | Promise<
    Array<{ promiseId: string; content: string; status: string; refKey: string }>
  >;
  setSoulPromiseGoal?: (
    tenant: CoreTenant | undefined,
    promiseId: string,
    goalId: string,
  ) => { updated: boolean } | Promise<{ updated: boolean }>;
  upsertSoulWorkingState?: (tenant: CoreTenant | undefined, row: SoulWorkingStateUpsert) => unknown;
  clearSoulWorkingState?: (
    tenant: CoreTenant | undefined,
    opts?: { sessionId?: string },
  ) => { deleted: number } | Promise<{ deleted: number }>;
}

export interface GoalMaintenanceResult {
  /** 本 tick 派生出的目标候选（重复说的同一句话也算一个候选，会在账本里落成 reasserted）。 */
  candidates: number;
  /** 新建的目标行数。 */
  created: number;
  /** 账本里新增的 reasserted 行数（「又说了一次」，幂等命中不计）。 */
  reasserted: number;
  /** 已终态、不再因重说而复活的候选数。 */
  skipped: number;
  /** 成功挂上 goal_id 的承诺行数。 */
  linked: number;
  /** 命中已有等价目标（同文本/同 promise_id）而复用 goal_id 的候选数——这些不是新行。 */
  reused?: number;
  /** 本次新落的依赖边数（只来自 parent_goal_id，没父就是 0）。 */
  deps?: number;
  /** 实际发生的状态跃迁次数（兑现/放弃/过期/解阻/依赖）。 */
  transitions: number;
  /** 本 tick 是否写了 working 锚。 */
  working: boolean;
  /** 锚正文长度（≤300）。 */
  focusChars: number;
}

/**
 * 维护 tick 的写者：派生 → 幂等 upsert → 账本 → 承诺挂靠 → 状态机（兑现/过期/依赖）→ working 锚。
 * 整段只在 store 提供 upsertSoulGoal 时工作；缺能力时返回零值（不写半套）。
 */
export async function runGoalMaintenance(args: {
  store: GoalStorePort;
  tenant: CoreTenant;
  episodes?: SoulEpisode[];
  facts?: HistoryFact[];
  now?: string;
  logger?: { warn?: (msg: string) => void };
}): Promise<GoalMaintenanceResult> {
  const { store, tenant } = args;
  const now = args.now ?? new Date().toISOString();
  const warn = (msg: string): void => args.logger?.warn?.("[soul-goals] " + msg);
  const result: GoalMaintenanceResult = {
    candidates: 0,
    created: 0,
    reasserted: 0,
    skipped: 0,
    linked: 0,
    reused: 0,
    deps: 0,
    transitions: 0,
    working: false,
    focusChars: 0,
  };
  const upsert = store.upsertSoulGoal;
  const listGoals = store.listSoulGoals;
  if (typeof upsert !== "function" || typeof listGoals !== "function") return result;

  let episodes = args.episodes;
  if (!episodes) {
    if (typeof store.listSoulEpisodes !== "function") return result;
    episodes = (await Promise.resolve(store.listSoulEpisodes.call(store, tenant, { limit: 2000, includeArchived: true }))) ?? [];
  }
  const facts = args.facts ?? settlePromises(episodes.flatMap((ep) => factsFromEpisode(ep)), episodes);
  const candidates = deriveGoals({ episodes, facts });
  result.candidates = candidates.length;

  const existing = (await Promise.resolve(listGoals.call(store, tenant, { limit: SOUL_GOAL_LIST_DEFAULT_LIMIT }))) ?? [];
  const byId = new Map(existing.map((row) => [row.goal_id, row]));
  /** 这一轮看得到的活目标（含刚写的）：同文本复用要以它为准，不然一轮里两个候选会各建一条。 */
  const liveRows: SoulGoalRow[] = [...existing];
  const ledger: SoulGoalEventInsert[] = [];

  // 承诺先读：promise_id → goal_id 是可反查的确定性对应，等价判定要用它。
  const promiseByKey = new Map<
    string,
    { promiseId: string; content: string; status: string; refKey: string }
  >();
  if (typeof store.listSoulPromises === "function") {
    try {
      const rows = (await Promise.resolve(store.listSoulPromises.call(store, tenant, { limit: 500 }))) ?? [];
      for (const row of rows) {
        promiseByKey.set(String(row.refKey ?? "") + "\u0000" + String(row.content ?? ""), row);
      }
    } catch (err) {
      warn("读承诺失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 候选 → 实际落库的 goal_id（承诺挂靠必须用它，不能用候选自己的 id）。 */
  const resolvedGoalIds = new Map<GoalCandidate, string>();

  for (const candidate of candidates) {
    const ref = candidate.promiseRef;
    const promise = ref ? promiseByKey.get(ref.refKey + "\u0000" + ref.content) : undefined;
    const hit = resolveGoalIdentity({
      candidate,
      existing: liveRows,
      ...(promise ? { promiseId: promise.promiseId } : {}),
    });
    const goalId = hit.goalId;
    try {
      const before = byId.get(goalId);
      if (before && TERMINAL_GOAL_STATUSES.includes(before.status)) {
        result.skipped += 1;
        continue;
      }
      const insert: SoulGoalInsert =
        goalId === String(candidate.goal.goal_id ?? "") ? candidate.goal : { ...candidate.goal, goal_id: goalId };
      const written = await Promise.resolve(upsert.call(store, tenant, insert));
      byId.set(written.row.goal_id, written.row);
      const pos = liveRows.findIndex((row) => row.goal_id === written.row.goal_id);
      if (pos >= 0) liveRows[pos] = written.row;
      else liveRows.push(written.row);
      resolvedGoalIds.set(candidate, written.row.goal_id);
      if (written.created) result.created += 1;
      // 复用 = 命中了已有等价目标（同 promise_id 或同文本），这一候选没有新增行。
      else if (hit.reason !== "candidate") result.reused = (result.reused ?? 0) + 1;
      ledger.push({
        goal_id: written.row.goal_id,
        event_id: "ep:" + (candidate.episodeId !== "" ? candidate.episodeId : candidate.goal.valid_from),
        change: written.created ? "created" : "reasserted",
        from_status: written.created ? null : written.row.status,
        to_status: written.row.status,
        note: clip(candidate.goal.why ?? "", 160),
        at: candidate.goal.valid_from,
      });
    } catch (err) {
      warn(goalId + " 写入失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (ledger.length > 0 && typeof store.insertSoulGoalEvents === "function") {
    try {
      const written = await Promise.resolve(store.insertSoulGoalEvents.call(store, tenant, ledger));
      // created 的账本行必然是新行（行只建一次），多出来的就是「又说了一次」。
      result.reasserted += Math.max(0, (written?.inserted ?? 0) - result.created);
    } catch (err) {
      warn("账本写入失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (typeof store.setSoulPromiseGoal === "function" && promiseByKey.size > 0) {
    try {
      for (const candidate of candidates) {
        const ref = candidate.promiseRef;
        if (!ref) continue;
        const hit = promiseByKey.get(ref.refKey + "\u0000" + ref.content);
        if (!hit) continue;
        const goalId = resolvedGoalIds.get(candidate);
        if (!goalId) continue;
        const written = await Promise.resolve(
          store.setSoulPromiseGoal.call(store, tenant, hit.promiseId, goalId),
        );
        if (written?.updated) result.linked += 1;
      }
    } catch (err) {
      warn("承诺挂靠失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  // 依赖边：只从 parent_goal_id 落（父在库、不是自己）。没父就 0 行，不按事件/对象猜边。
  if (typeof store.insertSoulGoalDep === "function") {
    const edges = collectGoalDepEdges(Array.from(byId.values()));
    for (const edge of edges) {
      try {
        const written = await Promise.resolve(store.insertSoulGoalDep.call(store, tenant, edge));
        if ((written?.inserted ?? 0) > 0) result.deps = (result.deps ?? 0) + 1;
      } catch (err) {
        warn("依赖边写入失败（" + edge.goal_id + " -> " + edge.depends_on_goal_id + "）：" + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  const transition = store.transitionSoulGoal;
  const doTransition = async (
    goalId: string,
    to: SoulGoalStatus,
    opts: GoalTransitionOptions,
  ): Promise<SoulGoalRow | null> => {
    if (typeof transition !== "function") return null;
    try {
      const written = await Promise.resolve(transition.call(store, tenant, goalId, to, opts));
      if (!written.ok) {
        warn(goalId + " 拒绝跃迁（" + written.reason + "）");
        return null;
      }
      if (!written.changed) return written.goal;
      result.transitions += 1;
      byId.set(goalId, written.goal);
      return written.goal;
    } catch (err) {
      warn(goalId + " 跃迁失败：" + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  };

  // 1) 兑现/没守住：有后续同一对象的事件才算数（settlePromises 已经核对过）。
  for (const fact of facts) {
    if (fact.kind !== "promise" || fact.fulfillment === undefined || fact.fulfillment === "open") continue;
    const body = unwrapPromiseFact(fact.text);
    if (body === "") continue;
    // id 可能已被复用改写成 goal-<promise_id>，所以按同文本键找活目标，不按派生 id 找。
    const row = findLiveGoalByTitle(liveRows, body);
    if (!row || TERMINAL_GOAL_STATUSES.includes(row.status)) continue;
    const goalId = row.goal_id;
    const kept = fact.fulfillment === "kept";
    await doTransition(goalId, kept ? "done" : "abandoned", {
      at: now,
      reason: kept ? "后来按原话补上了（同一对象的新事件）" : "同一对象后来又失败，且没有更晚的修复",
      eventId: "settle:" + textHash(fact.text + "|" + fact.fulfillment).slice(0, 16),
      note: clip(fact.text, 160),
    });
  }

  // 2) 时间：到期没做到只降到 blocked（欠着），不是 done 也不是消失。
  for (const snapshot of Array.from(byId.values())) {
    const row = byId.get(snapshot.goal_id);
    if (!row) continue;
    if (row.status === "active" && row.due_at !== null && row.due_at < now) {
      await doTransition(row.goal_id, "blocked", {
        at: now,
        reason: GOAL_OVERDUE_REASON_PREFIX + row.due_at,
        eventId: "overdue:" + textHash(row.goal_id + "|" + row.due_at).slice(0, 16),
      });
      continue;
    }
    if (
      row.status === "blocked" &&
      row.blocked_reason.startsWith(GOAL_OVERDUE_REASON_PREFIX) &&
      (row.due_at === null || row.due_at >= now)
    ) {
      await doTransition(row.goal_id, "active", {
        at: now,
        reason: "时间改了，重新排上",
        eventId: "unblock:" + textHash(row.goal_id + "|" + row.blocked_reason).slice(0, 16),
      });
    }
  }

  // 3) 依赖：等着的那件事没完成，我就卡着；它完成了，我自动解开。
  if (typeof store.listSoulGoalDeps === "function") {
    try {
      const deps = (await Promise.resolve(store.listSoulGoalDeps.call(store, tenant))) ?? [];
      for (const dep of deps) {
        const goal = byId.get(dep.goal_id);
        const blocker = byId.get(dep.depends_on_goal_id);
        if (!goal || !blocker) continue;
        if (blocker.status !== "done" && goal.status === "active") {
          await doTransition(goal.goal_id, "blocked", {
            at: now,
            reason: GOAL_BLOCKED_BY_PREFIX + clip(blocker.title, 40),
            eventId: "dep:" + textHash(goal.goal_id + "|" + blocker.goal_id).slice(0, 16),
          });
          continue;
        }
        if (
          blocker.status === "done" &&
          goal.status === "blocked" &&
          goal.blocked_reason.startsWith(GOAL_BLOCKED_BY_PREFIX)
        ) {
          await doTransition(goal.goal_id, "active", {
            at: now,
            reason: "等着的那件已经完成",
            eventId: "dep-done:" + textHash(goal.goal_id + "|" + blocker.goal_id).slice(0, 16),
          });
        }
      }
    } catch (err) {
      warn("依赖核对失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  // 4) working 锚：有内容才写，没内容就清（不写占位）。
  const working = buildWorkingState({ goals: Array.from(byId.values()), now });
  if (working) {
    if (typeof store.upsertSoulWorkingState === "function") {
      try {
        await Promise.resolve(store.upsertSoulWorkingState.call(store, tenant, working));
        result.working = true;
        result.focusChars = working.current_focus.length;
      } catch (err) {
        warn("working 锚写入失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }
  } else if (typeof store.clearSoulWorkingState === "function") {
    try {
      await Promise.resolve(store.clearSoulWorkingState.call(store, tenant, { sessionId: "" }));
    } catch (err) {
      warn("working 锚清理失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }
  return result;
}
