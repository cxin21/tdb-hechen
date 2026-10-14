/**
 * #16 T9 · anchor-lifecycle golden 基建 —— 确定性 fixture store + 快照采集。
 *
 * 目标：为锚生命周期两条发现管线（runIdentityDiscovery / runAnchorGrowth）+ soul 渲染
 * 提供**确定性、可 diff、显式更新**的快照安全网（四层：锚集 values / 红线 pending /
 * retire 决策与计数 / core+soul 渲染）。任何行为变更 → golden diff 必须在 review 中
 * 显式确认；确认后 UPDATE_GOLDEN=1 pnpm vitest run <file> 重新固化。
 *
 * 设计约束（#16 验收）：
 *  - LLM 脚本化（按 taskId 回放），时间注入（now 固定/可推进），全部纯内存；
 *  - 快照 JSON 键序稳定（stableStringify 递归排序），weight 录制时 4 位舍入；
 *  - fixture store 语义 = sqlite 真实现的可观测子集（upsert 冲突更新/retire 软退/
 *    pending 单向状态机/租户三元组），不为快照好看而扭曲行为。
 */
import type { CoreTenant } from "../../store/types.js";

export const GOLDEN_NOW = new Date("2026-10-14T10:00:00.000Z");
export const TENANT: CoreTenant = { teamId: "t", userId: "u", agentId: "a" };

export const GOLDEN_LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// ── 行形态 ───────────────────────────────────────────────────────────────────

export interface L1Row {
  record_id: string;
  content: string;
  significance?: number;
  priority?: number;
  updated_time: string;
  created_time?: string;
  timestamp_str?: string;
  timestamp_start?: string;
  timestamp_end?: string;
  type?: string;
  valence?: number | null;
  metadata_json?: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
}

export interface ValueRow {
  value_id: string;
  label: string;
  weight: number;
  created_by: string;
  valence: number | null;
  origin: string;
  pinned: number;
  state: string;
  node_type: string;
  attrs_json: string | null;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
}

export interface PendingRow {
  pending_id: string;
  slot: string;
  content: string;
  evidence: number;
  label?: string;
  description?: string;
  state: "pending" | "adopted" | "rejected";
  created_at: string;
}

export function l1Row(id: string, content: string, opts?: { significance?: number; updated?: string; valence?: number | null; agentId?: string }): L1Row {
  return {
    record_id: id,
    content,
    significance: opts?.significance,
    updated_time: opts?.updated ?? "2026-10-13T00:00:00Z",
    created_time: "2026-10-13T00:00:00Z",
    timestamp_str: "2026-10-13T00:00:00Z",
    timestamp_start: "2026-10-13T00:00:00Z",
    timestamp_end: "2026-10-13T00:00:00Z",
    type: "episodic",
    valence: opts?.valence ?? null,
    metadata_json: "{}",
    team_id: TENANT.teamId,
    user_id: TENANT.userId,
    agent_id: opts?.agentId ?? TENANT.agentId,
  };
}

export function valueRow(id: string, label: string, weight: number, opts?: Partial<Omit<ValueRow, "value_id" | "label" | "weight">>): ValueRow {
  return {
    value_id: id,
    label,
    weight,
    created_by: opts?.created_by ?? "auto-growth",
    valence: opts?.valence ?? null,
    origin: opts?.origin ?? "auto",
    pinned: opts?.pinned ?? 0,
    state: opts?.state ?? "active",
    node_type: opts?.node_type ?? "theme",
    attrs_json: opts?.attrs_json ?? null,
    team_id: TENANT.teamId,
    user_id: TENANT.userId,
    agent_id: TENANT.agentId,
  };
}

// ── 稳定序列化 ───────────────────────────────────────────────────────────────

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v;
    }
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

// ── fixture store（可观测子集）───────────────────────────────────────────────

export interface GoldenStore {
  // 语料
  corpus: L1Row[];
  addCorpusRow(row: L1Row): void;
  // store 面
  countL1(t?: unknown): number;
  listL1TenantTriplets(): CoreTenant[];
  queryL1Records(filter?: { agentId?: string }): L1Row[];
  listValuesAnyState(t?: unknown): Promise<ValueRow[]>;
  listValues(t?: unknown): Promise<ValueRow[]>;
  upsertValue(valueId: string, label: string, weight: number, createdBy: string, tenant?: unknown, valence?: number, origin?: string, nodeType?: string, attrs?: Record<string, unknown> | undefined): Promise<boolean>;
  retireValue(valueId: string, t?: unknown): Promise<boolean>;
  readCore(t?: unknown): Array<{ slot: string; content: string }>;
  upsertCore(slot: string, content: string, source: string, t?: unknown): boolean;
  upsertPendingCore(slot: string, content: string, evidence: number, t?: unknown, extra?: { label?: string; description?: string }): boolean;
  listPendingCore(t?: unknown, o?: { includeDecided?: boolean }): PendingRow[];
  backfillMemoryRef(recordId: string, key: string, label: string, t?: unknown): boolean;
  getAnchorGrowthState(...args: unknown[]): { lastDiscoveryAt?: string | null; lastCorpusCount?: number | null; lastAttemptAt?: string | null; lastAdoptedAt?: string | null; lastMaintAt?: string | null };
  setAnchorGrowthState(stateOrKey: unknown, valueOrTenant?: unknown, maybeTenant?: unknown): void;
  getIdentityDiscoveryState(t?: unknown): { lastAttemptAt?: string; lastCorpusCount?: number; supportMap?: Record<string, string[]> };
  setIdentityDiscoveryState(state: unknown, t?: unknown): void;
  recentAffectSignals(t?: unknown): never[];
  /** 快照专用：全态锚行克隆（含 retired） */
  valuesForSnapshot(): ValueRow[];
  // 观测（defineProperty 注入，字面量不含——Omit 后断言）
  calls: {
    upsertValue: Array<{ valueId: string; label: string; weight: number; createdBy: string; valence?: number; origin?: string; nodeType?: string; attrs?: Record<string, unknown> | undefined }>;
    retireValue: Array<{ valueId: string }>;
    upsertCore: Array<{ slot: string; content: string; source: string }>;
    upsertPendingCore: Array<{ slot: string; content: string; evidence: number; label?: string; description?: string }>;
    backfillMemoryRef: Array<{ recordId: string; key: string; label: string }>;
  };
}

export function createGoldenStore(seed?: { rows?: L1Row[]; values?: ValueRow[]; core?: Array<{ slot: string; content: string }> }): GoldenStore {
  const corpus: L1Row[] = [...(seed?.rows ?? [])];
  const values: ValueRow[] = (seed?.values ?? []).map((v) => ({ ...v }));
  const core = new Map<string, { slot: string; content: string; version: number; source: string }>();
  for (const s of seed?.core ?? []) core.set(s.slot, { slot: s.slot, content: s.content, version: 1, source: "seed" });
  const pendings: PendingRow[] = [];
  const growthState: Record<string, unknown> = {};
  let identityState: { lastAttemptAt?: string; lastCorpusCount?: number; supportMap?: Record<string, string[]> } = {};
  const calls = {
    upsertValue: [] as GoldenStore["calls"]["upsertValue"],
    retireValue: [] as GoldenStore["calls"]["retireValue"],
    upsertCore: [] as GoldenStore["calls"]["upsertCore"],
    upsertPendingCore: [] as GoldenStore["calls"]["upsertPendingCore"],
    backfillMemoryRef: [] as GoldenStore["calls"]["backfillMemoryRef"],
  };

  const base: Omit<GoldenStore, "calls"> = {
    corpus,
    addCorpusRow(row) { corpus.push(row); },
    countL1() { return corpus.length; },
    listL1TenantTriplets() { return [TENANT]; },
    queryL1Records(filter) {
      const rows = filter?.agentId ? corpus.filter((r) => (r.agent_id ?? "default") === filter.agentId) : corpus;
      return rows.map((r) => ({ ...r }));
    },
    async listValuesAnyState() { return values.map((v) => ({ ...v })); },
    async listValues() { return values.filter((v) => v.state === "active").map((v) => ({ ...v })); },
    async upsertValue(valueId, label, weight, createdBy, _tenant, valence, origin, nodeType, attrs) {
      calls.upsertValue.push({ valueId, label, weight: Math.round(weight * 1e4) / 1e4, createdBy, valence, origin, nodeType, attrs: attrs === undefined ? undefined : JSON.parse(JSON.stringify(attrs)) });
      const hit = values.find((v) => v.value_id === valueId);
      if (hit) {
        hit.label = label;
        hit.weight = weight;
        hit.state = "active";
        if (valence !== undefined) hit.valence = valence;
        if (attrs !== undefined) hit.attrs_json = JSON.stringify(attrs);
      } else {
        values.push({
          value_id: valueId, label, weight, created_by: createdBy, valence: valence ?? null,
          origin: origin ?? "auto", pinned: 0, state: "active", node_type: nodeType ?? "theme",
          attrs_json: attrs === undefined ? null : JSON.stringify(attrs),
          team_id: TENANT.teamId, user_id: TENANT.userId, agent_id: TENANT.agentId,
        });
      }
      return true;
    },
    async retireValue(valueId) {
      calls.retireValue.push({ valueId });
      const hit = values.find((v) => v.value_id === valueId);
      if (hit) hit.state = "retired";
      return true;
    },
    readCore() { return [...core.values()].map((s) => ({ slot: s.slot, content: s.content })); },
    upsertCore(slot, content, source) {
      calls.upsertCore.push({ slot, content, source });
      const prev = core.get(slot);
      core.set(slot, { slot, content, version: (prev?.version ?? 0) + 1, source });
      return true;
    },
    upsertPendingCore(slot, content, evidence, _tenant, extra) {
      calls.upsertPendingCore.push({ slot, content, evidence, label: extra?.label, description: extra?.description });
      const pid = `pnd-${slot}-${content.slice(0, 24)}`;
      const hit = pendings.find((p) => p.pending_id === pid);
      if (hit && hit.state === "pending") {
        hit.evidence = evidence;
        hit.label = extra?.label;
        hit.description = extra?.description;
      } else if (!hit) {
        pendings.push({ pending_id: pid, slot, content, evidence, label: extra?.label, description: extra?.description, state: "pending", created_at: GOLDEN_NOW.toISOString() });
      }
      return true;
    },
    listPendingCore() {
      return pendings
        .map((p) => ({ ...p }))
        .sort((a, b) => (a.created_at === b.created_at ? (a.slot + a.content < b.slot + b.content ? -1 : 1) : a.created_at < b.created_at ? 1 : -1));
    },
    backfillMemoryRef(recordId, key, label) {
      calls.backfillMemoryRef.push({ recordId, key, label });
      return true;
    },
    getAnchorGrowthState(...args: unknown[]) {
      const t = args[0] as { teamId?: string } | undefined;
      if (t && typeof t === "object" && (t.teamId !== undefined && t.teamId !== TENANT.teamId)) {
        return { lastDiscoveryAt: null, lastCorpusCount: null };
      }
      return { ...growthState } as ReturnType<GoldenStore["getAnchorGrowthState"]>;
    },
    setAnchorGrowthState(stateOrKey, valueOrTenant, maybeTenant) {
      const t = (typeof stateOrKey === "string" ? valueOrTenant : maybeTenant) as { teamId?: string } | undefined;
      if (t && typeof t === "object" && t.teamId !== undefined && t.teamId !== TENANT.teamId) return;
      if (typeof stateOrKey === "string") growthState[stateOrKey] = valueOrTenant;
      else Object.assign(growthState, stateOrKey as Record<string, unknown>);
    },
    getIdentityDiscoveryState() { return { ...identityState }; },
    setIdentityDiscoveryState(state) { identityState = { ...identityState, ...(state as typeof identityState) }; },
    recentAffectSignals() { return []; },
    valuesForSnapshot() { return values.map((v) => ({ ...v })); },
  };
  const store = Object.defineProperty(base, "calls", { value: calls, enumerable: true }) as GoldenStore;
  return store;
}

// ── LLM 脚本 runner ──────────────────────────────────────────────────────────

export interface ScriptedRunner {
  run(p: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string>;
  prompts: Array<{ taskId: string; prompt: string }>;
}

export function scriptedRunner(replies: Record<string, string>): ScriptedRunner {
  const prompts: ScriptedRunner["prompts"] = [];
  return {
    prompts,
    async run(p) {
      prompts.push({ taskId: p.taskId, prompt: p.prompt });
      const reply = replies[p.taskId];
      if (reply === undefined) throw new Error(`[golden] unexpected LLM taskId: ${p.taskId}`);
      return reply;
    },
  };
}

// ── 快照采集 ─────────────────────────────────────────────────────────────────

export interface GoldenLayers {
  /** 第 1 层：锚集终态（upsert/retire 后，按 value_id 稳定排序） */
  values: Array<{ value_id: string; label: string; weight: number; state: string; node_type: string; origin: string; pinned: number; valence: number | null; attrs: unknown }>;
  /** 第 1 层附：锚写路径调用序列（可观测行为） */
  valueCalls: GoldenStore["calls"]["upsertValue"];
  /** 第 2 层：红线 pending（slot/content/evidence/label/description + 状态） */
  pending: GoldenStore["calls"]["upsertPendingCore"];
  /** 第 3 层：retire 决策序列 */
  retires: GoldenStore["calls"]["retireValue"];
  /** 第 3 层附：两管线返回计数 */
  results: { identity?: unknown; growth?: unknown };
  /** 第 4 层：core slots 终态 + soul 渲染全文 */
  core: Array<{ slot: string; content: string }>;
  soul: string | null;
}

export function snapshotLayers(store: GoldenStore, results: GoldenLayers["results"], soul: string | null): GoldenLayers {
  return {
    values: store.valuesForSnapshot().sort((a, b) => (a.value_id < b.value_id ? -1 : 1)).map((v) => ({
      value_id: v.value_id,
      label: v.label,
      weight: Math.round(v.weight * 1e4) / 1e4,
      state: v.state,
      node_type: v.node_type,
      origin: v.origin,
      pinned: v.pinned,
      valence: v.valence,
      attrs: v.attrs_json ? JSON.parse(v.attrs_json) : null,
    })),
    valueCalls: store.calls.upsertValue,
    pending: store.calls.upsertPendingCore,
    retires: store.calls.retireValue,
    results,
    core: store.calls.upsertCore.map((c) => ({ slot: c.slot, content: c.content })),
    soul,
  };
}
