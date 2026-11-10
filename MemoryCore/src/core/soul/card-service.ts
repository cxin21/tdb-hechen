import type { CoreTenant, IMemoryStore, SoulPersonRelationRow, SoulSnapshotRow } from "../store/types.js";
import type { AgentProfileLike } from "./agent-profile.js";
import { clampRedlines, type CardRedline, type CardSegment } from "./card.js";
import {
  CARD_V13_SCHEMA_VERSION,
  buildCardSegmentsV13,
  renderPersonaCardV13,
  type CardV13BlockMeta,
  type CardV13Line,
  type CardV13Mood,
  type CardV13PersonState,
  type CardV13Source,
  type CardV13Structured,
  type SoulCardV13Input,
} from "./card-v13.js";
import { renderMoodLine, type SoulMoodState } from "./emotion.js";
import { selfModelCardLines } from "./self-model.js";
import { renderSoulTurnState } from "./turn-state.js";
import { NARRATIVE_INJECT_MAX_LINES, NARRATIVE_MAX_EVIDENCE, narrativeInjectionLines } from "./narrative.js";
import type { TraitLabelRow } from "./trait-drift.js";
import {
  HUMAN_MAX_LINES,
  OPEN_LOOPS_MAX,
  TRAIT_TOP_N,
  emptyAxisVector,
  projectLabels,
  seedStateFromSeeds,
  SEED_LABELS,
  type AxisVector,
  type TraitLabelView,
} from "./traits.js";
import type { PersonaItem, SoulLayer } from "./types.js";
import { PROFILE_SOURCE, isProfileFieldStale, isPersonProfileField } from "../person/profile.js";

/**
 * 卡组装（S2）：把「表单设定 + 层条目 + 特质投影 + 心境/未完的事」拼成两通道的文本。
 *
 * 两条铁律：
 *   1) 只读渲染——assembleSoulCard({persist:false}) 不写任何表，GET 端点据此做到无副作用。
 *   2) 落账只在 tick 末——persist:true 且 hash/正文与上一版不同，才追加 soul_snapshots 一行。
 *      v13 没有「权重变化 < 0.05 复用上一版」的旁路：正文由九块按同一份输入确定性渲染。
 *
 * 卡本体（通道 A）是 v13 九块散文（card-v13.ts），不含 openLoops：那段是通道 B 每轮随心境一起拼的。
 */

export interface SoulCardAssembly {
  version: number;
  hash: string;
  text: string;
  chars: number;
  /**
   * 身份段（注入在最前面的稳定段）：读法常量 + 第一眼/性格/说话/边界，≤1000 字。
   * 超限先丢说话再丢性格；红线逐条 verbatim，永不因这段的预算被删。
   * 与 `text` 的关系：`text` 是整卡，identity 是它的**投影**，不是切下来的一段——
   * 生活/我们/现在/记得/最近的变化只存在于 `text` 里。
   */
  identity: CardSegment;
  /**
   * 末尾锚（每轮末尾的极短复述）：第一眼前 2 行 + 红线最后 ≤2 条 + 现在第 1 行，≤460 字。
   * 空时 `text:"" / chars:0 / hash:""`，原因见其 warnings（不塞占位标题）。
   */
  anchor: CardSegment;
  labels: Array<{ label: string; act: number; gloss?: string }>;
  warnings: string[];
  /** 块 id → 来源。九块（省略的块记 "absent"）。 */
  sources: Record<string, CardV13Source>;
  /** 九块的元数据（id/标题/字数/来源/置信/证据回指/块级警告）。 */
  blocks: CardV13BlockMeta[];
  /** 渲染器版本。 */
  schema: "13";
  /** 渲染结果与上一版快照不同（tick 会因此追加一行）。 */
  dirty: boolean;
  /** 底色是否非空：判据 10 的「有底色」依据。 */
  seeded: boolean;
  /** 卡快照的元信息（写进 payload_json 的 meta，可审计；不参与注入正文）。 */
  meta: { nameSource: SoulCardNameSource };
}

/**
 * 名字只认一级：declared ── 表单声明（meta_agent_persona.name）。
 * 没有声明就渲染骨架「（未命名）」+ 保留一句 warning。
 *
 * 2026-11-07 复核（task-27/A1）：原来的第三级「观察」已删除——从 L1 里用
 * `我叫X / 叫我X / 我的名字是X` 猜 agent 的名字，会把 assistant **解释正则**的
 * 正文当成自述（生产 agt-bbr29z58s2 的名字因此被换成了正则解释里的那个词）。名字是身份声明，
 * 只能由人在表单里给；从对话里推断等于把「谁」交给一句恰好匹配的话。
 */
export type SoulCardNameSource = "declared" | "skeleton";

export interface SoulTurnAssembly {
  text: string;
  openLoops: string[];
}

export interface SoulCardStorePort {
  listSoulPersona?: IMemoryStore["listSoulPersona"];
  /** P2：结构化的「谁—什么关系—谁」事实（卡的 relationship 段按 persons 过滤后只读这里）。 */
  listSoulPersonRelations?: IMemoryStore["listSoulPersonRelations"];
  /** P2：person_key → 展示名（唯一名字来源；解析不到就省略关系行，不回退 obj_name）。 */
  listSoulPersons?: IMemoryStore["listSoulPersons"];
  readSoulTraitState?: IMemoryStore["readSoulTraitState"];
  listSoulTraitLabels?: IMemoryStore["listSoulTraitLabels"];
  readLastSoulSnapshot?: IMemoryStore["readLastSoulSnapshot"];
  writeSoulSnapshot?: IMemoryStore["writeSoulSnapshot"];
  readSoulState?: IMemoryStore["readSoulState"];
  listSoulPromises?: IMemoryStore["listSoulPromises"];
  /** P5：慢心境当前行；缺实现时「现在」回退 soul_state 的即时读数（标 derived）。 */
  readSoulMoodState?: IMemoryStore["readSoulMoodState"];
  /** P2：连续关系状态（信任/亲近/尊重/亏欠）；只写有行的轴，缺行不补默认值。 */
  listSoulPersonStates?: IMemoryStore["listSoulPersonStates"];
  /** P3：本轮工作锚；读侧按 now 过滤过期行。 */
  getSoulWorkingState?: IMemoryStore["getSoulWorkingState"];
  /** P3：目标层；卡只接 active/blocked，终态不复活。 */
  listSoulGoals?: IMemoryStore["listSoulGoals"];
  /** P4：自我模型；低置信度行进 memory 块并自带「（推测）/（没验过）」。 */
  listSoulSelfModel?: IMemoryStore["listSoulSelfModel"];
  /** P4：校准原始行；卡面与每轮尾巴按域写把握度（数字可由这些行复算）。 */
  listSoulCalibration?: IMemoryStore["listSoulCalibration"];
  /** P6：自传章节（只取 active 且过显著度门；低显著章仍可按 chapterId 查到，只是不注入）。 */
  listSoulNarrativeChapters?: IMemoryStore["listSoulNarrativeChapters"];
  /** P6：章节 → 事件 id，卡面据此把自传指回 soul_events。 */
  listSoulNarrativeEvidence?: IMemoryStore["listSoulNarrativeEvidence"];
  /** P6：注入记账（只在 persist 的 tick 路径调用，GET 卡无副作用）。 */
  touchSoulNarrativeAccess?: IMemoryStore["touchSoulNarrativeAccess"];
}

export interface AssembleSoulCardOptions {
  store: SoulCardStorePort;
  tenant: CoreTenant;
  readAgentProfile?: (agentId: string) => Promise<AgentProfileLike | null>;
  now?: string;
  /** true = tick 末落快照；false = 纯读（HTTP GET）。 */
  persist?: boolean;
  /**
   * 在场者 person_key 列表（阶段 2 / P2-A）：只保留这些人的「关于你」行 + 全局共性行。
   * `undefined` = 不按人过滤（旧行为，逐字节不变）；`[]` = 只留全局共性行。
   */
  persons?: string[];
}

/** 层条目 → 卡行：只取还能进注入的状态，最近的在前，去重、截断、单行化。 */
export function cardLinesFromItems(
  items: ReadonlyArray<PersonaItem>,
  layers: ReadonlyArray<SoulLayer>,
  maxLines = HUMAN_MAX_LINES,
): string[] {
  const wanted = new Set<string>(layers);
  const rows = items
    .filter((i) => wanted.has(i.layer))
    .filter((i) => i.state === "active" || i.state === "degraded")
    .sort((a, b) => (a.lastEvidenceAt < b.lastEvidenceAt ? 1 : a.lastEvidenceAt > b.lastEvidenceAt ? -1 : 0));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = String(row.text ?? "").replace(/\s+/gu, " ").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxLines) break;
  }
  return out;
}

function toLabelViews(
  rows: ReadonlyArray<TraitLabelRow>,
  declared: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
): TraitLabelView[] {
  return rows.map((r) => ({
    label: r.label,
    direction: r.direction,
    act: 0,
    evidence: r.evidence,
    status: r.status,
    ...(declared.has(r.label)
      ? { declared: true, ...(weights.has(r.label) ? { declaredWeight: weights.get(r.label) as number } : {}) }
      : {}),
    // 卡的 gloss 只认库里这一份（含自生长标签）；空串=没写，交给 card.ts 回退种子。
    ...(r.gloss ? { gloss: r.gloss } : {}),
  }));
}

/** 已落库卡的元信息（v12/v13 都按这几个字段认；旧 slot 快照不算）。 */
export interface ParsedCardSnapshot {
  version: number;
  hash: string;
  text: string;
  chars: number;
  acts: Record<string, unknown>;
  labels: unknown[];
  warnings: string[];
  signature: string;
}

/** 上一版卡的 payload 解析；不是卡快照（旧 slot 快照）就当没有上一版。 */
export function parsePreviousCard(row: SoulSnapshotRow | null | undefined): ParsedCardSnapshot | null {
  if (!row?.payload_json) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as { kind?: string } & Partial<ParsedCardSnapshot>;
    if (parsed?.kind !== "persona-card") return null;
    if (typeof parsed.text !== "string" || typeof parsed.hash !== "string") return null;
    return {
      version: typeof parsed.version === "number" ? parsed.version : Number(row.version ?? 0),
      hash: parsed.hash,
      text: parsed.text,
      chars: typeof parsed.chars === "number" ? parsed.chars : parsed.text.length,
      acts: parsed.acts ?? {},
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      signature: typeof parsed.signature === "string" ? parsed.signature : "",
    };
  } catch {
    return null;
  }
}

/** 读最近一版已落库卡的元信息（version/hash/chars）；无卡或旧格式快照 → null。 */
export async function readPersistedCardMeta(
  store: SoulCardStorePort,
  tenant: CoreTenant,
): Promise<{ version: number; hash: string; chars: number } | null> {
  try {
    if (typeof store.readLastSoulSnapshot !== "function") return null;
    const row = await store.readLastSoulSnapshot(tenant);
    const prev = parsePreviousCard(row ?? null);
    if (!prev) return null;
    return { version: prev.version, hash: prev.hash, chars: prev.chars };
  } catch {
    return null;
  }
}

/**
 * buildCardInput 的输出：只做「层条目 → 卡行」的过滤与单行化，不渲染。
 * v13 的 renderPersonaCardV13 自己消费 human/relationship 行与 profileWarnings；
 * 其余字段（selfHistory/autobiography/labels/state）保留给 buildCardInput 的
 * 既有调用方（卡行过滤的单测与关系 fail-closed 单测）。
 */
export interface CardInput {
  profile: {
    name: string;
    nameSource: "declared" | "skeleton";
    pronoun?: string;
    selfImage?: string;
    voice?: string;
    purpose?: string;
    redlines?: CardRedline[];
  };
  labels: ReturnType<typeof projectLabels>;
  human?: string[];
  relationship?: string[];
  selfHistory?: string[];
  autobiography?: string;
  version: number;
  state?: AxisVector;
  /** A7：过期字段与结构化关系警告。 */
  profileWarnings?: string[];
}

export function buildCardInput(args: {
  profile: AgentProfileLike | null;
  labels: ReturnType<typeof projectLabels>;
  items: ReadonlyArray<PersonaItem>;
  version: number;
  state?: AxisVector;
  /** person_key 列表；undefined = 不按人过滤（向后兼容）。 */
  persons?: string[];
  /**
   * P2：按人过滤时关系段的唯一来源（由 assembleSoulCard 从 soul_person_relation 读好后传入）。
   * persons===undefined 时忽略；已给 persons 但没给这里 = 关系段为空（fail-closed，不漏全局 persona 行）。
   */
  structuredRelationship?: string[];
  /** P2：结构化关系层的 warnings（person_unresolved 等），与 profileWarnings 合并进卡。 */
  structuredWarnings?: string[];
  /** A7：判定档案行 TTL 的「现在」；缺省取当前时间。 */
  now?: string;
}): CardInput {
  const { profile, labels, items, version, state, persons } = args;
  const nowIso = args.now ?? new Date().toISOString();
  const narrative = cardLinesFromItems(items, ["narrative"], HUMAN_MAX_LINES);
  // per-person 过滤（P2-A）：
  //   - persons === undefined → 不过滤（旧行为，输出必须逐字节不变）；
  //   - meta.person.key === ""（或读不到）→ 全局共性行，恒在场；
  //   - 其它行只有 person_key 在 persons 里才在场。
  const personFilter = (it: PersonaItem): boolean => {
    if (persons === undefined) return true;
    const key = personKeyOfItem(it);
    if (key === "") return true;
    return persons.includes(key);
  };

  // A7：人物档案行按字段 TTL 判过期——过期不渲染（不是删行：库里留着做审计与「后来又被提到」的复活），
  // 过期字段名以 `profile_stale:<field>` 进 warnings，让调用方看得出「档案里少了哪一栏、为什么少」。
  const staleFields = new Set<string>();
  const freshFilter = (it: PersonaItem): boolean => {
    const meta = it.meta as { source?: unknown; profileField?: unknown; evidence?: unknown } | undefined;
    if (!meta || meta.source !== PROFILE_SOURCE) return true;
    if (!isPersonProfileField(meta.profileField)) return true;
    const field = meta.profileField;
    const evidence = Array.isArray(meta.evidence) ? meta.evidence : [];
    const first = evidence[0] as { at?: unknown } | undefined;
    const evidenceAt = typeof first?.at === "string" && first.at !== "" ? first.at : it.updatedAt;
    if (!isProfileFieldStale({ field, evidenceAt, nowIso })) return true;
    staleFields.add(field);
    return false;
  };

  // 名字只认声明（task-27/A1）：观察名通道已删，参数里不再有第二来源。
  const resolvedName = profile?.name?.trim() ?? "";
  const input: CardInput = {
    profile: {
      name: resolvedName,
      nameSource: resolvedName !== "" ? "declared" : "skeleton",
      ...(profile?.pronoun ? { pronoun: profile.pronoun } : {}),
      ...(profile?.selfImage ? { selfImage: profile.selfImage } : {}),
      ...(profile?.voice ? { voice: profile.voice } : {}),
      ...(profile?.purpose ? { purpose: profile.purpose } : {}),
      // 红线在 v13 的边界块里 clamp（≤30 行/单行≤120/总≤2600），这里只透传 active。
      ...(profile?.redlines?.length ? { redlines: profile.redlines.filter((r) => r.active) } : {}),
    },
    labels,
    human: cardLinesFromItems(
      filterPersonaItems(items, ["human"], (it) => personFilter(it) && freshFilter(it)),
      ["human"],
      HUMAN_MAX_LINES,
    ),
    // P2：一旦按人过滤，relationship 只能来自结构化关系边（soul_person_relation）。
    // 旧的 persona relationship 行 `meta.object` 是展示名（「用户」「何晨」）而不是 person_key，
    // 在这里继续渲染会把 A 的关系史漏进 B 的卡——按人过滤时宁可空段（fail-closed）。
    // persons===undefined 的旧调用保持逐字节不变（仍读 persona 行）。
    relationship:
      persons === undefined
        ? cardLinesFromItems(items, ["relationship"], HUMAN_MAX_LINES)
        : (args.structuredRelationship ?? []),
    selfHistory: cardLinesFromItems(items, ["identity", "self"], HUMAN_MAX_LINES),
    ...(narrative.length > 0 ? { autobiography: narrative.join("\n") } : {}),
    version,
    ...(state ? { state } : {}),
  };
  const profileWarnings = [
    ...Array.from(staleFields).sort().map((f) => `profile_stale:${f}`),
    ...(args.structuredWarnings ?? []),
  ];
  return profileWarnings.length > 0 ? { ...input, profileWarnings } : input;
}

/**
 * 组装卡（唯一实现路径，spec §11 阶段 3）。
 *
 * 正文是九块（第一眼/生活/性格/说话/我们/现在/记得/边界/最近的变化），读声明层、
 * soul_persona、soul_state、特质投影，以及阶段 2/3 接上的结构化层（person_state、
 * mood_state、working_state、goals、person_relation）。写法受 spec §7 纪律约束：
 * 说「你」不说「用户」、不写 Markdown、不造样品台词、缺来源的块整块省略。
 * 没有 v12 兜底、没有开关：这里返回什么，注入出去的就是什么。
 */
export async function assembleSoulCard(opts: AssembleSoulCardOptions): Promise<SoulCardAssembly> {
  const { store, tenant, readAgentProfile, now = new Date().toISOString(), persist = false, persons } = opts;

  const persisted =
    typeof store.readLastSoulSnapshot === "function"
      ? ((await Promise.resolve(store.readLastSoulSnapshot(tenant))) ?? null)
      : null;
  const previous = parsePreviousCard(persisted);
  const persistedVersion = typeof persisted?.version === "number" ? persisted.version : 0;

  // 表单读不到不该让整张卡消失（fail-open 的一层）：降级为 null，正文只剩观察层与红线。
  let profile: AgentProfileLike | null = null;
  if (readAgentProfile) {
    try {
      profile = (await readAgentProfile(tenant.agentId)) ?? null;
    } catch {
      profile = null;
    }
  }
  const items =
    typeof store.listSoulPersona === "function" ? ((await Promise.resolve(store.listSoulPersona(tenant))) ?? []) : [];
  const traitState =
    typeof store.readSoulTraitState === "function" ? await Promise.resolve(store.readSoulTraitState(tenant)) : null;
  const labelRows =
    typeof store.listSoulTraitLabels === "function"
      ? ((await Promise.resolve(store.listSoulTraitLabels(tenant))) ?? [])
      : [];

  // 底色仍按 v12 的口径投影（声明标签豁免证据门 + 种子兜底）：v13 正文不写数值，
  // 但 labels/seeded 还要如实上报给面板与 trait-state 屏。
  const declared = new Set((profile?.traits ?? []).map((t) => t.label));
  const declaredWeights = new Map((profile?.traits ?? []).map((t) => [t.label, t.weight] as const));
  const rowLabels = new Set(labelRows.map((r) => r.label));
  const views: TraitLabelView[] = [
    ...toLabelViews(labelRows, declared, declaredWeights),
    ...SEED_LABELS.filter((s) => declared.has(s.label) && !rowLabels.has(s.label)).map((s) => ({
      label: s.label,
      direction: s.direction,
      act: 0,
      evidence: 0,
      status: "seed",
      declared: true,
      ...(declaredWeights.has(s.label) ? { declaredWeight: declaredWeights.get(s.label) as number } : {}),
      gloss: s.gloss,
    })),
  ];
  const state = traitState?.state ?? seedStateFromSeeds(profile?.traits ?? []);
  const projected = projectLabels(state, views).slice(0, TRAIT_TOP_N);

  const structured = await readStructuredRelationship(store, tenant, persons);
  // P6 §4.8：自传章节进「最近」块。只取 active 且过显著度门的章（遗忘 = 衰减到门以下停止注入，
  // 不是删行——listSoulNarrativeChapters 仍能查到），最多 2 条；证据按 chapterId 回查事件 id，
  // 这样卡面上的每一章都指得回 soul_events，而不是一段无法核对的自述。
  const narrativeRows =
    typeof store.listSoulNarrativeChapters === "function"
      ? ((await Promise.resolve(store.listSoulNarrativeChapters(tenant, { status: "active", limit: 50 }))) ?? [])
      : [];
  const narrativeLines = narrativeInjectionLines(narrativeRows, { now, limit: NARRATIVE_INJECT_MAX_LINES });
  const chapterEvidence = new Map<string, string[]>();
  if (narrativeLines.length > 0 && typeof store.listSoulNarrativeEvidence === "function") {
    for (const entry of narrativeLines) {
      try {
        const evidence = (await Promise.resolve(store.listSoulNarrativeEvidence(tenant, entry.chapterId))) ?? [];
        const ids = evidence
          .map((row) => String(row.event_id ?? ""))
          .filter((id) => id !== "")
          .slice(0, NARRATIVE_MAX_EVIDENCE);
        if (ids.length > 0) chapterEvidence.set(entry.chapterId, ids);
      } catch {
        // 读不到证据就不带 id（卡面照常，面板可按 chapterId 回查），不阻断组卡。
      }
    }
  }
  // access 记账只在 persist 的 tick 路径发生：GET /v3/soul/card 的无副作用契约不能被「读一次加一次」破坏。
  if (persist && narrativeLines.length > 0 && typeof store.touchSoulNarrativeAccess === "function") {
    try {
      await Promise.resolve(store.touchSoulNarrativeAccess(tenant, narrativeLines.map((entry) => entry.chapterId), { now }));
    } catch {
      // access 只是显著度加成，写失败不影响本次注入。
    }
  }
  const input = buildCardInput({
    profile,
    labels: projected,
    items,
    version: persistedVersion,
    state,
    now,
    ...(persons === undefined ? {} : { persons }),
    ...(structured ? { structuredRelationship: structured.lines, structuredWarnings: structured.warnings } : {}),
  });
  const cardName = profile?.name?.trim() ?? "";
  const nameSource: SoulCardNameSource = cardName !== "" ? "declared" : "skeleton";

  // 行 → 证据回指：buildCardInput 只给字符串，这里按「单行化后的文本」回查同一条 PersonaItem 的
  // evidenceIds。找不到（声明层行、被过滤掉的行）就空着，不硬编一个 id 上去。
  const evidenceIndex = new Map<string, string[]>();
  for (const it of items) {
    const text = String(it.text ?? "").replace(/\s+/gu, " ").trim();
    if (text === "" || evidenceIndex.has(text)) continue;
    const ids = (it.evidenceIds ?? []).slice(0, 3);
    if (ids.length > 0) evidenceIndex.set(text, ids);
  }
  const line = (text: string): CardV13Line => {
    const ids = evidenceIndex.get(text) ?? [];
    return ids.length > 0 ? { text, evidenceIds: ids } : { text };
  };

  // 心境：soul_state 的现值与基线（sampleCount=0 视为还没有状态，不写「还算稳」这种没依据的话）。
  const stateRow =
    typeof store.readSoulState === "function" ? await Promise.resolve(store.readSoulState(tenant)) : null;
  const sampleCount = Number(stateRow?.sampleCount ?? 0);
  const mood: CardV13Mood | null =
    stateRow && sampleCount > 0
      ? {
          valence: Number(stateRow.valence ?? 0),
          arousal: Number(stateRow.arousal ?? 0.3),
          baselineValence: Number(stateRow.baselineValence ?? 0),
          baselineArousal: Number(stateRow.baselineArousal ?? 0.3),
          ...(stateRow.emotionLabel ? { emotionLabel: String(stateRow.emotionLabel) } : {}),
          ...(stateRow.emotionObject ? { emotionObject: String(stateRow.emotionObject) } : {}),
        }
      : null;

  // 阶段 2：结构化层。缺实现/缺行就省略，绝不补默认值或占位文本。
  const structuredFacts = persons === undefined ? null : await readStructuredCardFacts(store, tenant, persons);
  const moodRow =
    typeof store.readSoulMoodState === "function" ? await Promise.resolve(store.readSoulMoodState(tenant)) : null;
  const workingRow =
    typeof store.getSoulWorkingState === "function"
      ? await Promise.resolve(store.getSoulWorkingState(tenant, { now }))
      : null;
  const goalRows =
    typeof store.listSoulGoals === "function"
      ? ((await Promise.resolve(store.listSoulGoals(tenant, { limit: 60 }))) ?? [])
      : [];

  const structuredGoals = goalRows
    .filter((goal) => (goal.status === "active" || goal.status === "blocked") && String(goal.title ?? "").trim() !== "")
    .sort(
      (a, b) =>
        Number(b.priority ?? 0) - Number(a.priority ?? 0) ||
        String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    )
    .slice(0, 4)
    .map((goal) => ({
      goalId: String(goal.goal_id),
      title: String(goal.title).trim(),
      status: goal.status as "active" | "blocked",
      ...(goal.blocked_reason ? { blockedReason: String(goal.blocked_reason) } : {}),
      priority: Number(goal.priority ?? 0),
      ...(goal.source_event_id ? { evidenceIds: [goal.source_event_id] } : {}),
    }));

  const openQuestions = parseStringList(workingRow?.open_questions_json);
  const currentFocus = String(workingRow?.current_focus ?? "").trim();
  const working =
    workingRow && (currentFocus !== "" || openQuestions.length > 0 || workingRow.current_goal_id)
      ? {
          ...(currentFocus !== "" ? { currentFocus } : {}),
          openQuestions,
          ...(workingRow.current_goal_id ? { currentGoalId: String(workingRow.current_goal_id) } : {}),
        }
      : null;

  const moodState = moodRow
    ? {
        label: String(moodRow.label ?? ""),
        valence: Number(moodRow.valence ?? 0),
        arousal: Number(moodRow.arousal ?? 0.3),
        intensity: Number(moodRow.intensity ?? 0),
        causeEventIds: parseIdList(moodRow.cause_event_ids_json),
      }
    : null;

  const structuredInput: CardV13Structured = {
    ...(persons === undefined ? {} : { personScoped: true }),
    ...(structuredFacts && structuredFacts.relations.length > 0 ? { relations: structuredFacts.relations } : {}),
    ...(structuredFacts && structuredFacts.personStates.length > 0
      ? { personStates: structuredFacts.personStates }
      : {}),
    ...(moodState ? { mood: moodState } : {}),
    ...(working ? { working } : {}),
    ...(structuredGoals.length > 0 ? { goals: structuredGoals } : {}),
  };

  // P4 §4.5：自我模型行进 memory（lines.self 的最前面）——低置信度的行自带「（推测）/（没验过）」，
  // 不另开第十块（九块固定会改 spec/预算/卡测）；memory 块只取前 3 行，所以最多放 2 条，留一行给原有 self。
  const selfModelRows =
    typeof store.listSoulSelfModel === "function"
      ? ((await Promise.resolve(store.listSoulSelfModel(tenant, { limit: 20 }))) ?? [])
      : [];
  const selfModelLines: CardV13Line[] = selfModelCardLines(selfModelRows, 2).map((entry) =>
    entry.evidenceIds && entry.evidenceIds.length > 0
      ? { text: entry.text, evidenceIds: entry.evidenceIds }
      : { text: entry.text },
  );

  // P4 §4.5：校准行只给「记得」块用（按域写把握度），不新开第十块；
  // 传原始行而不是 aggregate，句中的次数/均值必须能被读侧复算；
  // 读满 store 上限（5000）而不是默认 500，避免某个域的次数被窗口截断后
  // 卡上写「3 次里成了 3 次」而库里其实有更多次。
  const calibrationRows =
    typeof store.listSoulCalibration === "function"
      ? ((await Promise.resolve(store.listSoulCalibration(tenant, { limit: 5000 }))) ?? [])
      : [];

  const v13Input: SoulCardV13Input = {
    profile: {
      name: cardName,
      nameSource,
      ...(profile?.pronoun ? { pronoun: profile.pronoun } : {}),
      ...(profile?.selfImage ? { selfImage: profile.selfImage } : {}),
      ...(profile?.voice ? { voice: profile.voice } : {}),
      ...(profile?.purpose ? { purpose: profile.purpose } : {}),
      ...(profile?.redlines?.length ? { redlines: profile.redlines.filter((r) => r.active) } : {}),
    },
    lines: {
      human: (input.human ?? []).map(line),
      // 关系行本阶段仍不过滤 person_key（meta.object 存的是展示名，不是 person_key，见 buildCardInput 注释）。
      relationship: (input.relationship ?? []).map(line),
      identity: cardLinesFromItems(items, ["identity"]).map(line),
      values: cardLinesFromItems(items, ["values"]).map(line),
      boundary: cardLinesFromItems(items, ["boundary"]).map(line),
      voice: cardLinesFromItems(items, ["voice"]).map(line),
      self: [...selfModelLines, ...cardLinesFromItems(items, ["self"]).map(line)],
      // 章节行排在人格层 narrative 之前：「最近」块只取前 2 行，章节比旧的自述行更贴近「最近的变化」。
      narrative: [
        ...narrativeLines.map((entry) => {
          const ids = chapterEvidence.get(entry.chapterId) ?? [];
          return ids.length > 0 ? { text: entry.text, evidenceIds: ids } : { text: entry.text };
        }),
        ...cardLinesFromItems(items, ["narrative"]).map(line),
      ],
    },
    mood,
    structured: structuredInput,
    labels: projected,
    calibration: calibrationRows,
    version: persistedVersion,
  };

  const rendered = renderPersonaCardV13(v13Input);
  const warnings = [...rendered.warnings, ...(input.profileWarnings ?? []), ...(structuredFacts?.warnings ?? [])];
  if (persons !== undefined && persons.length > 0) {
    const scoped = filterPersonaItems(items, ["human"], (it) => {
      const key = personKeyOfItem(it);
      return key !== "" && persons.includes(key);
    });
    if (scoped.length === 0) {
      warnings.push("关于你：participants（" + persons.join("、") + "）在 human 层没有可用的档案行，本卡只含全局共性行");
    }
  }

  const segments = buildCardSegmentsV13(v13Input);
  const dirty = previous ? previous.hash !== rendered.hash || previous.text !== rendered.text : true;
  const version = persistedVersion + (persist && dirty ? 1 : 0);

  if (persist && dirty && typeof store.writeSoulSnapshot === "function") {
    const payloadJson = JSON.stringify({
      kind: "persona-card",
      schema: CARD_V13_SCHEMA_VERSION,
      version,
      hash: rendered.hash,
      text: rendered.text,
      chars: rendered.chars,
      labels: projected,
      warnings: [...new Set(warnings)],
      blocks: rendered.blocks,
      sources: rendered.sources,
      identity: segments.identity,
      anchor: segments.anchor,
      meta: { nameSource },
      ...(persons === undefined ? {} : { persons }),
    });
    await Promise.resolve(
      store.writeSoulSnapshot(tenant, {
        ts: now,
        contentHash: rendered.hash,
        payloadJson,
        reasonCode: "card",
        trigger: "soul_tick",
      }),
    );
  }

  return {
    version,
    hash: rendered.hash,
    text: rendered.text,
    chars: rendered.chars,
    identity: segments.identity,
    anchor: segments.anchor,
    labels: projected,
    warnings: [...new Set(warnings)],
    sources: rendered.sources,
    blocks: rendered.blocks,
    schema: "13",
    dirty,
    seeded: projected.length > 0,
    meta: { nameSource },
  };
}

/** 通道 B：心境一行 + 未完的事（≤3 条）+ 校准句（有数据才写），整体 ≤400 字符。 */
export async function assembleSoulTurn(opts: {
  store: SoulCardStorePort;
  tenant: CoreTenant;
}): Promise<SoulTurnAssembly> {
  const { store, tenant } = opts;
  const row =
    typeof store.readSoulState === "function" ? await Promise.resolve(store.readSoulState(tenant)) : null;

  const mood: SoulMoodState = {
    valence: Number(row?.valence ?? 0),
    arousal: Number(row?.arousal ?? 0.3),
    baselineValence: Number(row?.baselineValence ?? 0),
    baselineArousal: Number(row?.baselineArousal ?? 0.3),
    updatedAt: row?.updatedAt ?? new Date(0).toISOString(),
    sampleCount: Number(row?.sampleCount ?? 0),
    ...(row?.emotionLabel
      ? {
          emotion: {
            object: row?.emotionObject ?? "",
            label: row.emotionLabel,
            intensity: Number(row?.emotionIntensity ?? 0),
            at: row?.emotionAt ?? row.updatedAt,
          },
        }
      : {}),
  };
  const moodLine = renderMoodLine(mood);

  const promises =
    typeof store.listSoulPromises === "function"
      ? ((await Promise.resolve(store.listSoulPromises(tenant, { status: "open", limit: OPEN_LOOPS_MAX }))) ?? [])
      : [];
  const openLoops = promises
    .map((p) => String(p.content ?? "").replace(/\s+/gu, " ").trim())
    .filter((t) => t !== "")
    .slice(0, OPEN_LOOPS_MAX);

  const calibrationRows =
    typeof store.listSoulCalibration === "function"
      ? ((await Promise.resolve(store.listSoulCalibration(tenant, { limit: 5000 }))) ?? [])
      : [];

  return renderSoulTurnState({ moodLine, openLoops, calibration: calibrationRows });
}

/** 供观测日志/接口复述的卡标识（判据 14：注入端能报出用了哪版）。 */
export function describeCard(card: SoulCardAssembly): { version: number; hash: string; chars: number; schema: string } {
  return { version: card.version, hash: card.hash, chars: card.chars, schema: card.schema ?? CARD_V13_SCHEMA_VERSION };
}

/**
 * P2-A：按「层 + 谓词」筛 PersonaItem，纯函数、不改输入。
 * 只管两件事——层匹配与 predicate；state/去重/排序/截断仍由 cardLinesFromItems 判，
 * 两处口径不重复，所以这里不会出现「过滤了状态却又在上游没过滤」的分叉。
 */
export function filterPersonaItems(
  items: ReadonlyArray<PersonaItem>,
  layers: ReadonlyArray<SoulLayer>,
  predicate: (item: PersonaItem) => boolean,
): PersonaItem[] {
  const wanted = new Set<string>(layers);
  return items.filter((it) => wanted.has(it.layer) && predicate(it));
}

/**
 * 从 meta.person.key 读 person_key。读不到（阶段 1 之前的旧行、meta 缺失、形状不对）
 * 一律当 `""`——也就是「全局共性行」，恒在场。
 */
function personKeyOfItem(item: PersonaItem): string {
  const person = item.meta?.["person"];
  if (typeof person !== "object" || person === null) return "";
  const key = (person as Record<string, unknown>)["key"];
  return typeof key === "string" ? key : "";
}


/**
 * P2：结构化关系 → 卡行。只在按人过滤时用（persons 已给）。
 *
 * 三条判据：
 *  1. 只渲染「现在成立」的边：valid_to 为空且 status=active；ended/disputed 不进卡。
 *  2. 主体必须是本次在场的人（subjKey ∈ persons）；别人的关系一条都不出现。
 *  3. 名字只认 soul_person 的 displayName：obj_key 为空或解析不到就省略该行并给
 *     person_unresolved warning，绝不回退 obj_name（那是模型随手写的称呼，不是主键身份）。
 */
export interface StructuredRelationshipArgs {
  relations: ReadonlyArray<
    Pick<
      SoulPersonRelationRow,
      "relId" | "subjKey" | "pred" | "objKey" | "objName" | "validTo" | "direction" | "eventId"
    > & {
      status?: string;
    }
  >;
  personNames: ReadonlyMap<string, string> | Record<string, string>;
  persons: ReadonlyArray<string>;
}

export const RELATIONSHIP_MAX_LINES = 10;

function nameOfKey(names: StructuredRelationshipArgs["personNames"], key: string): string {
  if (names instanceof Map) return String(names.get(key) ?? "").trim();
  const v = (names as Record<string, string>)[key];
  return typeof v === "string" ? v.trim() : "";
}

/** 关系事实单行：正文 + 产生这条边的 soul_event id（证据回指用，不进正文）。 */
export interface StructuredRelationshipFact {
  text: string;
  evidenceIds: string[];
}

export function buildStructuredRelationshipFacts(args: StructuredRelationshipArgs): {
  facts: StructuredRelationshipFact[];
  warnings: string[];
} {
  const facts: StructuredRelationshipFact[] = [];
  const warnings: string[] = [];
  const persons = new Set(args.persons.filter((p) => typeof p === "string" && p !== ""));
  if (persons.size === 0) return { facts, warnings };
  const seen = new Set<string>();
  for (const rel of args.relations ?? []) {
    if (!persons.has(rel.subjKey)) continue;
    if (rel.validTo !== null && rel.validTo !== undefined && rel.validTo !== "") continue;
    if ((rel.status ?? "active") !== "active") continue;
    const pred = String(rel.pred ?? "").replace(/\s+/gu, " ").trim();
    if (pred === "") continue;
    const objKey = String(rel.objKey ?? "").trim();
    // 没有 person_key 的边只存在于旧数据/未回填；卡上不猜对象是谁。
    if (objKey === "") {
      warnings.push("person_unresolved:" + String(rel.relId ?? ""));
      continue;
    }
    const name = nameOfKey(args.personNames, objKey);
    if (name === "") {
      warnings.push("person_unresolved:" + objKey);
      continue;
    }
    const text = "你与" + name + "：" + pred + (rel.direction === "mutual" ? "（彼此）" : "");
    if (seen.has(text)) continue;
    seen.add(text);
    const evidenceIds = rel.eventId ? [rel.eventId] : [];
    facts.push({ text, evidenceIds });
    if (facts.length >= RELATIONSHIP_MAX_LINES) break;
  }
  return { facts, warnings };
}

export function buildStructuredRelationshipLines(args: StructuredRelationshipArgs): {
  lines: string[];
  warnings: string[];
} {
  const { facts, warnings } = buildStructuredRelationshipFacts(args);
  return { lines: facts.map((fact) => fact.text), warnings };
}
/**
 * P2：按人过滤时读结构化关系边（soul_person_relation）并转成卡行；不按人过滤时不读表。
 * 名字只认 soul_person.displayName（merge 墓碑过滤）；解析不到的行由 buildStructuredRelationshipLines
 * 省略并给 person_unresolved warning（fail-closed）。
 */
export async function readStructuredRelationship(
  store: SoulCardStorePort,
  tenant: CoreTenant,
  persons: string[] | undefined,
): Promise<{ lines: string[]; warnings: string[] } | undefined> {
  if (persons === undefined) return undefined;
  const relations =
    typeof store.listSoulPersonRelations === "function"
      ? ((await Promise.resolve(store.listSoulPersonRelations(tenant))) ?? [])
      : [];
  const people =
    typeof store.listSoulPersons === "function"
      ? ((await Promise.resolve(store.listSoulPersons(tenant))) ?? [])
      : [];
  const names = new Map(people.filter((p) => !p.mergedInto).map((p) => [p.personKey, p.displayName ?? ""] as const));
  return buildStructuredRelationshipLines({ relations, personNames: names, persons });
}

/** JSON 字符串数组列 → 去空、限三：卡的证据列只要「能回指的前几条」。 */
function parseIdList(json: unknown): string[] {
  if (typeof json !== "string" || json.trim() === "") return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x !== "").slice(0, 3);
  } catch {
    return [];
  }
}

function parseStringList(json: unknown): string[] {
  if (typeof json !== "string" || json.trim() === "") return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/\s+/gu, " ").trim())
      .filter((x) => x !== "");
  } catch {
    return [];
  }
}

/**
 * 阶段 2：一次读齐「我们」要的结构化数据——现行关系边 + 四轴状态。
 * 名字只认 soul_person.displayName；关系边解析不到对象就省略并给 person_unresolved，
 * 状态行没有名字也省略（不回退展示名/obj_name）。persons 未给时返回 null（旧路径）。
 */
export async function readStructuredCardFacts(
  store: SoulCardStorePort,
  tenant: CoreTenant,
  persons: string[] | undefined,
): Promise<{ relations: StructuredRelationshipFact[]; personStates: CardV13PersonState[]; warnings: string[] } | null> {
  if (persons === undefined) return null;
  const relations =
    typeof store.listSoulPersonRelations === "function"
      ? ((await Promise.resolve(store.listSoulPersonRelations(tenant))) ?? [])
      : [];
  const people =
    typeof store.listSoulPersons === "function"
      ? ((await Promise.resolve(store.listSoulPersons(tenant))) ?? [])
      : [];
  const names = new Map(people.filter((p) => !p.mergedInto).map((p) => [p.personKey, p.displayName ?? ""] as const));
  const built = buildStructuredRelationshipFacts({ relations, personNames: names, persons });
  const rows =
    typeof store.listSoulPersonStates === "function"
      ? ((await Promise.resolve(store.listSoulPersonStates(tenant))) ?? [])
      : [];
  const wanted = new Set(persons);
  const personStates: CardV13PersonState[] = rows
    .filter((row) => wanted.has(row.person_key))
    .slice(0, 8)
    .map((row) => ({
      personKey: row.person_key,
      name: names.get(row.person_key) ?? "",
      trust: Number(row.trust ?? 0.5),
      affinity: Number(row.affinity ?? 0.5),
      respect: Number(row.respect ?? 0.5),
      obligation: Number(row.obligation ?? 0.5),
      evidenceIds: parseIdList(row.evidence_event_ids_json),
    }));
  return { relations: built.facts, personStates, warnings: built.warnings };
}