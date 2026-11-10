/**
 * P6 叙事 / 巩固 / 遗忘（spec §4.8）。
 *
 * 自传不是事件列表，是章节：一周一章，每章必须有 1–3 条能回到 soul_events 的证据。
 * 三条口径都是可断言的：
 *  - 只巩固「已结束的自然周」（UTC 周一 00:00 起算）：周期没走完就写，等于边写边改同一章，
 *    幂等也就没了。按月等太久——活跃的租户要等一整月才看见第一行自传，故改按周。
 *  - 同一 period 只有一条 active：内容变了才升版本（version + supersedes_id），旧行留给审计。
 *  - 遗忘是停止注入、不删行：salience 按 period_end 衰减，低于注入门的章仍可查。
 *
 * 常量全部写死（用户拍板：不新增配置项/开关/环境变量）。
 */

import { createHash } from "node:crypto";

import { KIND_ZH } from "./episode.js";
import type {
  SoulNarrativeEvidenceInsert,
  SoulNarrativeEvidenceRow,
  SoulNarrativeInsert,
  SoulNarrativeRow,
} from "../store/soul-event-types.js";
import type { SoulEventRow } from "../store/soul-event-types.js";
import type { CoreTenant } from "../store/types.js";
import type { SoulEpisode } from "./types.js";

/** 一个章节周期 = 一个自然周（UTC 周一 00:00:00 起，到下一个周一 00:00:00 止）。 */
export const NARRATIVE_PERIOD_DAYS = 7;
/** 一次最多巩固 26 个已结束周（约半年，接近旧的「最多 7 个月」自传视野）。 */
export const NARRATIVE_MAX_CHAPTERS = 26;
/** 每章证据上限；下限由「没有证据就不成章」保证。 */
export const NARRATIVE_MAX_EVIDENCE = 3;
/** 显著度半衰期：半年减半。旧章不是立刻消失，是慢慢淡出注入口。 */
export const NARRATIVE_SALIENCE_HALF_LIFE_DAYS = 180;
/** 注入门：有效显著度低于此值就停止注入（行还在库里）。 */
export const NARRATIVE_INJECT_MIN_SALIENCE = 0.35;
/** 一次最多注入 2 章（自传是背景，不是正文）。 */
export const NARRATIVE_INJECT_MAX_LINES = 2;
/** 章节摘要上限。 */
export const NARRATIVE_SUMMARY_MAX_CHARS = 600;
/** 注入单行上限。 */
export const NARRATIVE_LINE_MAX_CHARS = 140;

const DAY_MS = 86_400_000;

function clip(text: string, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 所在自然周的周一 00:00:00.000Z（章节周期起点，确定性、与运行时刻无关）。 */
function weekStartOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(dayStart - sinceMonday * DAY_MS).toISOString();
}

function nextWeekStart(weekStart: string): string {
  return new Date(Date.parse(weekStart) + NARRATIVE_PERIOD_DAYS * DAY_MS).toISOString();
}

/** 相对 now 往前推 n 个自然周（巩固窗口起点）。 */
export function narrativeWindowStart(now: string, periods = NARRATIVE_MAX_CHAPTERS): string {
  const start = weekStartOf(now);
  if (start === null) return new Date(0).toISOString();
  return new Date(Date.parse(start) - periods * NARRATIVE_PERIOD_DAYS * DAY_MS).toISOString();
}

/** 事件在章节里的排序权重：情绪/冲突类比日常任务更值得被记住。kind 权重只做排序，不做评价。 */
const KIND_WEIGHT: Record<string, number> = {
  value_conflict: 1,
  divergence: 0.9,
  correction: 0.85,
  complaint: 0.8,
  resignation: 0.75,
  decision: 0.7,
  praise: 0.65,
  pressure: 0.6,
  affect: 0.55,
  work: 0.4,
};

function episodeWeight(ep: SoulEpisode): number {
  const kindW = KIND_WEIGHT[ep.kind] ?? 0.5;
  const stanceW = (ep.userStance ? 0.1 : 0) + (ep.agentStance ? 0.1 : 0) + (ep.cost ? 0.08 : 0);
  return kindW * 0.6 + clamp01(ep.intensity) * 0.4 + stanceW;
}

function sentenceFor(ep: SoulEpisode): string {
  const day = (ep.day && ep.day.length >= 10 ? ep.day : ep.at).slice(5, 10);
  let s = day + "：" + clip(ep.title || ep.object || "一件事", 60);
  if (ep.userStance) s += "，你说「" + clip(ep.userStance, 40) + "」";
  if (ep.agentStance) s += "，我回「" + clip(ep.agentStance, 40) + "」";
  if (ep.outcome) s += "，后来" + clip(ep.outcome, 40);
  return s;
}

function buildSummary(evidenceChronological: SoulEpisode[]): string {
  let out = "";
  for (const ep of evidenceChronological) {
    const s = sentenceFor(ep);
    if (out === "") out = s;
    else if (out.length + 1 + s.length <= NARRATIVE_SUMMARY_MAX_CHARS) out += "；" + s;
    else break;
  }
  return clip(out, NARRATIVE_SUMMARY_MAX_CHARS);
}

function buildTitle(periodLabel: string, evidence: SoulEpisode[]): string {
  const counts = new Map<string, number>();
  for (const ep of evidence) counts.set(ep.kind, (counts.get(ep.kind) ?? 0) + 1);
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = ranked.slice(0, 2).map(([kind, n]) => (KIND_ZH[kind as keyof typeof KIND_ZH] ?? kind) + " " + n);
  return periodLabel + "：" + parts.join(" · ");
}

function buildTurningPoints(evidenceChronological: SoulEpisode[]): string {
  const points: Array<{ at: string; from: string; to: string; text: string }> = [];
  for (let i = 1; i < evidenceChronological.length; i += 1) {
    const prev = evidenceChronological[i - 1]!;
    const cur = evidenceChronological[i]!;
    if (prev.kind === cur.kind) continue;
    const from = KIND_ZH[prev.kind] ?? prev.kind;
    const to = KIND_ZH[cur.kind] ?? cur.kind;
    points.push({
      at: cur.at,
      from: prev.kind,
      to: cur.kind,
      text: cur.day.slice(5, 10) + " " + from + "→" + to,
    });
  }
  return JSON.stringify(points);
}

function buildLessons(evidenceChronological: SoulEpisode[]): string {
  const lessons = evidenceChronological
    .filter((ep) => (ep.cost ?? "").trim() !== "")
    .map((ep) => ({
      at: ep.at,
      lesson: "在「" + clip(ep.object || ep.title, 40) + "」上付了代价：" + clip(ep.cost, 60),
    }));
  return JSON.stringify(lessons);
}

/**
 * 显著度：证据多、情绪强、有转折的周期底分更高。
 * 0.25 起步；每条证据 +0.12；平均强度最多 +0.30；有转折 +0.08。
 */
function chapterSalience(evidence: SoulEpisode[], hasTurning: boolean): number {
  const avgIntensity = evidence.length === 0 ? 0 : evidence.reduce((s, e) => s + clamp01(e.intensity), 0) / evidence.length;
  return clamp01(0.25 + 0.12 * evidence.length + 0.3 * avgIntensity + (hasTurning ? 0.08 : 0));
}

export interface NarrativeChapterPlan {
  chapter: SoulNarrativeInsert;
  /** 证据按显著度降序（与 chapter.summary 的时间顺序不同：排序是「记住哪条」，摘要读起来要按天）。 */
  evidence: SoulNarrativeEvidenceInsert[];
  /** 这一版要标 superseded 的旧 active 章节（同周期，可能不止一条脏数据）。 */
  supersedesIds: string[];
}

export interface NarrativeDerivation {
  /** 实际考虑过的已结束周期数（≤26 周）。 */
  periods: number;
  /** 有事件但回不到 soul_events、因此没成章的周期数。 */
  skippedNoEvidence: number;
  /**
   * 落在未结束周期的 episode 条数（按 episode 计，不是周期数）：
   * 周期由 episode 的 at 归属，该周还没走完（nextWeekStart > now）就整条跳过，等下周再巩固。
   */
  skippedUnclosed: number;
  /** 内容 hash 与旧 active 相同、不需要重写的周期数。 */
  reasserted: number;
  chapters: NarrativeChapterPlan[];
}

/**
 * 租户前缀：sha1(team|user|agent) 前 8 位。
 *
 * chapter_id 是 soul_narrative 的全局主键（soul-event-ddl.ts:390），不区分租户；同一周
 * 四个租户都算「narr-<period>-v1」时，第二个及之后的 INSERT OR IGNORE 一行都不写，
 * 章与证据被静默丢掉。前缀只解决唯一性，不改变「同租户同周期一条 active」的索引口径。
 */
export function narrativeTenantTag(tenant: CoreTenant): string {
  const raw = String(tenant.teamId ?? "") + "|" + String(tenant.userId ?? "") + "|" + String(tenant.agentId ?? "");
  return createHash("sha1").update(raw).digest("hex").slice(0, 8);
}

/**
 * 事件 → 章节计划（纯函数，不碰库）。
 *
 * previous 只需传同期的 active 行：同 hash 计 reasserted，不同 hash 升版本并取代它。
 * eventIds 是「真实存在的事件 id 集合」：证据回不去事件就不写，绝不用 episode 自己当证据。
 */
export function deriveNarrativeChapters(args: {
  episodes: SoulEpisode[];
  eventIds: ReadonlySet<string>;
  previous?: SoulNarrativeRow[];
  now?: string;
  /**
   * 租户前缀（见 narrativeTenantTag）——chapter_id 在库里是**全局主键**，不带租户就会被
   * 后一个租户的 INSERT OR IGNORE 静默吞掉（生产实测：四个租户同一周只有一章落库）。
   */
  tenantTag?: string;
}): NarrativeDerivation {
  const now = args.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const out: NarrativeDerivation = { periods: 0, skippedNoEvidence: 0, skippedUnclosed: 0, reasserted: 0, chapters: [] };

  const groups = new Map<string, { start: string; end: string; episodes: SoulEpisode[] }>();
  for (const ep of args.episodes ?? []) {
    if (!ep || typeof ep.episodeId !== "string" || ep.episodeId === "") continue;
    const start = weekStartOf(ep.at);
    if (start === null) continue;
    const end = nextWeekStart(start);
    if (Date.parse(end) > nowMs) {
      out.skippedUnclosed += 1;
      continue;
    }
    const group = groups.get(start);
    if (group) group.episodes.push(ep);
    else groups.set(start, { start, end, episodes: [ep] });
  }

  const periods = Array.from(groups.values())
    .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0))
    .slice(0, NARRATIVE_MAX_CHAPTERS);
  out.periods = periods.length;

  const previous = args.previous ?? [];
  const tag = args.tenantTag ? String(args.tenantTag) + "-" : "";
  for (const period of periods) {
    // 同一 episode 被重复挖出来（refresh）只算一条证据：证据是「这件事」，不是「这条记录」。
    const seen = new Set<string>();
    const eligible: SoulEpisode[] = [];
    for (const ep of period.episodes) {
      if (seen.has(ep.episodeId)) continue;
      seen.add(ep.episodeId);
      if (!args.eventIds.has(ep.episodeId)) continue;
      eligible.push(ep);
    }
    if (eligible.length === 0) {
      out.skippedNoEvidence += 1;
      continue;
    }

    const ranked = eligible.slice().sort((a, b) => episodeWeight(b) - episodeWeight(a));
    const picked = ranked.slice(0, NARRATIVE_MAX_EVIDENCE);
    const chronological = picked.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const periodKey = period.start.slice(0, 10);
    const periodLabel = periodKey + " 那周";
    const summary = buildSummary(chronological);
    const title = buildTitle(periodLabel, picked);
    const turningPoints = buildTurningPoints(chronological);
    const hasTurning = JSON.parse(turningPoints).length > 0;
    const hash = createHash("sha1")
      .update(period.start + "|" + title + "|" + summary + "|" + picked.map((e) => e.episodeId).join(","))
      .digest("hex")
      .slice(0, 16);

    const prevActive = previous
      .filter((row) => row.period_start === period.start && row.status === "active")
      .sort((a, b) => b.version - a.version);
    if (prevActive.some((row) => row.hash === hash)) {
      out.reasserted += 1;
      continue;
    }
    const version = prevActive.length > 0 ? Math.max(...prevActive.map((row) => row.version)) + 1 : 1;
    const plan: NarrativeChapterPlan = {
      chapter: {
        chapter_id: "narr-" + tag + periodKey + "-v" + version,
        period_start: period.start,
        period_end: period.end,
        title,
        summary,
        turning_points_json: turningPoints,
        lessons_json: buildLessons(chronological),
        version,
        hash,
        supersedes_id: prevActive[0]?.chapter_id ?? null,
        status: "active",
        created_at: now,
        salience: chapterSalience(picked, hasTurning),
      },
      evidence: picked.map((ep) => ({ chapter_id: "narr-" + tag + periodKey + "-v" + version, event_id: ep.episodeId })),
      supersedesIds: prevActive.map((row) => row.chapter_id),
    };
    out.chapters.push(plan);
  }
  return out;
}

/**
 * 有效显著度 = 底分 × 半衰期衰减 × access 强化。
 *
 * 锚是 period_end 而不是 created_at：否则旧周期刚写出来就满显著，而它其实已经过去很久了。
 * access 加成有上限（1.4 倍），被反复想起也不会把旧章顶成新章。
 */
export function narrativeDecayedSalience(row: SoulNarrativeRow, nowIso?: string): number {
  const nowMs = Date.parse(nowIso ?? new Date().toISOString());
  const anchorMs = Date.parse(row.period_end) || Date.parse(row.created_at) || nowMs;
  const ageDays = Math.max(0, (nowMs - anchorMs) / DAY_MS);
  const decay = Math.pow(0.5, ageDays / NARRATIVE_SALIENCE_HALF_LIFE_DAYS);
  const access = Math.min(10, Math.max(0, Math.trunc(row.access_count ?? 0)));
  const boost = Math.min(1.4, 1 + 0.04 * access);
  return clamp01(clamp01(row.salience) * decay * boost);
}

export interface NarrativeInjectionLine {
  chapterId: string;
  text: string;
  /** 注入时的有效显著度（审计用：为什么这章进了/没进）。 */
  salience: number;
  /** 证据 id：注入行不展开证据（正文太长），由面板按 chapterId 回查。 */
  evidenceIds: string[];
}

/** 章节 → 注入行：只取 active、过门的，按有效显著度降序，最多 2 条。 */
export function narrativeInjectionLines(
  rows: SoulNarrativeRow[],
  opts: { now?: string; limit?: number; minSalience?: number } = {},
): NarrativeInjectionLine[] {
  const now = opts.now ?? new Date().toISOString();
  const min = opts.minSalience ?? NARRATIVE_INJECT_MIN_SALIENCE;
  const limit = Math.max(1, Math.trunc(opts.limit ?? NARRATIVE_INJECT_MAX_LINES));
  return (rows ?? [])
    .filter((row) => row.status === "active")
    .map((row) => ({ row, salience: narrativeDecayedSalience(row, now) }))
    .filter((x) => x.salience >= min)
    .sort((a, b) => b.salience - a.salience)
    .slice(0, limit)
    .map((x) => ({
      chapterId: x.row.chapter_id,
      text: clip(x.row.title + "｜" + (x.row.summary.split("；")[0] ?? ""), NARRATIVE_LINE_MAX_CHARS),
      salience: x.salience,
      evidenceIds: [],
    }));
}

export interface NarrativeStorePort {
  listSoulEpisodes?: (tenant: CoreTenant, filter?: { limit?: number; includeArchived?: boolean }) => SoulEpisode[] | Promise<SoulEpisode[]>;
  listSoulEvents?: (tenant: CoreTenant, filter?: { atFrom?: string; limit?: number; offset?: number; order?: "asc" | "desc"; includeArchived?: boolean }) => SoulEventRow[] | Promise<SoulEventRow[]>;
  listSoulNarrativeChapters?: (tenant: CoreTenant, filter?: { status?: "active" | "superseded"; limit?: number; offset?: number }) => SoulNarrativeRow[] | Promise<SoulNarrativeRow[]>;
  listSoulNarrativeEvidence?: (tenant: CoreTenant, chapterId: string) => SoulNarrativeEvidenceRow[] | Promise<SoulNarrativeEvidenceRow[]>;
  commitSoulNarrativeChapter?: (
    tenant: CoreTenant,
    input: { chapter: SoulNarrativeInsert; evidence: SoulNarrativeEvidenceInsert[]; supersedeIds?: string[] },
  ) => { inserted: boolean; superseded: number } | Promise<{ inserted: boolean; superseded: number }>;
}

export interface NarrativeMaintenanceResult {
  /** 考虑过的已结束周期数（周）。 */
  periods: number;
  /** 新写的章节数。 */
  created: number;
  /** 被新版本取代的旧章节数。 */
  superseded: number;
  /** 同 hash 重放、不需要重写的周期数。 */
  reasserted: number;
  /** 有事件但回不到 soul_events 的周期数。 */
  skippedNoEvidence: number;
  /** 落在未结束周期、本轮不巩固的 episode 条数（按 episode 计，不是周期数；划分依据是 episode 的 at 所在周有没有走完）。 */
  skippedUnclosed: number;
  /** 落入证据关系的行数。 */
  evidence: number;
}

/**
 * 事件 id 集合：从窗口起点起按页取，最多 4 页（2000 条）；取不到的按「回不到事件」处理，不猜。
 *
 * 必须 includeArchived：事件「遗忘」只是停止注入、行还在（tick 里的巩固/归档会写 archived_at），
 * 章节证据要回得到事件，就不能把已归档的事件当成不存在。
 */
async function collectEventIds(
  store: NarrativeStorePort,
  tenant: CoreTenant,
  windowStart: string,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  if (typeof store.listSoulEvents !== "function") return ids;
  const pageSize = 500;
  for (let page = 0; page < 4; page += 1) {
    const rows = await Promise.resolve(
      store.listSoulEvents.call(store, tenant, {
        atFrom: windowStart,
        limit: pageSize,
        offset: page * pageSize,
        includeArchived: true,
      }),
    );
    const list = rows ?? [];
    for (const row of list) ids.add(String(row.event_id ?? ""));
    if (list.length < pageSize) break;
  }
  return ids;
}

/**
 * 维护 tick 的写者：读事件/章节 → 派生 → 逐章提交（每章一个事务）。
 *
 * 缺能力（没有章节写者）时返回零值，不写半套；单章失败只 warn，不阻断 tick。
 */
export async function runNarrativeMaintenance(args: {
  store: NarrativeStorePort;
  tenant: CoreTenant;
  episodes?: SoulEpisode[];
  now?: string;
  logger?: { warn?: (msg: string) => void };
}): Promise<NarrativeMaintenanceResult> {
  const { store, tenant } = args;
  const now = args.now ?? new Date().toISOString();
  const warn = (msg: string): void => args.logger?.warn?.("[soul-narrative] " + msg);
  const result: NarrativeMaintenanceResult = {
    periods: 0,
    created: 0,
    superseded: 0,
    reasserted: 0,
    skippedNoEvidence: 0,
    skippedUnclosed: 0,
    evidence: 0,
  };
  const commit = store.commitSoulNarrativeChapter;
  const listChapters = store.listSoulNarrativeChapters;
  if (typeof commit !== "function" || typeof listChapters !== "function") return result;

  let episodes = args.episodes;
  if (!episodes) {
    if (typeof store.listSoulEpisodes !== "function") return result;
    episodes = (await Promise.resolve(store.listSoulEpisodes.call(store, tenant, { limit: 2000, includeArchived: true }))) ?? [];
  }

  const windowStart = narrativeWindowStart(now);
  const eventIds = await collectEventIds(store, tenant, windowStart);
  const previous = (await Promise.resolve(listChapters.call(store, tenant, { status: "active", limit: 50 }))) ?? [];
  const tenantTag = narrativeTenantTag(tenant);
  const derived = deriveNarrativeChapters({ episodes, eventIds, previous, now, tenantTag });
  result.periods = derived.periods;
  result.reasserted = derived.reasserted;
  result.skippedNoEvidence = derived.skippedNoEvidence;
  result.skippedUnclosed = derived.skippedUnclosed;

  let planIgnored = 0;
  for (const plan of derived.chapters) {
    try {
      const written = await Promise.resolve(
        commit.call(store, tenant, {
          chapter: plan.chapter,
          evidence: plan.evidence,
          supersedeIds: plan.supersedesIds,
        }),
      );
      if (written?.inserted) {
        result.created += 1;
        result.evidence += plan.evidence.length;
      }
      result.superseded += Number(written?.superseded ?? 0);
      if (written && !written.inserted) planIgnored += 1;
    } catch (err) {
      warn(String(plan.chapter.chapter_id) + " 写入失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }
  // 全被「已存在」吞掉、且没有一章是重放（reasserted=0）→ 大概率是 chapter_id 跨租户撞主键。
  // 这条 warn 是那类静默丢章的唯一线索：inserted=false 本身分不清「重放」和「被忽略」。
  if (derived.chapters.length > 0 && result.created === 0 && result.superseded === 0 && planIgnored > 0 && result.reasserted === 0) {
    warn("本轮 " + planIgnored + " 章全部未写入（inserted=false 且非重放），检查 chapter_id 是否跨租户冲突");
  }
  return result;
}
