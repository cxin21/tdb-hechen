/**
 * S-CHAR-2（M2/P2，DS-SOUL-EVOLUTION-001 §2.2/§7.2）：品格张力检测单一源纯函数。
 *
 * 张力信号两类（满足其一即候选，确定性、零 LLM、零随机）：
 *   - T2 证据分裂 detectEvidenceSplit：同锚（label）支撑证据 valence 方向分裂
 *     （正负各 ≥ minInstances 条，缺省 2）；数据源=store.anchorEvidenceValences（P1 只读查询）。
 *   - T1 演化反向 detectEvolutionReversal：self_identity 修订前后同价值域极性对照
 *     （「不做 X」→「做 X」类；极性词表确定性匹配——设计 §2.4 禁止 LLM 极性判定）。
 *
 * 红线：本模块只产出候选张力实例（内存传递、不落表，O14 边界）；落库裁决走既有
 * 确定性门族（F19/F15 分池，R-D 不新造门）；品格不入感受段（R-B）；
 * 品格张力不产生 identityRefs（R-C 扩展——蒸馏物非事实）。
 */

/** T2 输入证据行：label=valence 所挂的价值域/锚 label（identityRefs 为 20 字切片弱口径，消费方匹配自然过滤）。 */
export interface EvidenceValenceInput {
  label: string;
  valence: number;
  recordId?: string;
  ref_kind?: "coreRefs" | "identityRefs";
}

/** T2 输出：tension=true 时 tensionRefs 非空（两侧命中实例全量，带 recordId 供提案引用）。 */
export interface EvidenceSplitResult {
  tension: boolean;
  pos: number;
  neg: number;
  tensionRefs: Array<{ recordId?: string; valence: number }> | null;
}

/** T1 输出：tension=true 时 reversed 非空（发生极性翻转的价值域 label 列表）。 */
export interface EvolutionReversalResult {
  tension: boolean;
  reversed: string[] | null;
}

/** 极性词表（确定性匹配）：label 前缀窗口内命中任一词 → 负极性；否则正极性。 */
const NEGATION_WORDS: readonly string[] = ["不做", "不再", "拒绝", "避免", "放弃", "反对"];

/** 极性回看窗口（字符）：label 出现位置前最多回看 8 字符找极性词。 */
const POLARITY_WINDOW = 8;

/** 单文本内 label 各出现点的极性集合（正负混杂=极性歧义，size>1 不可判）。 */
function polaritiesOf(text: string, label: string): Set<"pos" | "neg"> {
  const out = new Set<"pos" | "neg">();
  if (!text || !label) return out;
  let idx = text.indexOf(label);
  while (idx !== -1) {
    const prefix = text.slice(Math.max(0, idx - POLARITY_WINDOW), idx);
    out.add(NEGATION_WORDS.some((w) => prefix.includes(w)) ? "neg" : "pos");
    idx = text.indexOf(label, idx + label.length);
  }
  return out;
}

/** T1 演化反向：修订前后同价值域极性对照。单侧极性歧义（同文本正负混杂）或 label 未出现 → 该 label 跳过（宁缺毋滥）。 */
export function detectEvolutionReversal(before: string, after: string, labels: string[]): EvolutionReversalResult {
  const reversed: string[] = [];
  for (const label of labels ?? []) {
    if (typeof label !== "string" || label.length === 0) continue;
    const pb = polaritiesOf(before, label);
    const pa = polaritiesOf(after, label);
    if (pb.size !== 1 || pa.size !== 1) continue;
    const beforePol = [...pb][0]!;
    const afterPol = [...pa][0]!;
    if (beforePol !== afterPol) reversed.push(label);
  }
  return { tension: reversed.length > 0, reversed: reversed.length > 0 ? reversed : null };
}

/** T2 证据分裂：同锚支撑证据 valence 方向分裂检测。valence=0 中性与非有限值不计入（宁缺毋滥）。 */
export function detectEvidenceSplit(anchorLabel: string, valences: EvidenceValenceInput[], minInstances: number): EvidenceSplitResult {
  const matched = (valences ?? []).filter(
    (v) => !!v && v.label === anchorLabel && typeof v.valence === "number" && Number.isFinite(v.valence),
  );
  let pos = 0;
  let neg = 0;
  for (const v of matched) {
    if (v.valence > 0) pos++;
    else if (v.valence < 0) neg++;
  }
  const min = Number(minInstances) > 0 ? Math.floor(Number(minInstances)) : 2;
  const tension = pos >= min && neg >= min;
  return {
    tension,
    pos,
    neg,
    tensionRefs: tension
      ? matched.map((v) => (v.recordId !== undefined ? { recordId: v.recordId, valence: v.valence } : { valence: v.valence }))
      : null,
  };
}

// ── M2/P3（S-CHAR-2）：张力候选内存传递注册表（消费方=identity-discovery worker；O14：不落表）──

/** 张力实例引用：T2=记忆 recordId+valence；T1=身份修订时刻 at。 */
export interface TensionRef { recordId?: string; valence?: number; at?: string }

/** 张力候选：检测器产出 → worker prompt 段 → characterProposal 确定性门的引用依据。 */
export interface TensionCandidate {
  source: "T1" | "T2";
  label: string;
  rationale: string;
  tensionRefs: TensionRef[];
  detectedAt: string;
}

const candidateRegistry = new Map<string, TensionCandidate[]>();
const REGISTRY_DEFAULT_CAP = 50;

function tenantRegistryKey(tenant?: { teamId?: string; userId?: string; agentId?: string } | null): string {
  if (!tenant) return JSON.stringify(["default", "default", "default"]);
  return JSON.stringify([tenant.teamId ?? "default", tenant.userId ?? "default", tenant.agentId ?? "default"]);
}

/** 记录张力候选（追加；超 cap 丢最旧——内存传递有界，防长跑膨胀）。 */
export function recordTensionCandidates(tenant: { teamId?: string; userId?: string; agentId?: string } | undefined | null, candidates: TensionCandidate[], cap = REGISTRY_DEFAULT_CAP): void {
  if (!candidates || candidates.length === 0) return;
  const key = tenantRegistryKey(tenant);
  const list = candidateRegistry.get(key) ?? [];
  for (const c of candidates) list.push(c);
  while (list.length > cap) list.shift();
  candidateRegistry.set(key, list);
}

/** 消费张力候选（一次性：读后即清——候选只入内存传递，drain 后不留存量）。 */
export function drainTensionCandidates(tenant: { teamId?: string; userId?: string; agentId?: string } | undefined | null): TensionCandidate[] {
  const key = tenantRegistryKey(tenant);
  const list = candidateRegistry.get(key);
  candidateRegistry.delete(key);
  return list ?? [];
}

/** T2 候选计算：非 person 活跃锚逐个 detectEvidenceSplit（单一源纯函数；调用方=anchor-growth GROW-MAINT 挂点）。 */
export function computeT2Candidates(anchorLabels: string[], valences: EvidenceValenceInput[], minInstances: number, nowIso: string): TensionCandidate[] {
  const out: TensionCandidate[] = [];
  for (const label of anchorLabels ?? []) {
    if (typeof label !== "string" || label.length === 0) continue;
    const split = detectEvidenceSplit(label, valences, minInstances);
    if (split.tension && split.tensionRefs) {
      out.push({
        source: "T2",
        label,
        rationale: `证据分裂：正 ${split.pos} 条 / 负 ${split.neg} 条`,
        tensionRefs: split.tensionRefs,
        detectedAt: nowIso,
      });
    }
  }
  return out;
}
