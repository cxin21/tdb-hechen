import type { CoreTenant, IMemoryStore, SoulSnapshotRow } from "../store/types.js";
import type { AgentProfileLike } from "./agent-profile.js";
import {
  ANCHOR_PROMISE_MAX,
  CARD_BLOCK_TITLES,
  CARD_SCHEMA_VERSION,
  buildCardSegments,
  clampRedlines,
  renderPersonaCard,
  type CardBlockKey,
  type CardSegment,
  type PersonaCardInput,
  type PersonaCardSnapshot,
} from "./card.js";
import { renderMoodLine, type SoulMoodState } from "./emotion.js";
import type { TraitLabelRow } from "./trait-drift.js";
import {
  HUMAN_MAX_LINES,
  OPEN_LOOPS_MAX,
  PERSONA_TURN_MAX_CHARS,
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
 *   2) 落账只在 tick 末——persist:true 时内容变（hash 变）才追加 soul_snapshots 一行，
 *      没变就复用上一版（D5/G5：权重变化 < 0.05 不重渲染、不换 hash）。
 *
 * 卡本体（通道 A）不含 openLoops：那段是通道 B 每轮随心境一起拼的。
 */

export type CardFieldSource = "declared" | "observed" | "derived";

/** 判据 2：表单字段必须是 declared，观察层必须是 observed，投影/自传是 derived。 */
export const CARD_FIELD_SOURCES: Record<CardBlockKey, CardFieldSource> = {
  name: "declared",
  image: "declared",
  voice: "declared",
  purpose: "declared",
  traits: "derived",
  redlines: "declared",
  human: "observed",
  relationship: "observed",
  selfHistory: "observed",
  autobiography: "derived",
  openLoops: "observed",
};

export interface SoulCardAssembly {
  version: number;
  hash: string;
  text: string;
  chars: number;
  /**
   * P1-2 身份段（注入在最前面的稳定段）：读法常量 + 名称/形象/说话方式/使命/红线，≤1600 字。
   * 红线逐条 verbatim，永不因这段的预算被删（宁可越界并给 warning）。
   * 与 `text` 的关系：`text` 仍是既有整卡（逐字不变），identity 是它的**投影**，不是切下来的一段——
   * 中间块（关于你/自我史/自传/整卡的未完的事）只存在于 `text` 里。
   */
  identity: CardSegment;
  /**
   * P1-2 末尾锚（每轮末尾的极短复述）：底色（≤3 行）+ 未完的事（≤2 条）+ 关系（≤1 行），≤300 字。
   * 空时 `text:"" / chars:0 / hash:""`，原因见其 warnings（不塞占位标题）。
   */
  anchor: CardSegment;
  labels: Array<{ label: string; act: number; gloss?: string }>;
  warnings: string[];
  sources: Record<CardBlockKey, CardFieldSource>;
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
  readSoulTraitState?: IMemoryStore["readSoulTraitState"];
  listSoulTraitLabels?: IMemoryStore["listSoulTraitLabels"];
  readLastSoulSnapshot?: IMemoryStore["readLastSoulSnapshot"];
  writeSoulSnapshot?: IMemoryStore["writeSoulSnapshot"];
  readSoulState?: IMemoryStore["readSoulState"];
  listSoulPromises?: IMemoryStore["listSoulPromises"];
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

/** 上一版卡的 payload 解析；不是卡快照（旧 slot 快照）就当没有上一版。 */
export function parsePreviousCard(row: SoulSnapshotRow | null | undefined): PersonaCardSnapshot | null {
  if (!row?.payload_json) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as { kind?: string } & Partial<PersonaCardSnapshot>;
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

/** A7：卡的过期提示挂在输入侧（`PersonaCardInput` 不带 warnings，卡本体产出的 warnings 由渲染器给）。 */
export type PersonaCardInputWithProfileWarnings = PersonaCardInput & { profileWarnings?: string[] };

export function buildCardInput(args: {
  profile: AgentProfileLike | null;
  labels: ReturnType<typeof projectLabels>;
  items: ReadonlyArray<PersonaItem>;
  version: number;
  state?: AxisVector;
  /** person_key 列表；undefined = 不按人过滤（向后兼容）。 */
  persons?: string[];
  /** A7：判定档案行 TTL 的「现在」；缺省取当前时间。 */
  now?: string;
}): PersonaCardInputWithProfileWarnings {
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
  const input: PersonaCardInput = {
    profile: {
      name: resolvedName,
      nameSource: resolvedName !== "" ? "declared" : "skeleton",
      ...(profile?.pronoun ? { pronoun: profile.pronoun } : {}),
      ...(profile?.selfImage ? { selfImage: profile.selfImage } : {}),
      ...(profile?.voice ? { voice: profile.voice } : {}),
      ...(profile?.purpose ? { purpose: profile.purpose } : {}),
      // 红线在 renderPersonaCard 内部 clamp（≤30 行/单行≤120/总≤2600），这里只透传 active。
      ...(profile?.redlines?.length ? { redlines: profile.redlines.filter((r) => r.active) } : {}),
    },
    labels,
    human: cardLinesFromItems(
      filterPersonaItems(items, ["human"], (it) => personFilter(it) && freshFilter(it)),
      ["human"],
      HUMAN_MAX_LINES,
    ),
    // 本阶段**不过滤** relationship：它的 `meta.object` 存的是展示名（「用户」「何晨」），
    // 不是 person_key；按 key 过滤会一律命中空、把关系史静默清空。等阶段 3 的
    // `object_person` 回填完成后才按 key 过滤（已知缺口，见交付报告/规格 P2-A）。
    relationship: cardLinesFromItems(items, ["relationship"], HUMAN_MAX_LINES),
    selfHistory: cardLinesFromItems(items, ["identity", "self"], HUMAN_MAX_LINES),
    ...(narrative.length > 0 ? { autobiography: narrative.join("\n") } : {}),
    version,
    ...(state ? { state } : {}),
  };
  return staleFields.size > 0
    ? { ...input, profileWarnings: Array.from(staleFields).sort().map((f) => `profile_stale:${f}`) }
    : input;
}

/**
 * 组装卡。persist:false 时绝不写库（GET 端点用），dirty 只表达「与已存快照不同」。
 */
export async function assembleSoulCard(opts: AssembleSoulCardOptions): Promise<SoulCardAssembly> {
  const { store, tenant, readAgentProfile, now = new Date().toISOString(), persist = false, persons } = opts;

  const persisted =
    typeof store.readLastSoulSnapshot === "function"
      ? ((await Promise.resolve(store.readLastSoulSnapshot(tenant))) ?? null)
      : null;
  const previous = parsePreviousCard(persisted);
  const persistedVersion = typeof persisted?.version === "number" ? persisted.version : 0;

  // 表单读不到不该让整张卡消失（fail-open 的一层）：降级为 null，卡里只剩观察层与底色。
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

  // 表单给了特质但还没有漂移状态时，底色按 seedState 投影（否则「你设定的」永远不进卡）。
  // 声明标签豁免证据门（spec v3.7 §3）：表单项是他设定的，不需要攒证据；库里还没有对应行
  // 时用种子方向合成一条视图，否则「设了 4 个特质、从未漂移」的生产租户底色恒为空。
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
      // 库里还没有这一行时，种子自带的 gloss 是唯一可用的一份；落库后以行内 gloss 为准。
      gloss: s.gloss,
    })),
  ];
  const state = traitState?.state ?? seedStateFromSeeds(profile?.traits ?? []);
  const projected = projectLabels(state, views).slice(0, TRAIT_TOP_N);

  // 名字只认声明（task-27/A1）：不再从 L1 里猜。没有声明就是骨架「（未命名）」，
  // 由 card.ts 渲染占位并留 warning——占位不是名字，不冒充任何身份。
  const cardName = profile?.name?.trim() ?? "";
  const nameSource: SoulCardNameSource = cardName !== "" ? "declared" : "skeleton";

  // 版本只在真正写快照时 +1：persist=true 但内容未变时下面不写库，若这里仍然 +1，
  // 调用方拿到的 version 会比库里多 1，下一次 GET 又退回旧值（journal/日志也对不上）。
  const input = buildCardInput({
    profile,
    labels: projected,
    items,
    version: persistedVersion,
    state,
    now,
    ...(persons === undefined ? {} : { persons }),
  });
  const rendered = renderPersonaCard(input, previous);

  // P2-A：按人过滤后「在场者的档案行」可能一条都没有（human 层还没有对应行、或 participants
  // 没命中任何人）。卡本体对空 human 段不发 warning，这里补一条，让调用方能区分「真的没有
  // 关于你的东西」和「过滤把内容筛空了」。只动 warnings，不进 text/hash（hash 只由 text 算）。
  const warnings = [...rendered.warnings, ...(input.profileWarnings ?? [])];
  if (persons !== undefined && persons.length > 0) {
    const scoped = filterPersonaItems(items, ["human"], (it) => {
      const key = personKeyOfItem(it);
      return key !== "" && persons.includes(key);
    });
    if (scoped.length === 0) {
      warnings.push(`关于你：participants（${persons.join("、")}）在 human 层没有可用的档案行，本卡只含全局共性行`);
    }
  }

  // P1-2：两段载荷与整卡同源（同一份 input → 同一份 block 构建），只做读侧投影。
  // 承诺只进末尾锚、**不**进整卡正文：往 input.openLoops 里塞会让 `text` 多出「未完的事」块，
  // 老调用方看到的卡就变了（本轮要求 text 逐字不变）。
  const segments = buildCardSegments({ ...input, anchorPromises: await readAnchorPromises(store, tenant) });

  const dirty = previous ? previous.hash !== rendered.hash || previous.text !== rendered.text : true;
  // nameSource 进快照 meta（可审计「这个名字哪来的」），不进注入正文。
  const snapshot = {
    ...rendered,
    warnings,
    version: persistedVersion + (persist && dirty ? 1 : 0),
    meta: { nameSource },
  };

  if (persist && dirty && typeof store.writeSoulSnapshot === "function") {
    // P2-F：快照要能回答「这张卡当时是按哪组在场者过滤的」。未过滤时**不写**该字段，
    // 否则历史回放会把「不过滤」误读成「过滤了一个空名单」。
    const payloadJson = JSON.stringify({
      kind: "persona-card",
      ...snapshot,
      identity: segments.identity,
      anchor: segments.anchor,
      ...(persons === undefined ? {} : { persons }),
    });
    await Promise.resolve(
      store.writeSoulSnapshot(tenant, {
        ts: now,
        contentHash: snapshot.hash,
        payloadJson,
        reasonCode: "card",
        trigger: "soul_tick",
      }),
    );
  }

  return {
    version: snapshot.version,
    hash: snapshot.hash,
    text: snapshot.text,
    chars: snapshot.chars,
    identity: segments.identity,
    anchor: segments.anchor,
    labels: snapshot.labels,
    warnings: snapshot.warnings,
    sources: { ...CARD_FIELD_SOURCES },
    dirty,
    seeded: projected.length > 0,
    meta: { nameSource },
  };
}

/**
 * 末尾锚的未完承诺：只读、最多 ANCHOR_PROMISE_MAX 条。
 * store 没有这个方法、或读失败 → 返回空（锚里就没有「未完的事」，不伪造、不让整卡失败）。
 */
async function readAnchorPromises(store: SoulCardStorePort, tenant: CoreTenant): Promise<string[]> {
  if (typeof store.listSoulPromises !== "function") return [];
  try {
    const rows =
      (await Promise.resolve(
        store.listSoulPromises(tenant, { status: "open", limit: ANCHOR_PROMISE_MAX }),
      )) ?? [];
    return rows.map((p) => String(p.content ?? "")).filter((t) => t.trim() !== "");
  } catch {
    return [];
  }
}

function clampTurn(text: string, max = PERSONA_TURN_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** 通道 B：心境一行 + 未完的事（≤3 条），整体 ≤400 字符。 */
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

  const pending = openLoops.length > 0 ? `未完的事：${openLoops.join("；")}` : "";
  return { text: clampTurn([moodLine, pending].filter((s) => s !== "").join("\n")), openLoops };
}

/** 供观测日志/接口复述的卡标识（判据 14：注入端能报出用了哪版）。 */
export function describeCard(card: SoulCardAssembly): { version: number; hash: string; chars: number; schema: string } {
  return { version: card.version, hash: card.hash, chars: card.chars, schema: CARD_SCHEMA_VERSION };
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

export { CARD_BLOCK_TITLES };
