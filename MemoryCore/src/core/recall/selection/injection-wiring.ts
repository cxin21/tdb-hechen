/**
 * #179（2026-11-02）：注入选线的生产装配（把 cfg / 标定产物 / EmbeddingService 接到纯函数上）。
 *
 * 只做「取配置 + 读标定 + 包一层 embedBatch」，判定逻辑全在 injection-stage.ts（可单测）。
 * 关断纪律：mode="off" 时既不读标定文件也不调 embedding（零开销、零行为）。
 */
import path from "node:path";

import type { RecallConfig } from "../../../config.js";
import type { EmbeddingService } from "../../store/embedding.js";
import {
  applyInjectionSelection,
  type InjectionBudgetByIntent,
  type InjectionStageOutcome,
} from "./injection-stage.js";
import { FLOOR_CALIBRATION_REL_PATH, loadFloorCalibrationFile } from "./floor-calibration.js";

export interface InjectionWiringInput {
  /** 本轮准备注入的行（注入序）。 */
  lines: readonly string[];
  /** 原始查询（意图判定与相似度打分都用它）。 */
  query: string;
  cfg: RecallConfig | undefined;
  /** 插件数据目录（生产 D:\TDB\data）；标定产物在 <pluginDataDir>/calibration/ 下。 */
  pluginDataDir: string;
  embeddingService?: EmbeddingService;
  /** 上一回合注入行指纹（钩子路台账；缺省 = 不折叠）。 */
  previousHash?: string;
  now?: () => number;
}

/**
 * provider 单请求输入上限。实测 doubao-embedding-vision（生产 embedding 端点）
 * 一次最多 10 条输入，超限 HTTP 400 InvalidParameter → 整段 bypass（2026-11-02 踩到）。
 * 取 10 而不是 256：宁多几次请求，也不赌端点宽容度；典型 pool 3~8 行仍是一次请求。
 */
const EMBED_INPUTS_PER_REQUEST = 10;

async function embedChunked(svc: EmbeddingService, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_INPUTS_PER_REQUEST) {
    const got = await svc.embedBatch(texts.slice(i, i + EMBED_INPUTS_PER_REQUEST));
    out.push(...got);
  }
  return out;
}

/**
 * 内容寻址嵌入缓存（#179 门槛 e）。
 *
 * 为什么需要：生产 embedding 单请求就 ~200–300ms，300ms 预算下 40 轮重放有 15/40 轮直接 bypass
 * （降幅从 16.3% 掉到 11.8%）。注入行在多轮之间高度重复（同一结论/经验被反复召回），
 * 按「模型@维度 + 文本」缓存后，稳态轮基本零请求 → 预算守卫只在真正的新内容上生效。
 *
 * 只缓存确定性结果（同模型同文本恒同向量），键里带 model@dims，换端点不会串味；
 * LRU 上限 1024 条（≈1024×2048×4B ≈ 8MB 上界），不做持久化、进程内即生命周期。
 */
const EMBED_CACHE_MAX = 1024;
const embedCache = new Map<string, Float32Array>();

function embedCacheKey(model: string | undefined, dims: number | undefined, text: string): string {
  return `${model ?? "?"}@${dims ?? 0}\u0000${text}`;
}

/** 测试用：清空缓存（生产无需调用）。 */
export function clearEmbeddingCache(): void {
  embedCache.clear();
}

/** 观测用：当前缓存条数。 */
export function embeddingCacheSize(): number {
  return embedCache.size;
}

async function embedCached(
  svc: EmbeddingService,
  model: string | undefined,
  dims: number | undefined,
  texts: string[],
): Promise<Float32Array[]> {
  const keys = texts.map((t) => embedCacheKey(model, dims, t));
  const missIndexes: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    if (!embedCache.has(keys[i]!)) {
      missIndexes.push(i);
      missTexts.push(texts[i]!);
    }
  }

  if (missTexts.length > 0) {
    const fresh = await embedChunked(svc, missTexts);
    for (let j = 0; j < missIndexes.length; j += 1) {
      const vec = fresh[j];
      if (vec) {
        embedCache.set(keys[missIndexes[j]!]!, vec);
        while (embedCache.size > EMBED_CACHE_MAX) {
          const oldest = embedCache.keys().next();
          if (oldest.done) break;
          embedCache.delete(oldest.value);
        }
      }
    }
  }

  // 命中项也要「刷新」到队尾，保证 LRU 淘汰的是久未使用的文本。
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const key = keys[i]!;
    const vec = embedCache.get(key);
    // 缓存没补齐（端点少返回）→ 让调用方按长度不符处理（ruler-unavailable），绝不拿空向量凑数。
    if (!vec) return [];
    out.push(vec);
    embedCache.delete(key);
    embedCache.set(key, vec);
  }
  return out;
}

const NO_BUDGET: InjectionBudgetByIntent = {
  empty: null,
  continuation: null,
  self: null,
  info: null,
};

export async function runInjectionSelection(input: InjectionWiringInput): Promise<InjectionStageOutcome> {
  const rulerCfg = input.cfg?.layerRuler;
  const injectionCfg = input.cfg?.injection;
  const mode = rulerCfg?.mode ?? "off";

  let model: string | undefined;
  let dims: number | undefined;
  if (input.embeddingService) {
    try {
      model = input.embeddingService.getProviderInfo().model;
      dims = input.embeddingService.getDimensions();
    } catch {
      // provider 未就绪 → 视为未标定（floor 走 calibration/uncalibrated，最终可能 bypass）
      model = undefined;
      dims = undefined;
    }
  }

  // 配置地板只在 model@dims 与当前端点一致时采用：别的模型的地板对本模型无意义，
  // 宁可诚实 uncalibrated，也不拿错的数砍行。
  const configuredFloor =
    rulerCfg?.floor && rulerCfg.floor.model === model && rulerCfg.floor.dims === dims ? rulerCfg.floor.value : null;

  const calibration =
    mode === "off"
      ? new Map<string, number>()
      : loadFloorCalibrationFile(path.join(input.pluginDataDir, FLOOR_CALIBRATION_REL_PATH));

  const embedBatch =
    mode === "off" || !input.embeddingService
      ? undefined
      : (texts: string[]) => embedCached(input.embeddingService!, model, dims, texts);

  return applyInjectionSelection({
    lines: input.lines,
    query: input.query,
    ruler: {
      mode,
      keepRatio: rulerCfg?.keepRatio ?? 0.67,
      minPerLayer: rulerCfg?.minPerLayer ?? 1,
      floor: configuredFloor,
      lengthLambda: rulerCfg?.lengthLambda ?? 0,
      margin: rulerCfg?.margin ?? null,
      dedupeSim: rulerCfg?.dedupeSim ?? null,
      maxLineChars: injectionCfg?.maxLineChars ?? null,
    },
    maxChars: injectionCfg?.maxChars ?? null,
    // v3：选线预算可配（缺省 300 由 stage 兜底）。远端 embedding 一次 RTT 就可能吃掉 300ms，
    // 生产值写 800，否则选线恒降级成原序截断（名次/地板失效，journal 里 bypass=ruler-budget）。
    ...(rulerCfg?.budgetMs !== undefined ? { budgetMs: rulerCfg.budgetMs } : {}),
    foldIdentical: injectionCfg?.foldIdentical ?? false,
    budgetByIntent: injectionCfg?.budgetByIntent ?? NO_BUDGET,
    previousHash: input.previousHash,
    calibration,
    model,
    dimensions: dims,
    embedBatch,
    now: input.now,
  });
}
