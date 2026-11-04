/**
 * 本地精排（cross-encoder）推理参数缺省值 —— 实测标定，代码缺省即最优（零新增配置键）。
 *
 * 2026-11-04 本机（16 核 / onnxruntime-node q8 / bge-reranker-base）实测，32 候选：
 * | 单条文档 | intra_op=1 | intra_op=2 | intra_op=4 | intra_op=8 |
 * | 400 字符 | 3257ms     | **1939ms** | 3245ms     | 3850ms     |
 * 延迟与「候选数 × 文档前缀长度」近似线性（200/400/800/1200/2000 字符 = 1680/3441/6546/7770/6816ms），
 * 1200 字符以上撞 tokenizer 512-token 截断后不再增长 —— 所以**截断前缀**是唯一有效的降本杠杆，
 * 而 batch 推理实测无收益（400 字符 3564ms vs 单条 3175ms；800 字符 6462ms vs 6229ms，
 * CPU q8 下 padding 开销吃掉了并行收益），故不采用 batch。
 *
 * 取值理由：
 * - threads=2：唯一实测优于 1 线程的档（1.68×），4/8 线程反而更慢（同步开销 + 超订）。
 * - docCap=320：留足语义头部（口语化记忆行的主谓/时间/主体基本落在前 300 字），
 *   32 候选实测 ≈1.6s，与插件侧 recallTimeoutMs=2500 相容；生产行 p50=497 字符（bench 库 1591 条实测），
 *   即多数行被截到 320，少数长 turn 只打分头部。
 *
 * 均可由环境变量覆盖（只给 bench 做 A/B 与故障复现，生产不配 = 走上面的最优点）：
 * - RERANK_THREADS>0
 * - RERANK_DOC_CAP>0
 */
export const DEFAULT_RERANK_THREADS = 2;
export const DEFAULT_RERANK_DOC_CAP = 320;

/**
 * 单次 score 的**硬预算**（毫秒）——推理假死/worker 罢工时的兜底击杀窗口。
 *
 * 实测：空载 32 候选 × 500 字符 @2 线程 ≈1.7–2.5s；2026-11-04 00:55 生产重启后
 * pipeline boot recovery 重挂 406 会话时实测 **3.81s**（同一份代码，纯 CPU 争抢）。
 * 预算只兜「假死」，正常调用不该被它打断，故取争抢实测值的 1.57× → **6s**：
 * 4s 只剩 0.2s 余量，一次争抢就会误降级（降级=本次无精排 + 熔断计数，三次连败熔断 60s）。
 * 仍比旧缺省 30s 小 5×——旧值让一次假死就吃穿插件 recallTimeoutMs=2500 与 v3 的 5000ms。
 */
export const DEFAULT_RERANK_INFER_TIMEOUT_MS = 6_000;

export interface RerankTuning {
  threads: number;
  docCap: number;
}

/** env 覆盖解析（worker 与主线程同源）。非数/非正 → 回落缺省。 */
export function resolveRerankTuning(env: NodeJS.ProcessEnv = process.env): RerankTuning {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v ?? "0");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    threads: num(env.RERANK_THREADS, DEFAULT_RERANK_THREADS),
    docCap: num(env.RERANK_DOC_CAP, DEFAULT_RERANK_DOC_CAP),
  };
}

/** 推理硬预算解析：TDAI_RERANK_INFER_TIMEOUT_MS 显式优先（bench 用它放宽），缺省 6s。 */
export function resolveRerankInferTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TDAI_RERANK_INFER_TIMEOUT_MS ?? "0");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RERANK_INFER_TIMEOUT_MS;
}
