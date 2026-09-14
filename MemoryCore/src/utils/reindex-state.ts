/**
 * Reindex 状态机 — embedding 指纹漂移（needsReindex）后的后台全量重建调度（spec §6.2）。
 * 补齐既有断点：VectorStore.init() 返回 needsReindex=true 但 reindexAll() 此前无任何调用方。
 * 状态挂 globalThis：单进程语义即可；失败必须可见（failed + reason），禁止静默。
 */
import type { Logger } from "../core/types.js";

export interface ReindexState {
  status: "idle" | "running" | "done" | "failed";
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  l1Count?: number;
  l0Count?: number;
}

const g = globalThis as unknown as { __tdaiReindexState?: ReindexState };
export function getReindexState(): ReindexState {
  return g.__tdaiReindexState ?? { status: "idle" };
}
export function setReindexState(s: ReindexState): void {
  g.__tdaiReindexState = s;
}
export function __resetReindexStateForTests(): void {
  g.__tdaiReindexState = undefined;
}

interface ReindexableStore {
  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }>;
}
interface Embeddable {
  embed(text: string): Promise<Float32Array>;
}

export function scheduleReindex(store: ReindexableStore, embedding: Embeddable, logger: Logger): void {
  const cur = getReindexState();
  if (cur.status === "running") {
    logger.warn?.("[reindex] 已在运行中，忽略重复调度");
    return;
  }
  const startedAt = new Date().toISOString();
  setReindexState({ status: "running", startedAt });
  // F5 同步兜底：reindexAll 若同步 throw，异常会沿 _doInitStores 上传且状态永远卡 running。
  // 经 Promise.resolve().then 延后调用，同步 throw 也进入下方 .catch → failed + reason 可见。
  Promise.resolve()
    .then(() => store.reindexAll((text) => embedding.embed(text), (done, total, layer) => {
      logger.debug?.(`[reindex] ${layer} ${done}/${total}`);
    }))
    .then(({ l1Count, l0Count }) => {
      setReindexState({ status: "done", l1Count, l0Count, startedAt, finishedAt: new Date().toISOString() });
      logger.info(`[reindex] 全量重建完成 L1=${l1Count} L0=${l0Count}`);
    })
    .catch((err: unknown) => {
      setReindexState({
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      logger.error?.(`[reindex] 全量重建失败: ${getReindexState().reason}`);
    });
}
