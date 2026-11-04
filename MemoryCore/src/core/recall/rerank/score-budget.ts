/**
 * 本地精排的**滚动打分预算** —— 尾延迟封顶机制（零新增配置键：标准行为，代码缺省）。
 *
 * 病根（2026-11-04 一手取证）：cross-encoder 的单次延迟 ∝ 候选条数 × 单条前缀长度，
 * 90 题臂逐题账里 p50 只有 0.25–0.33s，但 p95 落在「池子 18–26 条」的题上（1.6–2.5s），
 * 与主线程/embedding 争抢时同池子还能再慢一倍；隔离压测（32 条 × 320 字符连打 40 次）
 * 第 18 次就打穿推理硬预算返回 null。即尾延迟由「这题池子多大 + 机器多忙」决定，
 * 而不是由算法决定 —— 这种分布不可能靠调参压住。
 *
 * 机制：把一次性整池打分改成**按块滚动打分**，总预算 400ms 到点即停。
 * 未送评的候选不进精排、走既有「未排序候选按融合原序垫尾」通路（与 provider 截断漏排
 * 同一条路，选线语义不变），journal 里以 unscored 记数。
 * 于是 p95 ≈ 预算 + 一块（150–250ms）封顶，与池子规模和机器负载解耦。
 *
 * 为什么是 400ms / 4 条一块 / 250ms 宽限（2026-11-04 三次标定，逐次收窄）：
 * - 版1 700ms/6 条、只在块间检查预算 ⇒ 实测 p95 1390ms、max 1910ms（最坏 = 预算 + 最慢一块）。
 * - 版2 300ms/3 条、仍只在块间检查 ⇒ p95 1557ms、max 2877ms：**块数变多，慢块的暴露面反而变大**
 *   （同一臂里 3 条的块也能跑 800ms+），说明「块间检查预算」压不住尾巴，因为块内耗时会随争抢退化 5–10 倍。
 * - 版3（当前）400ms/4 条 + **每块 race 超时 = 剩余预算 + 250ms 宽限** ⇒ 最坏情况硬顶 ≈650ms，
 *   空载时一块 4 条约 100ms、可跑 4 块（16 条，覆盖池子 p50=11 的整池），争抢时超时块直接放弃、
 *   该块及之后按融合原序垫尾。质量代价可接受：版1 少评 223/777 条时仍是 82/90，与全评臂 83/82/81 同档。
 *
 * 为什么只对本地 provider 生效：云 provider 的延迟由网络 RTT 主导，拆块只会多付几次 RTT。
 */
import type { RerankResult } from "./types.js";

/** 整次精排的总打分预算（毫秒）。 */
export const RERANK_SCORE_BUDGET_MS = 400;
/** 每块送评条数：块越小越贴合预算；空载 3 条 ≈75ms、争抢时 ≈270–750ms（见文件头标定）。 */
export const RERANK_SCORE_CHUNK = 4;
/**
 * 单块超时宽限（毫秒）：块内耗时会随 CPU 争抢退化 5–10 倍（同一臂里 3 条的块曾跑 800ms+），
 * 只在块间检查预算等于「尾巴由最慢的那一块决定」。所以每块再套一层 race：
 * 超过「剩余预算 + 宽限」就放弃该块（该块候选按融合原序垫尾），把最坏情况钉死在 budget+slack。
 */
export const RERANK_CHUNK_SLACK_MS = 250;

const TIMEOUT = Symbol("rerank-chunk-timeout");
type ChunkOutcome = RerankResult[] | null | typeof TIMEOUT;

/**
 * 单块 race 超时：放弃等待（不改 provider 语义），并在后台吞掉被放弃那次调用的异常，
 * 避免 unhandledRejection 把进程打死——被放弃的推理仍在 worker 里跑完，其延迟算在下一题头上
 * （预算按题重算，故不会累积；这也是「宁可用部分分数，也不让一题吃掉整个预算」的代价）。
 */
function withTimeout(p: Promise<RerankResult[] | null>, ms: number): Promise<ChunkOutcome> {
  return new Promise<ChunkOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
        void err;
      },
    );
  });
}

export interface RerankScoreOutcome {
  /** 精排结果（index 已还原为整池下标）；null = provider 降级，调用方按原序注入。 */
  ranked: RerankResult[] | null;
  /** 实际送评条数（≤ docs.length）。 */
  scoredDocs: number;
  /** 实际送评文档总字符数（与 docs 前缀一致）。 */
  scoredChars: number;
  /**
   * 有块因「剩余预算 + 宽限」到点被放弃（调用方主动行为）。
   * 区别于 provider 失败：调用方据此**不推熔断**——否则连丢 3 题就会把熔断推到 open，
   * 后续题全部跳过精排（2026-11-04 armR4 实测 61/90 被这样废掉）。
   */
  timedOut?: boolean;
}

/**
 * 按块滚动打分，到预算即停。
 *
 * 降级语义与整池调用同族：任一子块返回 null ⇒ 整次降级（ranked=null），
 * 不把「半份分数」当完整排序用 —— 半份会让未评分候选被当成低分尾部而误清排。
 */
export async function rerankWithinBudget(
  docs: string[],
  rerank: (batch: string[]) => Promise<RerankResult[] | null>,
  now: () => number = () => performance.now(),
  opts: {
    budgetMs?: number;
    chunk?: number;
    slackMs?: number;
  } = {},
): Promise<RerankScoreOutcome> {
  const budgetMs = opts.budgetMs ?? RERANK_SCORE_BUDGET_MS;
  const chunk = Math.max(1, Math.floor(opts.chunk ?? RERANK_SCORE_CHUNK));
  const totalChars = docs.reduce((n, d) => n + d.length, 0);
  if (docs.length === 0) return { ranked: [], scoredDocs: 0, scoredChars: 0 };
  if (docs.length <= chunk) {
    const one = await rerank(docs);
    return one === null
      ? { ranked: null, scoredDocs: 0, scoredChars: 0 }
      : { ranked: one, scoredDocs: docs.length, scoredChars: totalChars };
  }
  // 说明：池子 ≤ 一块时走上面的单次整池调用——此时没有块间预算可停，
  // 由其自身的超时兜底（local.ts 的 inferTimeoutMs）；调用方按 genuinely-failed 处理。
  const t0 = now();
  const slackMs = opts.slackMs ?? RERANK_CHUNK_SLACK_MS;
  const merged: RerankResult[] = [];
  let done = 0;
  let timedOut = false;
  for (; done < docs.length; done += chunk) {
    const elapsed = now() - t0;
    // 首块无条件跑：否则预算为 0/极小时一条都不评分，精排形同关闭（配置静默失效的老毛病）。
    if (done > 0 && elapsed > budgetMs) break;
    const waitMs = Math.max(1, Math.min(budgetMs - elapsed, slackMs) + slackMs);
    const sub = await withTimeout(rerank(docs.slice(done, done + chunk)), waitMs);
    if (sub === null) return { ranked: null, scoredDocs: 0, scoredChars: 0 };
    if (sub === TIMEOUT) {
      // 超时不算 provider 故障：已评分的块照用，本块及之后按融合原序垫尾。
      // 注意：**不通知 provider 去杀在途推理** —— 推理进行中终止 onnx worker 会原生崩溃
      // 带走整个进程（2026-11-04 实测 exit 127）；被放弃的那一块（≤4 条）自然跑完后结果丢弃，
      // 其延迟记在下一题头上（预算按题重算，不累积）。
      timedOut = true;
      break;
    }
    for (const s of sub) merged.push({ index: s.index + done, score: s.score });
  }
  if (merged.length === 0) return { ranked: null, scoredDocs: 0, scoredChars: 0, timedOut };
  const scoredDocs = Math.min(done, docs.length);
  return {
    ranked: merged,
    scoredDocs,
    scoredChars: docs.slice(0, scoredDocs).reduce((n, d) => n + d.length, 0),
    timedOut,
  };
}
