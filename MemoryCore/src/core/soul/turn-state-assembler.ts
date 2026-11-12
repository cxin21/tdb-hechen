/**
 * 通道 B 之外：§6 运行时状态装配器（issue #180）。
 *
 * 为什么要单独一层：LLM 没有内部人格权重，实时影响只走「它看到什么」这条通道。
 * renderSoulTurnState 只负责 400 字尾巴；这里产出独立的动态段（mood/关系/目标/
 * 边界/优先级 + 离散 flags），由插件用独立字段注入，不塞进稳定卡、也不改旧的 text。
 * 全程只读，任一读失败用基线并标 absent，不让一次 SQLite 失败阻塞会话。
 */

const NL = String.fromCharCode(10);

type MaybePromise<T> = T | Promise<T>;

interface TurnStateStateRow {
  valence?: number;
  arousal?: number;
  baselineValence?: number;
  baselineArousal?: number;
  sampleCount?: number;
  updatedAt?: string;
  emotionLabel?: string;
}
interface TurnStateMoodRow {
  valence?: number;
  arousal?: number;
  intensity?: number;
  half_life_hours?: number;
  cause_event_ids_json?: string;
  updated_at?: string;
  label?: string;
}
interface TurnStateGoalRow {
  goal_id?: string;
  title?: string;
  status?: string;
  priority?: number;
  due_at?: string;
  blocked_reason?: string;
  source_event_id?: string;
  blocked_event_id?: string;
  valid_to?: string | null;
}
interface TurnStateRelationRow {
  relId?: string;
  subjKey?: string;
  pred?: string;
  objKey?: string;
  objName?: string;
  validTo?: string | null;
  direction?: string;
  eventId?: string;
  status?: string;
}
interface TurnStatePerson {
  personKey?: string;
  displayName?: string;
  mergedInto?: string | null;
}
interface TurnStateWorkingRow {
  current_focus?: string;
  current_goal_id?: string;
  open_questions_json?: string;
}

interface TurnStateStorePort {
  readSoulState?: (tenant?: unknown) => MaybePromise<TurnStateStateRow | null | undefined>;
  readSoulMoodState?: (tenant?: unknown) => MaybePromise<TurnStateMoodRow | null | undefined>;
  listSoulGoals?: (tenant?: unknown, opts?: unknown) => MaybePromise<TurnStateGoalRow[] | null | undefined>;
  getSoulWorkingState?: (tenant?: unknown, opts?: unknown) => MaybePromise<TurnStateWorkingRow | null | undefined>;
  listSoulPersonRelations?: (tenant?: unknown, opts?: unknown) => MaybePromise<TurnStateRelationRow[] | null | undefined>;
  listSoulPersons?: (tenant?: unknown) => MaybePromise<TurnStatePerson[] | null | undefined>;
  listSoulPersonStates?: (tenant?: unknown, opts?: unknown) => MaybePromise<unknown[] | null | undefined>;
}

export interface AssembleTurnStateOptions {
  /** 真实 store（结构可选读面）；类型刻意留宽，内部按端口收窄，避免与具体 store 强耦合。 */
  store: unknown;
  tenant: unknown;
  personKey?: string;
  sessionId?: string;
  /** ISO 时间；不传取当前时间。单测据此钉衰减与 stale。 */
  now?: string;
  /** 红线；永远排在最前，不因预算被丢。 */
  redlines?: ReadonlyArray<string>;
  /**
   * 动态段预算（字）。§8 的 400 是整段「标头 + 正文」的上限，调用方若自带标头，
   * 应把标头长度扣掉传进来，否则正文会顶穿总预算或被插件二次裁掉尾行。
   */
  dynamicMaxChars?: number;
}

export interface TurnStateMood {
  valence: number;
  arousal: number;
  label?: string;
  derived: boolean;
  stale: boolean;
}
export interface TurnStateFlags {
  tone: "terse" | "neutral" | "warm";
  initiative: "ask" | "act";
  repairFirst: boolean;
  evidenceStrict: boolean;
  disclosure: "normal" | "guarded";
  uncertainty: "low" | "medium" | "high";
  goalReminder: boolean;
}
export interface TurnStateAssembly {
  mood: TurnStateMood;
  relation: { facts: string[] };
  goals: { lines: string[]; chars: number };
  working: { focus?: string };
  flags: TurnStateFlags;
  warnings: string[];
  asOf: string;
  stateHash: string;
  evidenceIds: string[];
  flagTrace: string[];
  dynamicText: string;
}

/** §8 技术验收的硬门：动态段 ≤400 字（§6「目标 500 字以内」是目标子预算，见 TURN_STATE_GOALS_MAX_CHARS）。 */
const TURN_STATE_DYNAMIC_MAX_CHARS = 400;
const TURN_STATE_GOALS_MAX_CHARS = 500;
const TURN_STATE_STALE_HOURS = 72;
const TURN_STATE_DUE_HORIZON_MS = 24 * 3600 * 1000;
const TURN_STATE_ARBITRATION = ["红线", "用户明确指令", "事实与证据", "关系修复", "心境表达", "性格风格"] as const;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hashText(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return "s" + h.toString(16).padStart(8, "0");
}

function parseEvidenceIds(json: unknown, out: Set<string>): void {
  if (typeof json !== "string" || json === "") return;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item !== "") out.add(item);
      }
    }
  } catch {
    // 证据字段损坏只跳过，不阻塞会话。
  }
}

/**
 * 每轮只读装配：读 mood（带衰减）/ 当前 person 的关系边 / 24h 内到期目标 / working，
 * 再按「红线 > 用户明确指令 > 事实与证据 > 关系修复 > 心境表达 > 性格风格」仲裁出离散 flags。
 */
export async function assembleTurnState(options: AssembleTurnStateOptions): Promise<TurnStateAssembly> {
  const port = (options.store ?? {}) as TurnStateStorePort;
  const tenant = options.tenant;
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const redlines = (options.redlines ?? []).map((r) => String(r ?? "").trim()).filter((r) => r !== "");
  const warnings: string[] = [];
  const evidence = new Set<string>();
  let absent = false;

  async function safeRead(invoke: () => unknown): Promise<unknown> {
    try {
      return await invoke();
    } catch {
      absent = true;
      return undefined;
    }
  }

  const stateRow = (await safeRead(() => port.readSoulState?.(tenant))) as TurnStateStateRow | undefined;
  const moodRow = (await safeRead(() => port.readSoulMoodState?.(tenant))) as TurnStateMoodRow | undefined;
  const goalRows = (await safeRead(() => port.listSoulGoals?.(tenant, { limit: 50 }))) as TurnStateGoalRow[] | undefined;
  const persons = (await safeRead(() => port.listSoulPersons?.(tenant))) as TurnStatePerson[] | undefined;
  const relations = (await safeRead(() => port.listSoulPersonRelations?.(tenant, { includeClosed: false }))) as TurnStateRelationRow[] | undefined;
  const workingRow = (await safeRead(() => port.getSoulWorkingState?.(tenant, { sessionId: options.sessionId, now }))) as TurnStateWorkingRow | undefined;

  const baselineValence = finiteOr(stateRow?.baselineValence, 0);
  const baselineArousal = finiteOr(stateRow?.baselineArousal, 0.3);
  let valence = baselineValence;
  let arousal = baselineArousal;
  let derived = false;
  let stale = false;
  let label: string | undefined = stateRow?.emotionLabel;

  if (moodRow) {
    const updatedMs = Date.parse(String(moodRow.updated_at ?? ""));
    const dtHours = Number.isFinite(updatedMs) && Number.isFinite(nowMs)
      ? Math.max(0, (nowMs - updatedMs) / 3600000)
      : 0;
    const halfLife = finiteOr(moodRow.half_life_hours, 36);
    stale = dtHours > TURN_STATE_STALE_HOURS;
    if (stale) {
      // 过期只给中性底色，不把旧情绪装成「现在」。
      valence = baselineValence;
      arousal = baselineArousal;
    } else {
      const decay = Math.exp(-dtHours / (halfLife > 0 ? halfLife : 36));
      valence = baselineValence + (finiteOr(moodRow.valence, baselineValence) - baselineValence) * decay;
      arousal = baselineArousal + (finiteOr(moodRow.arousal, baselineArousal) - baselineArousal) * decay;
    }
    if (moodRow.label) label = moodRow.label;
    parseEvidenceIds(moodRow.cause_event_ids_json, evidence);
  } else {
    // soul_mood_state 缺失：回退 soul_state，标 derived，不伪造 mood 行。
    // 回退值同样受 72h 约束：soul_state 的 updated_at 也可能是几天前，
    // 旧底色不能冒充「现在」（§9 第 3 条对 derived 同样成立）。
    derived = true;
    const stateUpdatedMs = stateRow?.updatedAt ? Date.parse(String(stateRow.updatedAt)) : Number.NaN;
    const stateDtHours = Number.isFinite(stateUpdatedMs) ? Math.max(0, (nowMs - stateUpdatedMs) / 3600000) : Number.POSITIVE_INFINITY;
    stale = stateDtHours > TURN_STATE_STALE_HOURS;
    valence = stale ? baselineValence : finiteOr(stateRow?.valence, baselineValence);
    arousal = stale ? baselineArousal : finiteOr(stateRow?.arousal, baselineArousal);
  }

  // 关系：只取当前 personKey 的入边和出边，解析不到 person_unresolved 整段省略。
  const relationFacts: string[] = [];
  let unresolved = false;
  if (options.personKey) {
    const personMap = new Map<string, string>();
    for (const p of persons ?? []) {
      if (p && p.personKey && !p.mergedInto) {
        personMap.set(p.personKey, String(p.displayName ?? "").trim());
      }
    }
    const selfName = personMap.get(options.personKey) ?? "";
    if (selfName === "") {
      warnings.push("person_unresolved:" + options.personKey);
      unresolved = true;
    } else {
      for (const r of relations ?? []) {
        if (!r) continue;
        if (r.validTo) continue;
        if (r.status && r.status !== "active") continue;
        const touches = r.subjKey === options.personKey || r.objKey === options.personKey;
        if (!touches) continue;
        const otherKey = r.subjKey === options.personKey ? String(r.objKey ?? "") : String(r.subjKey ?? "");
        const otherName = (r.subjKey === options.personKey && r.objName)
          ? String(r.objName).trim()
          : (personMap.get(otherKey) ?? "");
        if (otherName === "") {
          warnings.push("person_unresolved:" + (otherKey || r.relId || "rel"));
          unresolved = true;
          continue;
        }
        const pred = String(r.pred ?? "").trim();
        if (pred === "") continue;
        relationFacts.push("你与" + otherName + "：" + pred + (r.direction === "mutual" ? "（彼此）" : ""));
        if (r.eventId) evidence.add(String(r.eventId));
      }
    }
  }
  if (unresolved) relationFacts.length = 0; // fail-closed：整段省略

  // 目标：24h 内到期或已逾期才提醒；blocked 只写阻塞原因，过期行（valid_to 已过）不带入。
  const goalLines: string[] = [];
  let hasBlocked = false;
  for (const g of goalRows ?? []) {
    if (!g) continue;
    const status = String(g.status ?? "active");
    const validToMs = g.valid_to ? Date.parse(String(g.valid_to)) : Number.NaN;
    // 半年前就结束的阻塞不该永久注入（§9 第 3 条对目标同样成立）。
    if (Number.isFinite(validToMs) && Number.isFinite(nowMs) && validToMs < nowMs) continue;
    const dueMs = Date.parse(String(g.due_at ?? ""));
    const dueSoon = Number.isFinite(dueMs) && Number.isFinite(nowMs)
      && dueMs >= nowMs && (dueMs - nowMs) <= TURN_STATE_DUE_HORIZON_MS;
    const expired = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs;
    if (status === "blocked") {
      hasBlocked = true;
      const reason = String(g.blocked_reason ?? "").trim();
      if (reason !== "") goalLines.push("阻塞：" + reason);
      // 阻塞同样要能追到事件，否则审计说不清「为什么被挡」。
      if (g.blocked_event_id) evidence.add(String(g.blocked_event_id));
      continue;
    }
    if (status !== "active") continue;
    const title = String(g.title ?? "").trim();
    if (title === "") continue;
    if (expired) {
      goalLines.push("已逾期：" + title);
      if (g.source_event_id) evidence.add(String(g.source_event_id));
    } else if (dueSoon) {
      goalLines.push("目标：" + title);
      if (g.source_event_id) evidence.add(String(g.source_event_id));
    }
  }
  let goalsText = "";
  for (const line of goalLines) {
    const candidate = goalsText === "" ? line : goalsText + NL + line;
    if (candidate.length > TURN_STATE_GOALS_MAX_CHARS) {
      const used = goalsText === "" ? 0 : goalsText.length + 1;
      const remaining = TURN_STATE_GOALS_MAX_CHARS - used - 1;
      if (remaining > 0) {
        goalsText += (goalsText === "" ? "" : NL) + line.slice(0, remaining) + "…";
      }
      break;
    }
    goalsText = candidate;
  }
  const goals = { lines: goalsText === "" ? [] : goalsText.split(NL), chars: goalsText.length };

  // flags：只映射离散行为；仲裁顺序每个进 trace。
  // 六层仲裁必须真的落到 flag 上，只写 trace 是装饰（第二轮评审 MAJOR）：
  // 红线在场时心境不下沉为暖语气，披露一律收敛。
  const repairFirst = hasBlocked;
  const evidenceStrict = stale || hasBlocked;
  const hasRedlines = redlines.length > 0;
  const tone: TurnStateFlags["tone"] = hasRedlines
    ? "neutral"
    : valence > 0.3 ? "warm" : valence < -0.3 ? "terse" : "neutral";
  const disclosure: TurnStateFlags["disclosure"] = hasRedlines || evidenceStrict || repairFirst ? "guarded" : "normal";
  const initiative: TurnStateFlags["initiative"] = repairFirst || evidenceStrict ? "ask" : "act";
  const uncertainty: TurnStateFlags["uncertainty"] = stale || absent ? "high" : derived ? "medium" : "low";

  if (absent) warnings.push("absent");
  if (derived) warnings.push("derived");
  if (stale) warnings.push("stale");

  const working = { focus: workingRow?.current_focus ? String(workingRow.current_focus).trim() : undefined };

  // 动态段：红线 > 现在 > 关系 > 目标 > 优先级。超预算整块丢弃（先关系、再目标、再现在、最后红线换计数标记），
  // 绝不 slice 拼接串——半句话比少一句话更糟，且注入文本与 flags 必须一致（第二轮评审 MAJOR）。
  type DynSegment = { kind: "redline" | "now" | "relation" | "goal"; text: string; notice?: boolean };
  const segments: DynSegment[] = [];
  for (const r of redlines) segments.push({ kind: "redline", text: "红线：" + r });
  if (working.focus) segments.push({ kind: "now", text: "现在：" + working.focus });
  for (const fact of relationFacts) segments.push({ kind: "relation", text: fact });
  for (const line of goals.lines) segments.push({ kind: "goal", text: line });
  const priorityText = "优先级：" + (initiative === "ask" ? "先问再动" : "先做");
  const requestedBudget = Number((options as { dynamicMaxChars?: unknown }).dynamicMaxChars);
  const stateBudget = Number.isFinite(requestedBudget) && requestedBudget > 0
    ? Math.min(TURN_STATE_DYNAMIC_MAX_CHARS, Math.floor(requestedBudget))
    : TURN_STATE_DYNAMIC_MAX_CHARS;
  const renderSegments = (items: DynSegment[]): string =>
    items.map((item) => item.text).concat(priorityText).join(NL);
  const totals: Record<DynSegment["kind"], number> = {
    relation: relationFacts.length,
    goal: goals.lines.length,
    now: working.focus ? 1 : 0,
    redline: redlines.length,
  };
  const droppedCounts: Record<DynSegment["kind"], number> = { relation: 0, goal: 0, now: 0, redline: 0 };
  const fits = (items: DynSegment[]): boolean => renderSegments(items).length <= stateBudget;
  let kept = segments.slice();
  let redlineNoticeShown = false;
  const dropLast = (kind: DynSegment["kind"]): boolean => {
    const at = kept.map((item) => item.kind).lastIndexOf(kind);
    if (at < 0) return false;
    const [removed] = kept.splice(at, 1);
    // 占位行是「全部红线已省略」的替身，不是又一条被丢的红线；再计一次会让 dropped 超过 total。
    if (removed?.notice !== true) droppedCounts[kind] += 1;
    return true;
  };
  while (!fits(kept)) {
    if (dropLast("relation")) continue;
    if (dropLast("goal")) continue;
    if (dropLast("now")) continue;
    // 红线不能悄悄消失：先把全部红线换成一条占位行，再考虑它自己。
    if (!redlineNoticeShown && redlines.length > 0) {
      kept = kept.filter((item) => item.kind !== "redline");
      droppedCounts.redline = redlines.length;
      kept.unshift({ kind: "redline", text: "红线：见人格卡（" + redlines.length + " 条）", notice: true });
      redlineNoticeShown = true;
      continue;
    }
    if (dropLast("redline")) continue;
    break;
  }
  // 优先级行自己也放不下时，正文会是空串；不记一条就分不清「没状态」与「预算小到连优先级都没了」。
  if (!fits(kept)) warnings.push("budget_dropped:priority:1/1");
  const dynamicText = fits(kept) ? renderSegments(kept) : "";
  const goalReminder = kept.some((item) => item.text.startsWith("目标：") || item.text.startsWith("已逾期："));
  for (const kind of Object.keys(droppedCounts) as Array<DynSegment["kind"]>) {
    if (droppedCounts[kind] > 0) {
      warnings.push("budget_dropped:" + kind + ":" + droppedCounts[kind] + "/" + totals[kind]);
    }
  }

  const flags: TurnStateFlags = {
    tone,
    initiative,
    repairFirst,
    evidenceStrict,
    disclosure,
    uncertainty,
    goalReminder,
  };
  const flagTrace: string[] = [];
  for (const level of TURN_STATE_ARBITRATION) flagTrace.push("仲裁：" + level);
  if (hasRedlines) flagTrace.push("仲裁生效：红线压过心境表达 → tone=neutral、disclosure=guarded");
  const droppedSummary = (Object.keys(droppedCounts) as Array<DynSegment["kind"]>)
    .filter((kind) => droppedCounts[kind] > 0)
    .map((kind) => kind + ":" + droppedCounts[kind] + "/" + totals[kind]);
  if (droppedSummary.length > 0) flagTrace.push("预算丢弃：" + droppedSummary.join(","));
  flagTrace.push("flag tone=" + flags.tone);
  flagTrace.push("flag initiative=" + flags.initiative);
  flagTrace.push("flag repairFirst=" + flags.repairFirst);
  flagTrace.push("flag evidenceStrict=" + flags.evidenceStrict);
  flagTrace.push("flag disclosure=" + flags.disclosure);
  flagTrace.push("flag uncertainty=" + flags.uncertainty);
  flagTrace.push("flag goalReminder=" + flags.goalReminder);

  const evidenceIds = Array.from(evidence);
  const stateHash = hashText(JSON.stringify({
    v: Math.round(valence * 1e4) / 1e4,
    a: Math.round(arousal * 1e4) / 1e4,
    derived,
    stale,
    warnings,
    relationFacts,
    goals: goals.lines,
    flags,
    evidenceIds,
    // §9 第 10 条：hash 要能区分「注入了什么」，所以「现在」与整段动态文本都要进哈希。
    working: working.focus ?? "",
    dynamicText,
  }));

  return {
    mood: { valence, arousal, label, derived, stale },
    relation: { facts: relationFacts },
    goals,
    working,
    flags,
    warnings,
    asOf: now,
    stateHash,
    evidenceIds,
    flagTrace,
    dynamicText,
  };
}
