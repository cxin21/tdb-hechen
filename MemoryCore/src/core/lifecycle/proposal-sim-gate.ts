/**
 * #81：self_identity 提案相似门 + 生成端抑制（洪泛修复 Phase 0 定案，拍板 2026-10-21）。
 *
 * 洪泛机理（#81 取证）：self_identity 提案层仅有精确去重（proposalAlreadyKnown 全等），
 * 无语义门无过期；LLM 每周期以互异文案复读同主题自我纪律 → core_pending 单日 +110。
 * 本模块给两道确定性闸门（零 LLM，embedder 走既有 EmbeddingService）：
 * 1. similarSelfIdentityProposalExists——提案落库前比对候选（core_pending slot=self_identity
 *    state=pending 全量 + core 槽行 identity/self_identity），cosine ≥ threshold → 拦截。
 *    阈值 0.65 由生产模型标定（#81 票评：[0.60,0.65) 与 [0.65,0.70) 带内目验全为语义同构）。
 * 2. buildSelfIdentitySuppressionLines——生成端注入「已有身份认知」段（镜像
 *    core-values-discover「不得重复提议」软注入先例 + identity-discovery 同式先例）。
 *
 * 降级合同（宁漏勿误，镜像 embed-helpers）：embedder 缺席/抛错、store 缺方法/抛错 →
 * 放行/不注入，绝不阻塞写链；精确重复短路（normalizeProposalText 全等）在无 embedder
 * 时仍生效，闸门不漏精确重复。
 *
 * 配置：ReflectionConfig.selfIdentityGate{enabled?;threshold?;suppression?{enabled?;maxPending?}}；
 * 拍板：闸门缺省开、抑制缺省开、阈值缺省 0.65 config 可配。
 */
import { normalizeProposalText } from "./soul-reflection-proposals.js";

export const SIM_GATE_DEFAULT_THRESHOLD = 0.65;
export const SIM_GATE_SLOT = "self_identity";

const SUPPRESSION_MARKER = "已有身份认知（这些主题不得重复提议，语义相近的表达也算重复）：";
const SUPPRESSION_ITEM_MAX_CHARS = 160;
const SUPPRESSION_TAIL = "（以上为已确认或在途的身份认知；新提案必须与之语义明显不同，语义相近的表达也算重复，宁可不提。）";
// 生产实锚（2026-10-22 core 日志）：ark embedding 单批上限 10（>10 即 HTTP 400 InvalidParameter），
// 超限会令闸门 100% 走降级放行（洪泡修复失效根因）；10 为全 provider 通用安全批。
const EMBED_CHUNK = 10;
// 生产实锚（2026-10-22 core 日志 07:14/07:24 两 beat）：每提案重嵌全量 corpus（≈228 条÷10≈23 次 API），
// beat 连发 3-6 提案即触发 ark 429 AccountRateLimitExceeded → catch 降级放行 → 洪泛续命。
// 处置：①向量进程内缓存（同 embedder 实例 corpus 只嵌一次，后续调用仅嵌新候选，API 量 23→1）；
// ②embedBatch 对 HTTP 429 退避重试（1s/3s/6s/12s，合计 22s 有界），持续失败仍走既有降级合同（宁漏勿误）；
// ③块间 pacing 400ms——生产实锚 2026-10-22 09:23 冷启动：冷缓存首调全量 corpus（≈250 条÷10≈26 块）
// 背靠背 burst 仍触发 ark 账户级 429（与 embed-backfill/l1-writer 共享配额），多块必须错峰。
// 缓存绑定 embedder 服务实例身份：换实例（含换模型/进程重启）即清空，杜绝跨模型脏向量。
const RATE_LIMIT_HTTP_429 = /HTTP 429/;
const RATE_LIMIT_RETRY_DELAYS_MS = [1_000, 3_000, 6_000, 12_000];
const CHUNK_PACING_MS = 400;
const EMBED_CACHE_CAP = 4096;
let cacheSvc: unknown = null;
const vecCache = new Map<string, Float32Array>();

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_HTTP_429.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SimGateRow = { slot?: unknown; content?: unknown };
type SimGateStore = {
  listPendingCore?(tenant?: unknown, opts?: { includeDecided?: boolean }): unknown;
  readCore?(tenant?: unknown): unknown;
};
type SimGateLogger = { info?(msg: string): void; warn?(msg: string): void };

function asArray(v: unknown): SimGateRow[] {
  return Array.isArray(v) ? (v as SimGateRow[]) : [];
}

function isSelfIdentityRow(r: SimGateRow): r is { slot: string; content: string } {
  return r != null && r.slot === SIM_GATE_SLOT && typeof r.content === "string" && (r.content as string).length > 0;
}

function isIdentitySlotRow(r: SimGateRow): r is { slot: string; content: string } {
  return r != null && (r.slot === "identity" || r.slot === SIM_GATE_SLOT) && typeof r.content === "string" && (r.content as string).length > 0;
}

/** cosine 相似度：空向量/长度不齐/零向量 → 0（宁缺毋滥，镜像 soul-dedupe 同名语义）。 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 结构化解析 embedder：embedBatch 优先（分块批调），否则逐条 embed 回退；均缺 → null。 */
function resolveEmbedder(svc: unknown): { batch?(texts: string[]): Promise<Float32Array[]>; single?(text: string): Promise<Float32Array> } | null {
  if (svc == null || typeof svc !== "object") return null;
  const s = svc as { embed?: unknown; embedBatch?: unknown };
  if (typeof s.embedBatch === "function") return { batch: s.embedBatch.bind(svc) as (texts: string[]) => Promise<Float32Array[]> };
  if (typeof s.embed === "function") return { single: s.embed.bind(svc) as (text: string) => Promise<Float32Array> };
  return null;
}

/** 单块嵌入，HTTP 429 按序退避重试（1s/3s/6s/12s）；非限流错误或重试耗尽即抛出（交降级合同）。 */
async function embedChunkWithRetry(embedder: NonNullable<ReturnType<typeof resolveEmbedder>>, texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (embedder.batch) return await embedder.batch(texts);
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await embedder.single!(t));
      return out;
    } catch (err) {
      const delay = attempt < RATE_LIMIT_RETRY_DELAYS_MS.length && isRateLimitError(err) ? RATE_LIMIT_RETRY_DELAYS_MS[attempt]! : 0;
      if (!delay) throw err;
      await sleep(delay);
    }
  }
}

/** 带进程内向量缓存的批量嵌入：命中缓存的文本零 API 调用；位置严格保序（out[i] 对应 texts[i]）。 */
async function embedAll(embedder: NonNullable<ReturnType<typeof resolveEmbedder>>, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const missIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = vecCache.get(texts[i]!);
    if (hit) out[i] = hit;
    else missIdx.push(i);
  }
  for (let j = 0; j < missIdx.length; j += EMBED_CHUNK) {
    const idxs = missIdx.slice(j, j + EMBED_CHUNK);
    const chunkTexts = idxs.map((i) => texts[i]!);
    const vecs = await embedChunkWithRetry(embedder, chunkTexts);
    if (vecs.length !== idxs.length) throw new Error(`embedding batch size mismatch: got ${vecs.length}, want ${idxs.length}`);
    for (let k = 0; k < idxs.length; k++) {
      const text = chunkTexts[k]!;
      const vec = vecs[k]!;
      out[idxs[k]!] = vec;
      if (vecCache.size >= EMBED_CACHE_CAP) vecCache.clear();
      vecCache.set(text, vec);
    }
    // 块间 pacing（修复#3）：剩余还有块则错峰 CHUNK_PACING_MS 再嵌下一块（冷启动多块不背靠背 burst）。
    if (j + EMBED_CHUNK < missIdx.length) await sleep(CHUNK_PACING_MS);
  }
  return out;
}

/**
 * 相似门：候选=core_pending(slot=self_identity,state=pending) + core 槽行(identity/self_identity)。
 * 精确重复短路 → cosine ≥ threshold → true；无候选/降级 → false 放行。绝不抛出。
 */
export async function similarSelfIdentityProposalExists(args: {
  store?: SimGateStore | undefined;
  tenant?: unknown;
  content: string;
  threshold?: number;
  embeddingService?: unknown;
  logger?: SimGateLogger;
}): Promise<boolean> {
  const threshold = typeof args.threshold === "number" && args.threshold > 0 ? args.threshold : SIM_GATE_DEFAULT_THRESHOLD;
  try {
    const pendingRows = asArray(await Promise.resolve(args.store?.listPendingCore?.(args.tenant, { includeDecided: false }))).filter(isSelfIdentityRow);
    const coreRows = asArray(await Promise.resolve(args.store?.readCore?.(args.tenant))).filter(isIdentitySlotRow);
    const candidates = [...pendingRows.map((r) => r.content), ...coreRows.map((r) => r.content)];
    if (candidates.length === 0) return false;
    const norm = normalizeProposalText(args.content);
    if (candidates.some((c) => normalizeProposalText(c) === norm)) return true; // 精确重复短路（embedder 缺席也不漏）
    const embedder = resolveEmbedder(args.embeddingService);
    if (!embedder) return false; // 降级：无 embedder 放行（精确重复已短路）
    if (args.embeddingService !== cacheSvc) {
      cacheSvc = args.embeddingService;
      vecCache.clear();
    }
    const vecs = await embedAll(embedder, [args.content, ...candidates]);
    const base = vecs[0];
    if (!base || vecs.length !== candidates.length + 1) return false;
    for (let i = 1; i < vecs.length; i++) {
      const v = vecs[i];
      if (v && cosineSimilarity(base, v) >= threshold) return true;
    }
    return false;
  } catch (err) {
    args.logger?.warn?.(`[proposal-sim-gate] similarSelfIdentityProposalExists degraded (pass-through): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 防崩解析行内预嵌向量（embedding_json）：空/非数组/含非有限数 → null（宁缺毋滥）。 */
function parseEmbeddingJson(json: string | null | undefined): Float32Array | null {
  if (!json) return null;
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    if (!arr.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return new Float32Array(arr as number[]);
  } catch {
    return null;
  }
}

function pendingRowState(r: unknown): string {
  const s = (r as { state?: unknown } | null | undefined)?.state;
  return typeof s === "string" && s.length > 0 ? s : "pending";
}

/**
 * #91：相似门 Match 版——Exists 语义 + 返回命中行与候选向量（复现即投票的取数基建）。
 * 语料=core_pending(slot=self_identity, state∈{pending,expired}；includeDecided:true 拉全后
 * 白名单自滤，expired 留语料供 TTL 过期后再命中→计票复活；rejected/adopted 滤除)
 * + core 槽行(identity/self_identity)。行带 embedding_json（写入时预嵌向量落库）直读绕嵌；
 * 恒嵌候选：语料空也嵌提案本身（vector 恒供 push 支路 init 预嵌）。
 * 命中语义：pending 行→pending{pending_id,content,attrs_json}（计票写路径用）；core 行→仅 hit（拦不投）。
 * 精确重复短路在嵌前（embedder 缺席也生效，同 Exists）。降级合同同 Exists：绝不抛出。
 */
export async function similarSelfIdentityProposalMatch(args: {
  store?: SimGateStore | undefined;
  tenant?: unknown;
  content: string;
  threshold?: number;
  embeddingService?: unknown;
  logger?: SimGateLogger;
}): Promise<{ hit: boolean; pending?: { pending_id: string; content: string; attrs_json?: string | null }; vector?: Float32Array; degraded?: boolean }> {
  const threshold = typeof args.threshold === "number" && args.threshold > 0 ? args.threshold : SIM_GATE_DEFAULT_THRESHOLD;
  type GateRow = { slot: string; content: string; pending_id?: unknown; attrs_json?: unknown; embedding_json?: unknown };
  type MatchRes = { hit: boolean; pending?: { pending_id: string; content: string; attrs_json?: string | null }; vector?: Float32Array; degraded?: boolean };
  const hitOf = (row: GateRow, vector?: Float32Array): MatchRes => {
    const pid = typeof row.pending_id === "string" && row.pending_id.length > 0 ? row.pending_id : undefined;
    return {
      hit: true,
      ...(pid ? { pending: { pending_id: pid, content: row.content, attrs_json: typeof row.attrs_json === "string" ? row.attrs_json : null } } : {}),
      ...(vector ? { vector } : {}),
    };
  };
  try {
    const pendingRows = asArray(await Promise.resolve(args.store?.listPendingCore?.(args.tenant, { includeDecided: true })))
      .filter((r) => isSelfIdentityRow(r) && (pendingRowState(r) === "pending" || pendingRowState(r) === "expired")) as unknown as Array<GateRow>;
    const coreRows = asArray(await Promise.resolve(args.store?.readCore?.(args.tenant))).filter(isIdentitySlotRow) as unknown as Array<GateRow>;
    const norm = normalizeProposalText(args.content);
    const corpus: Array<{ row: GateRow; vec: Float32Array | null }> = [];
    for (const r of pendingRows) corpus.push({ row: r, vec: parseEmbeddingJson(typeof r.embedding_json === "string" ? r.embedding_json : null) });
    for (const r of coreRows) corpus.push({ row: r, vec: null });
    const exact = corpus.find((c) => normalizeProposalText(c.row.content) === norm);
    if (exact) return hitOf(exact.row); // 精确重复短路（embedder 缺席也不漏，同 Exists:159）
    const embedder = resolveEmbedder(args.embeddingService);
    if (!embedder) return { hit: false, degraded: true }; // 降级：无 embedder 放行（同 Exists:161）
    if (args.embeddingService !== cacheSvc) {
      cacheSvc = args.embeddingService;
      vecCache.clear();
    }
    const toEmbed = corpus.filter((c) => c.vec == null).map((c) => c.row.content);
    // 恒嵌候选（#91）：语料空 texts=[content] 仍嵌一次，vector 供 push 支路 init 预嵌。
    const vecs = await embedAll(embedder, [args.content, ...toEmbed]);
    const base = vecs[0];
    if (!base) return { hit: false, degraded: true };
    let k = 1;
    for (const c of corpus) {
      if (c.vec == null) {
        c.vec = vecs[k] ?? null;
        k++;
      }
      if (c.vec && cosineSimilarity(base, c.vec) >= threshold) return hitOf(c.row, base);
    }
    return { hit: false, vector: base };
  } catch (err) {
    args.logger?.warn?.(`[proposal-sim-gate] similarSelfIdentityProposalMatch degraded: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, degraded: true };
  }
}

function truncateItem(s: string): string {
  return s.length > SUPPRESSION_ITEM_MAX_CHARS ? s.slice(0, SUPPRESSION_ITEM_MAX_CHARS) + "…" : s;
}

export type SelfIdentityMarker = { key: string; kind: "core" | "pending"; pid?: string; content: string };

/**
 * #91 返工（M-marker 路由）：抑制清单行带 [M#] 编号 + 返回 marker 映射（产卡 echo_key 指认回路的路由依据）。
 * core 行在前、pending 行在后，序号连续 M1..Mn。store 缺方法/抛错/无内容 → 空降级（绝不抛出）。
 */
export async function buildSelfIdentityMarkers(args: {
  store?: SimGateStore | undefined;
  tenant?: unknown;
  maxPending?: number;
  logger?: SimGateLogger;
}): Promise<{ lines: string[]; markers: SelfIdentityMarker[] }> {
  const max = typeof args.maxPending === "number" && args.maxPending > 0 ? Math.floor(args.maxPending) : 20;
  try {
    const coreRows = asArray(await Promise.resolve(args.store?.readCore?.(args.tenant))).filter(isIdentitySlotRow);
    const pendingRows = asArray(await Promise.resolve(args.store?.listPendingCore?.(args.tenant, { includeDecided: false }))).filter(isSelfIdentityRow);
    const markers: SelfIdentityMarker[] = [];
    let n = 0;
    for (const r of coreRows) markers.push({ key: `M${++n}`, kind: "core", content: r.content });
    for (const r of pendingRows.slice(0, max)) markers.push({ key: `M${++n}`, kind: "pending", pid: (r as { pending_id?: string }).pending_id, content: r.content });
    if (markers.length === 0) return { lines: [], markers: [] };
    const lines = [SUPPRESSION_MARKER, ...markers.map((m) => `- [${m.key}] ${truncateItem(m.content)}`), SUPPRESSION_TAIL];
    return { lines, markers };
  } catch (err) {
    args.logger?.warn?.(`[proposal-sim-gate] buildSelfIdentityMarkers degraded: ${err instanceof Error ? err.message : String(err)}`);
    return { lines: [], markers: [] };
  }
}

/**
 * 生成端抑制段装配：槽行 + 在途 pending（≤maxPending，缺省 20），逐条 160 字截断，行带 [M#] 编号。
 * store 缺方法/抛错/无内容 → []（不注入=逐位现状）。绝不抛出。
 */
export async function buildSelfIdentitySuppressionLines(args: {
  store?: SimGateStore | undefined;
  tenant?: unknown;
  maxPending?: number;
  logger?: SimGateLogger;
}): Promise<string[]> {
  return (await buildSelfIdentityMarkers(args)).lines;
}
