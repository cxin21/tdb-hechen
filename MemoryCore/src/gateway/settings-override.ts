/**
 * Admin settings override — {baseDir}/config-override.json 的读写/校验。
 * 优先级：override > TDAI_LLM_* env > tdai-gateway.yaml（spec §3.2）——
 * 管理员显式意图优先级最高，高于环境变量与 yaml 配置。仅覆盖 llm / embedding /
 * rerank 三段（rerank 为 P1 task-4 新增，与 embedding 同款校验/持久化语义）。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface LlmSettingsOverride {
  baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number; timeoutMs?: number;
}
export interface EmbeddingSettingsOverride {
  provider?: string; baseUrl?: string; apiKey?: string; model?: string; dimensions?: number;
  sendDimensions?: boolean;
}
/**
 * rerank 段（P1 task-4，spec §4.3 keys：memory.recall.rerank.*）。字段语义与
 * MemoryCore/src/config.ts parseConfig 的 rerank 块一致；clamp（timeoutMs/candidates
 * 下界、minScore 缺省）在 parse 落地，这里只做形状校验。
 */
export interface RerankSettingsOverride {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  candidates?: number;
  minScore?: number;
  local?: { modelDir?: string; idleUnloadMs?: number };
}
/**
 * importancePenalty 段（P1 task-7，keys：memory.recall.importancePenalty.*）。
 * 字段语义与 MemoryCore/src/config.ts parseConfig 的 importancePenalty 块一致；
 * clamp（penalty [0,0.9]）在 parse 落地，这里只做形状校验。
 */
export interface ImportancePenaltySettingsOverride {
  enabled?: boolean;
  penalty?: number;
}
/** worthiness 段（P1 task-7，keys：memory.worthiness.extractionEnabled）。 */
export interface WorthinessSettingsOverride {
  extractionEnabled?: boolean;
}
/**
 * extraction 段（#46 收口，keys：memory.extraction.scenePoisonSplit /
 * sceneBatchMaxChars）。字段语义与 MemoryCore/src/config.ts parseConfig 的
 * extraction 块一致；clamp（sceneBatchMaxChars Math.max(0,…)）在 parse 落地，
 * 这里只做形状校验。
 */
export interface ExtractionSettingsOverride {
  scenePoisonSplit?: boolean;
  sceneBatchMaxChars?: number;
}
/**
 * layerRuler 段（#179 S5，keys：memory.recall.layerRuler.*）。
 * 字段语义与 MemoryCore/src/config.ts parseConfig 的 layerRuler 块一致：
 * 非法 mode / 非有限 keepRatio / minPerLayer<1 一律在 parse 回落「今天行为」
 * （off / 0.67 / 1），这里只做形状校验，不做 clamp 决策。
 */
export interface LayerRulerSettingsOverride {
  mode?: "off" | "shadow" | "enforce";
  keepRatio?: number;
  minPerLayer?: number;
  /** null = 不设地板（诚实 no-op）；{model,dims,value} 需与当前 embedding 端点同 model@dims 才生效。 */
  floor?: { model: string; dims: number; value: number } | null;
  /** v2 名次折扣 λ（0 = 纯余弦；缺省 0）。 */
  lengthLambda?: number;
  /** v2 层内相对 margin（null = 不裁；缺省 null）。 */
  margin?: number | null;
  /** v2 近重复抑制阈值（null = 不裁；缺省 null）。 */
  dedupeSim?: number | null;
  /** v3 单轮选线预算（毫秒，50..5000；缺省 300）。到点整段 bypass，走字符预算兜底。 */
  budgetMs?: number;
}
/**
 * injection 段（#179 S5，keys：memory.recall.injection.*）。
 * 代码缺省 foldIdentical=false、budgetByIntent 全 null（逐位现状）；
 * 服务上线切换时由这里写入生产建议值（规格 §4.3）。
 */
export interface InjectionSettingsOverride {
  foldIdentical?: boolean;
  /** v2 单行渲染上限（null = 不截断；缺省 null）。 */
  maxLineChars?: number | null;
  /** v3 本轮总字符预算（null = 不限；缺省 null）。 */
  maxChars?: number | null;
  budgetByIntent?: {
    empty?: number | null;
    continuation?: number | null;
    self?: number | null;
    info?: number | null;
  };
}
export interface SettingsOverride {
  llm?: LlmSettingsOverride;
  embedding?: EmbeddingSettingsOverride;
  rerank?: RerankSettingsOverride;
  importancePenalty?: ImportancePenaltySettingsOverride;
  worthiness?: WorthinessSettingsOverride;
  extraction?: ExtractionSettingsOverride;
  layerRuler?: LayerRulerSettingsOverride;
  injection?: InjectionSettingsOverride;
}

const OVERRIDE_FILE = "config-override.json";
const HTTP_URL_RE = /^https?:\/\/.+/i;

export function readSettingsOverride(dataDir: string): SettingsOverride | null {
  const p = join(dataDir, OVERRIDE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SettingsOverride;
  } catch {
    return null; // 损坏文件按无 override 处理，服务可正常启动
  }
}

/** 原子写：tmp + rename，避免半写文件被下次启动读到。 */
export function writeSettingsOverride(dataDir: string, o: SettingsOverride): void {
  const p = join(dataDir, OVERRIDE_FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 2), "utf-8");
  renameSync(tmp, p);
}

/** 只保留非 undefined 字段：override 中 undefined 不覆盖 base。 */
export function pickDefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function maskKey(key: string | undefined): { hasApiKey: boolean; apiKeyMasked: string } {
  if (!key) return { hasApiKey: false, apiKeyMasked: "" };
  return { hasApiKey: true, apiKeyMasked: key.length <= 4 ? "****" : `****${key.slice(-4)}` };
}

export function validateOverride(body: unknown): { ok: true; value: SettingsOverride } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: SettingsOverride = {};
  const b = (body ?? {}) as Record<string, any>;
  if (b.llm) {
    const llm: LlmSettingsOverride = {};
    if (b.llm.baseUrl !== undefined) {
      if (typeof b.llm.baseUrl === "string" && HTTP_URL_RE.test(b.llm.baseUrl)) llm.baseUrl = b.llm.baseUrl;
      else errors.push("llm.baseUrl 必须是合法 http(s) URL");
    }
    if (b.llm.apiKey !== undefined) {
      if (typeof b.llm.apiKey === "string") llm.apiKey = b.llm.apiKey;
      else errors.push("llm.apiKey 必须是字符串");
    }
    if (b.llm.model !== undefined) {
      if (typeof b.llm.model === "string" && b.llm.model.trim()) llm.model = b.llm.model.trim();
      else errors.push("llm.model 必须是非空字符串");
    }
    for (const intField of ["maxTokens", "timeoutMs"] as const) {
      if (b.llm[intField] !== undefined) {
        const n = Number(b.llm[intField]);
        // 0 = 不限制（2026-09-16 拍板：Ark 推理模型 thinking 需解除输出预算；避坑清单 #1）
        if (Number.isInteger(n) && n >= 0) llm[intField] = n;
        else errors.push(`llm.${intField} 必须是非负整数（0=不限制）`);
      }
    }
    if (Object.keys(llm).length) out.llm = llm;
  }
  if (b.embedding) {
    const emb: EmbeddingSettingsOverride = {};
    for (const strField of ["provider", "baseUrl", "apiKey", "model"] as const) {
      if (b.embedding[strField] !== undefined) {
        if (typeof b.embedding[strField] === "string") emb[strField] = b.embedding[strField];
        else errors.push(`embedding.${strField} 必须是字符串`);
      }
    }
    if (emb.baseUrl !== undefined && !HTTP_URL_RE.test(emb.baseUrl)) errors.push("embedding.baseUrl 必须是合法 http(s) URL");
    if (emb.model !== undefined && !emb.model.trim()) errors.push("embedding.model 必须是非空字符串");
    if (b.embedding.dimensions !== undefined) {
      const n = Number(b.embedding.dimensions);
      if (Number.isInteger(n) && n > 0) emb.dimensions = n;
      else errors.push("embedding.dimensions 必须是正整数");
    }
    if (b.embedding.sendDimensions !== undefined) {
      if (typeof b.embedding.sendDimensions === "boolean") emb.sendDimensions = b.embedding.sendDimensions;
      else errors.push("embedding.sendDimensions 必须是 boolean");
    }
    if (Object.keys(emb).length) out.embedding = emb;
  }
  if (b.rerank) {
    const rk: RerankSettingsOverride = {};
    for (const strField of ["provider", "baseUrl", "apiKey", "model"] as const) {
      if (b.rerank[strField] !== undefined) {
        if (typeof b.rerank[strField] === "string") rk[strField] = b.rerank[strField];
        else errors.push(`rerank.${strField} 必须是字符串`);
      }
    }
    if (rk.baseUrl !== undefined && !HTTP_URL_RE.test(rk.baseUrl)) errors.push("rerank.baseUrl 必须是合法 http(s) URL");
    if (rk.model !== undefined && !rk.model.trim()) errors.push("rerank.model 必须是非空字符串");
    // shadowMode 键已按用户 2026-10-14 拍板移除：旧 override 载荷若仍携带该键，
    // 这里静默忽略（不 400，也不再生效）。
    for (const boolField of ["enabled"] as const) {
      if (b.rerank[boolField] !== undefined) {
        if (typeof b.rerank[boolField] === "boolean") rk[boolField] = b.rerank[boolField];
        else errors.push(`rerank.${boolField} 必须是 boolean`);
      }
    }
    if (b.rerank.timeoutMs !== undefined) {
      const n = Number(b.rerank.timeoutMs);
      if (Number.isInteger(n) && n >= 0) rk.timeoutMs = n;
      else errors.push("rerank.timeoutMs 必须是非负整数");
    }
    if (b.rerank.candidates !== undefined) {
      const n = Number(b.rerank.candidates);
      // 范围 clamp（1..100）在 parseConfig（recallSignalBoost）落地，这里只校验形状
      if (Number.isInteger(n) && n > 0) rk.candidates = n;
      else errors.push("rerank.candidates 必须是正整数");
    }
    if (b.rerank.minScore !== undefined) {
      const n = Number(b.rerank.minScore);
      if (Number.isFinite(n)) rk.minScore = n;
      else errors.push("rerank.minScore 必须是数字（可为负）");
    }
    if (b.rerank.local) {
      const local: NonNullable<RerankSettingsOverride["local"]> = {};
      if (b.rerank.local.modelDir !== undefined) {
        if (typeof b.rerank.local.modelDir === "string") local.modelDir = b.rerank.local.modelDir;
        else errors.push("rerank.local.modelDir 必须是字符串");
      }
      if (b.rerank.local.idleUnloadMs !== undefined) {
        const n = Number(b.rerank.local.idleUnloadMs);
        if (Number.isInteger(n) && n >= 0) local.idleUnloadMs = n;
        else errors.push("rerank.local.idleUnloadMs 必须是非负整数（0=常驻不卸载）");
      }
      if (Object.keys(local).length) rk.local = local;
    }
    if (Object.keys(rk).length) out.rerank = rk;
  }
  if (b.importancePenalty) {
    const ip: ImportancePenaltySettingsOverride = {};
    for (const boolField of ["enabled"] as const) {
      if (b.importancePenalty[boolField] !== undefined) {
        if (typeof b.importancePenalty[boolField] === "boolean") ip[boolField] = b.importancePenalty[boolField];
        else errors.push(`importancePenalty.${boolField} 必须是 boolean`);
      }
    }
    if (b.importancePenalty.penalty !== undefined) {
      const n = Number(b.importancePenalty.penalty);
      // 范围 clamp（[0,0.9]）在 parseConfig（recallSignalBoost）落地，这里只校验形状
      if (Number.isFinite(n)) ip.penalty = n;
      else errors.push("importancePenalty.penalty 必须是数字");
    }
    if (Object.keys(ip).length) out.importancePenalty = ip;
  }
  if (b.worthiness) {
    const w: WorthinessSettingsOverride = {};
    if (b.worthiness.extractionEnabled !== undefined) {
      if (typeof b.worthiness.extractionEnabled === "boolean") w.extractionEnabled = b.worthiness.extractionEnabled;
      else errors.push("worthiness.extractionEnabled 必须是 boolean");
    }
    if (Object.keys(w).length) out.worthiness = w;
  }
  if (b.extraction) {
    const ex: ExtractionSettingsOverride = {};
    if (b.extraction.scenePoisonSplit !== undefined) {
      if (typeof b.extraction.scenePoisonSplit === "boolean") ex.scenePoisonSplit = b.extraction.scenePoisonSplit;
      else errors.push("extraction.scenePoisonSplit 必须是 boolean");
    }
    if (b.extraction.sceneBatchMaxChars !== undefined) {
      const n = Number(b.extraction.sceneBatchMaxChars);
      // 范围 clamp（Math.max(0,…)）在 parseConfig 落地，这里只校验形状（非负整数）
      if (Number.isInteger(n) && n >= 0) ex.sceneBatchMaxChars = n;
      else errors.push("extraction.sceneBatchMaxChars 必须是非负整数");
    }
    if (Object.keys(ex).length) out.extraction = ex;
  }
  if (b.layerRuler) {
    const lr: LayerRulerSettingsOverride = {};
    if (b.layerRuler.mode !== undefined) {
      if (b.layerRuler.mode === "off" || b.layerRuler.mode === "shadow" || b.layerRuler.mode === "enforce")
        lr.mode = b.layerRuler.mode;
      else errors.push("layerRuler.mode 必须是 off|shadow|enforce");
    }
    if (b.layerRuler.keepRatio !== undefined) {
      const n = Number(b.layerRuler.keepRatio);
      if (!Number.isFinite(n) || n <= 0 || n > 1) errors.push("layerRuler.keepRatio 必须是 (0,1] 的数字");
      else lr.keepRatio = n;
    }
    if (b.layerRuler.minPerLayer !== undefined) {
      const n = Number(b.layerRuler.minPerLayer);
      if (Number.isInteger(n) && n >= 1) lr.minPerLayer = n;
      else errors.push("layerRuler.minPerLayer 必须是 ≥1 的整数");
    }
    if (Object.prototype.hasOwnProperty.call(b.layerRuler, "floor")) {
      const f = b.layerRuler.floor;
      if (f === null) lr.floor = null;
      else if (f && typeof f === "object") {
        const model = typeof f.model === "string" ? f.model.trim() : "";
        const dims = Number(f.dims);
        const value = Number(f.value);
        if (!model) errors.push("layerRuler.floor.model 必须是非空字符串");
        else if (!Number.isInteger(dims) || dims <= 0) errors.push("layerRuler.floor.dims 必须是正整数");
        else if (!Number.isFinite(value) || value < 0 || value > 1)
          errors.push("layerRuler.floor.value 必须是 [0,1] 的数字");
        else lr.floor = { model, dims, value };
      } else errors.push("layerRuler.floor 必须是 null 或 {model,dims,value}");
    }
    if (b.layerRuler.lengthLambda !== undefined) {
      const n = Number(b.layerRuler.lengthLambda);
      if (Number.isFinite(n) && n >= 0 && n <= 1) lr.lengthLambda = n;
      else errors.push("layerRuler.lengthLambda 必须是 [0,1] 的数字");
    }
    if (Object.prototype.hasOwnProperty.call(b.layerRuler, "margin")) {
      const raw = b.layerRuler.margin;
      if (raw === null) lr.margin = null;
      else {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 2) lr.margin = n;
        else errors.push("layerRuler.margin 必须是 null 或 [0,2] 的数字");
      }
    }
    if (Object.prototype.hasOwnProperty.call(b.layerRuler, "dedupeSim")) {
      const raw = b.layerRuler.dedupeSim;
      if (raw === null) lr.dedupeSim = null;
      else {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= 1) lr.dedupeSim = n;
        else errors.push("layerRuler.dedupeSim 必须是 null 或 (0,1] 的数字");
      }
    }
    if (b.layerRuler.budgetMs !== undefined) {
      const n = Number(b.layerRuler.budgetMs);
      if (Number.isInteger(n) && n >= 50 && n <= 5000) lr.budgetMs = n;
      else errors.push("layerRuler.budgetMs 必须是 50..5000 的整数毫秒");
    }
    if (Object.keys(lr).length) out.layerRuler = lr;
  }
  if (b.injection) {
    const inj: InjectionSettingsOverride = {};
    if (b.injection.foldIdentical !== undefined) {
      if (typeof b.injection.foldIdentical === "boolean") inj.foldIdentical = b.injection.foldIdentical;
      else errors.push("injection.foldIdentical 必须是 boolean");
    }
    if (Object.prototype.hasOwnProperty.call(b.injection, "maxLineChars")) {
      const raw = b.injection.maxLineChars;
      if (raw === null) inj.maxLineChars = null;
      else {
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) inj.maxLineChars = n;
        else errors.push("injection.maxLineChars 必须是 null 或正整数");
      }
    }
    if (Object.prototype.hasOwnProperty.call(b.injection, "maxChars")) {
      const raw = b.injection.maxChars;
      if (raw === null) inj.maxChars = null;
      else {
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) inj.maxChars = n;
        else errors.push("injection.maxChars 必须是 null 或正整数");
      }
    }
    if (b.injection.budgetByIntent) {
      const bb: NonNullable<InjectionSettingsOverride["budgetByIntent"]> = {};
      for (const key of ["empty", "continuation", "self", "info"] as const) {
        const raw = (b.injection.budgetByIntent as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        if (raw === null) bb[key] = null;
        else {
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 0) bb[key] = n;
          else errors.push(`injection.budgetByIntent.${key} 必须是 null 或非负整数`);
        }
      }
      if (Object.keys(bb).length) inj.budgetByIntent = bb;
    }
    if (Object.keys(inj).length) out.injection = inj;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: out };
}

/**
 * rerank override 注入 memory 段原始配置（P1 task-4）。必须在 parseConfig 之前
 * 并入：rerank 的 provider 校验/非法回退 none/enabled 强制关闭/clamp 语义全部
 * 在 parseConfig 的 rerank 块内（MemoryCore/src/config.ts），parse 后再合并会
 * 绕过这些不变量。llm/embedding 仍走 parse 后合并（保持既有优先级与注释）。
 * 返回新对象，不改入参；override 为空时原样返回。
 */
export function applyRerankOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: RerankSettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const recallRaw = { ...((next.recall as Record<string, unknown> | undefined) ?? {}) };
  const rerankRaw = { ...((recallRaw.rerank as Record<string, unknown> | undefined) ?? {}) };
  const { local, ...top } = picked as RerankSettingsOverride;
  Object.assign(rerankRaw, pickDefined(top));
  if (local) {
    const localRaw = { ...((rerankRaw.local as Record<string, unknown> | undefined) ?? {}) };
    Object.assign(localRaw, pickDefined(local));
    rerankRaw.local = localRaw;
  }
  recallRaw.rerank = rerankRaw;
  next.recall = recallRaw;
  return next;
}

/**
 * importancePenalty override 注入 memory 段原始配置（P1 task-7）。必须在
 * parseConfig 之前并入：enabled/penalty clamp 缺省语义全部在
 * parseConfig 的 importancePenalty 块内（MemoryCore/src/config.ts），parse 后
 * 再合并会绕过这些不变量。返回新对象，不改入参；override 为空时原样返回。
 */
export function applyImportancePenaltyOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: ImportancePenaltySettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const recallRaw = { ...((next.recall as Record<string, unknown> | undefined) ?? {}) };
  const ipRaw = { ...((recallRaw.importancePenalty as Record<string, unknown> | undefined) ?? {}) };
  Object.assign(ipRaw, picked);
  recallRaw.importancePenalty = ipRaw;
  next.recall = recallRaw;
  return next;
}

/**
 * worthiness override 注入 memory 段原始配置（P1 task-7，parse 前合并——
 * extractionEnabled 缺省 false 语义在 parseConfig）。返回新对象，不改入参；
 * override 为空时原样返回。
 */
export function applyWorthinessOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: WorthinessSettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const wRaw = { ...((next.worthiness as Record<string, unknown> | undefined) ?? {}) };
  Object.assign(wRaw, picked);
  next.worthiness = wRaw;
  return next;
}

/**
 * layerRuler override 注入 memory 段原始配置（#179 S5）。必须在 parseConfig 之前并入：
 * mode 白名单 / keepRatio clamp / minPerLayer 取整 / floor 形状的全部不变量都在
 * parseConfig 的 layerRuler 块内，parse 后再合并会绕过它们。
 */
export function applyLayerRulerOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: LayerRulerSettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const recallRaw = { ...((next.recall as Record<string, unknown> | undefined) ?? {}) };
  const lrRaw = { ...((recallRaw.layerRuler as Record<string, unknown> | undefined) ?? {}) };
  Object.assign(lrRaw, picked);
  recallRaw.layerRuler = lrRaw;
  next.recall = recallRaw;
  return next;
}

/**
 * injection override 注入 memory 段原始配置（#179 S5）。必须在 parseConfig 之前并入：
 * budgetByIntent 的「null / 非负整数」语义在 parseConfig 落地。
 */
export function applyInjectionOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: InjectionSettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const recallRaw = { ...((next.recall as Record<string, unknown> | undefined) ?? {}) };
  const injRaw = { ...((recallRaw.injection as Record<string, unknown> | undefined) ?? {}) };
  if (picked.foldIdentical !== undefined) injRaw.foldIdentical = picked.foldIdentical;
  if (picked.maxLineChars !== undefined) injRaw.maxLineChars = picked.maxLineChars;
  if (picked.maxChars !== undefined) injRaw.maxChars = picked.maxChars;
  if (picked.budgetByIntent !== undefined) {
    const bRaw = { ...((injRaw.budgetByIntent as Record<string, unknown> | undefined) ?? {}) };
    Object.assign(bRaw, pickDefined(picked.budgetByIntent));
    injRaw.budgetByIntent = bRaw;
  }
  recallRaw.injection = injRaw;
  next.recall = recallRaw;
  return next;
}

/**
 * extraction override 注入 memory 段原始配置（#46 收口）。必须在 parseConfig
 * 之前并入：scenePoisonSplit 缺省 false / sceneBatchMaxChars Math.max(0,…)
 * clamp 语义全部在 parseConfig 的 extraction 块内（MemoryCore/src/config.ts），
 * parse 后再合并会绕过这些不变量。返回新对象，不改入参；override 为空时
 * 原样返回。
 */
export function applyExtractionOverrideToRaw(
  memoryCompatRaw: Record<string, unknown>,
  override: ExtractionSettingsOverride | undefined,
): Record<string, unknown> {
  const picked = pickDefined(override);
  if (!override || Object.keys(picked).length === 0) return memoryCompatRaw;
  const next: Record<string, unknown> = { ...memoryCompatRaw };
  const exRaw = { ...((next.extraction as Record<string, unknown> | undefined) ?? {}) };
  Object.assign(exRaw, picked);
  next.extraction = exRaw;
  return next;
}
