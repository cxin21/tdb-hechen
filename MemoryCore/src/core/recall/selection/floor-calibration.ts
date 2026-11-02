/**
 * #179 S4（2026-11-02）：嵌入相似度地板标定产物——读取与解析（纯函数 + 单文件缓存）。
 *
 * 规格 docs/specs/2026-11-02-recall-selection-layered-ruler-spec.md §4.4：
 *   产物 data/calibration/embedding-sim-floor.json，按 `${model}@${dims}` 组键，
 *   值 = null-probe（查询 × 无关行）分布 p95 + 测量日期 + 样本量，
 *   由仓库脚本对真实样本重算（scripts/calibrate-embedding-sim-floor.mjs）。
 *
 * 「标定真的」判据（任务本体）：键缺失时必须诚实 no-op（floor=null、journal
 * floorSource="uncalibrated"），绝不拿猜出来的地板去砍行。
 */
import fs from "node:fs";

export interface EmbeddingSimFloorRecord {
  model: string;
  dims: number;
  /** null-probe 相似度分布 p95（0~1）。 */
  value: number;
  measuredAt?: string;
  samples?: number;
  method?: string;
  source?: string;
}

export interface FloorCalibrationDoc {
  schemaVersion: 1;
  entries: Record<string, Omit<EmbeddingSimFloorRecord, "model" | "dims">>;
}

/** 标定产物相对 pluginDataDir 的落点（生产 pluginDataDir = D:\TDB\data）。 */
export const FLOOR_CALIBRATION_REL_PATH = "calibration/embedding-sim-floor.json";

/** 组键：换模型或换维度都必须失配（同一模型不同维度不可混用）。 */
export function embeddingSimFloorKey(model: string, dims: number): string {
  return `${model}@${dims}`;
}

/**
 * 余弦相似度。口径：
 *   - 维度不符 / 空向量 / 任一侧零模长 → null（「算不出来」不许冒充 0 分）；
 *   - 非有限分量 → null（NaN/Infinity 不参与标定）。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(sim) ? sim : null;
}

/** 最近秩分位数（nearest-rank）：k = max(1, ceil(p×n))，返回升序第 k 个；空数组 → null。 */
export function percentileNearestRank(values: readonly number[], p: number): number | null {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  const sorted = [...clean].sort((x, y) => x - y);
  const k = Math.max(1, Math.ceil(clamped * sorted.length));
  return sorted[Math.min(sorted.length - 1, k - 1)]!;
}

/** 标定样本下限：少于这个数不写地板（宁缺毋滥，样本不足时诚实 no-op）。 */
export const NULL_PROBE_MIN_SAMPLES = 50;

/**
 * null-probe（查询 × 无关行）相似度分布的 p95。样本 < minSamples → null。
 * 用 p95 而不是均值：地板要挡的正是「无关行里最像的那一撮」。
 */
export function nullProbeP95(samples: readonly number[], minSamples: number = NULL_PROBE_MIN_SAMPLES): number | null {
  const clean = samples.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length < Math.max(1, Math.floor(minSamples)) || clean.length === 0) return null;
  const p95 = percentileNearestRank(clean, 0.95);
  if (p95 === null) return null;
  // 地板必须是合法相似度区间内的值；越界（理论上余弦到不了）宁可不写
  return p95 >= 0 && p95 <= 1 ? p95 : null;
}

function isFiniteSim(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 生成标定产物（脚本与用例共用；保证可被 parseFloorCalibration 读回）。 */
export function buildFloorCalibration(
  records: readonly EmbeddingSimFloorRecord[],
  opts: { generatedAt?: string } = {},
): string {
  const entries: FloorCalibrationDoc["entries"] = {};
  for (const r of records) {
    if (!isFiniteSim(r.value)) continue;
    const key = embeddingSimFloorKey(r.model, r.dims);
    const rec: Omit<EmbeddingSimFloorRecord, "model" | "dims"> = { value: r.value };
    if (r.measuredAt) rec.measuredAt = r.measuredAt;
    if (typeof r.samples === "number") rec.samples = r.samples;
    if (r.method) rec.method = r.method;
    if (r.source) rec.source = r.source;
    entries[key] = rec;
  }
  const doc: FloorCalibrationDoc & { generatedAt?: string } = { schemaVersion: 1, entries };
  if (opts.generatedAt) doc.generatedAt = opts.generatedAt;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * 解析标定产物。坏 JSON / 坏形状 / 非法值一律返回空表（诚实 no-op），绝不抛出：
 * 标定文件是运维手改面，读坏它不能把召回主链路带崩。
 */
export function parseFloorCalibration(text: string): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof text !== "string" || text.trim().length === 0) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  const entries = (doc as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return out;
  for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (!key.includes("@")) continue;
    if (!raw || typeof raw !== "object") continue;
    const value = (raw as { value?: unknown }).value;
    if (!isFiniteSim(value)) continue;
    out.set(key, value);
  }
  return out;
}

export interface ResolvedEmbeddingSimFloor {
  value: number | null;
  source: "config" | "calibration" | "uncalibrated";
}

/**
 * 地板取值优先级：配置显式值 > 标定产物 > 未标定（null）。
 * 未标定即「诚实 no-op」——不猜地板，选线只靠名次尺。
 */
export function resolveEmbeddingSimFloor(input: {
  configured: number | null | undefined;
  calibration: ReadonlyMap<string, number> | undefined;
  model: string | undefined;
  dims: number | undefined;
}): ResolvedEmbeddingSimFloor {
  const cfg = input.configured;
  if (typeof cfg === "number" && Number.isFinite(cfg)) {
    return { value: cfg, source: "config" };
  }
  const model = input.model;
  const dims = input.dims;
  if (model && typeof dims === "number" && Number.isFinite(dims) && input.calibration) {
    const hit = input.calibration.get(embeddingSimFloorKey(model, dims));
    if (typeof hit === "number" && Number.isFinite(hit)) return { value: hit, source: "calibration" };
  }
  return { value: null, source: "uncalibrated" };
}

interface CacheEntry {
  mtimeMs: number;
  map: Map<string, number>;
}
const fileCache = new Map<string, CacheEntry>();

/**
 * 读标定文件（按路径 + mtime 缓存）。文件缺失/读错 → 空表；不抛、不重试。
 * 缓存按 mtime 失效：重算标定后无需重启 core 即可看到新值（mode 本身仍走启动期配置）。
 */
export function loadFloorCalibrationFile(filePath: string): Map<string, number> {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    fileCache.delete(filePath);
    return new Map();
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.map;
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return new Map();
  }
  const map = parseFloorCalibration(text);
  fileCache.set(filePath, { mtimeMs, map });
  return map;
}
