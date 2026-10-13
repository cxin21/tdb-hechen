/**
 * P1 召回质量（spec §4.5，task-3）：LocalReranker——transformers.js 跑在 worker_threads。
 *
 * 合同（spec §4.5 / brief / spike 铁律 / T1-T2 接线约束）：
 * - MemoryReranker 合同：rerank(query,docs) → [{index,score}] score 降序；null=降级；
 *   永不向调用方抛错；空 docs → [] 零 spawn。
 * - 构造零重活（工厂每次 wiring 都会 new）；worker 懒 spawn；进程级单例池 keyed by
 *   path.resolve(modelDir)（同一模型目录全局只加载一份）。
 * - 状态机 idle/loading/ready/failed + 失败冷却 failureRetryMs（冷却期内直接 null 不重 spawn）。
 * - 模型文件缺失 → 触发下载器单例（fire-and-forget，去重）→ 本次 null；下载完成后下次
 *   调用可加载；下载失败置 failed 走冷却，防打爆。
 * - 崩溃/超时隔离：load error/超时、score 假死超时、worker error/意外 exit → markFailed +
 *   全部 pending 请求 null；score 级 error（worker 可继续服务）→ 该请求 null、worker 留存。
 * - idleUnloadMs>0：空闲后 terminate 卸载（0=常驻）；timer unref 不阻进程退出。
 * - pair 编码必须 tokenizer(q,{text_pair:d,truncation:true})（spike 实测：位置参数第二位
 *   会被吞）；输出取 out.logits.data[0]；绝不使用 transformers.js 内建下载器。
 */
import { Worker } from "node:worker_threads";
import path from "node:path";

import { isRerankModelReady, startRerankModelDownload } from "./downloader.js";
import type { RerankModelFileSpec } from "./downloader.js";
import type { MemoryReranker, RerankResult } from "./types.js";

/** 父→worker 消息。 */
export type RerankWorkerRequest =
  | { type: "load"; modelDir: string }
  | { type: "score"; id: number; query: string; docs: string[] };

/** worker→父消息。 */
export type RerankWorkerResponse =
  | { type: "loaded" }
  | { type: "scores"; id: number; scores: number[] }
  | { type: "error"; id: number | null; message: string };

/** worker 最小面（真实 Worker 与测试 MockWorker 共同满足）。 */
export interface RerankWorkerLike {
  postMessage(msg: RerankWorkerRequest): void;
  terminate(): Promise<unknown>;
  on(event: "message", listener: (msg: RerankWorkerResponse) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}

export type LocalRerankerState = "idle" | "loading" | "ready" | "failed";

export interface LocalRerankerOptions {
  /** 模型目录（…/Xenova/bge-reranker-base；worker 内 env.localModelPath=dirname，modelId=basename）。 */
  modelDir: string;
  /** worker 工厂（测试注入 MockWorker；缺省真 worker_threads 跑 rerank-worker.mjs）。 */
  spawnWorker?: () => RerankWorkerLike;
  /** 模型缺失时的下载触发器（缺省 startRerankModelDownload 单例）。 */
  downloadStarter?: (opts: { modelDir: string }) => Promise<boolean>;
  /** 空闲卸载毫秒（缺省 600000；0=常驻）。 */
  idleUnloadMs?: number;
  /** load 超时毫秒（缺省 300000）。 */
  loadTimeoutMs?: number;
  /** 单次 score 超时毫秒（假死击杀；缺省 30000）。 */
  inferTimeoutMs?: number;
  /** failed 冷却毫秒（缺省 60000）。 */
  failureRetryMs?: number;
  /** 模型缺失时是否自动触发下载（缺省 true）。 */
  allowAutoDownload?: boolean;
  /** worker 内 transformers 模块入口覆盖（测试指向 fixture stub；缺省 @huggingface/transformers）。 */
  transformersEntryUrl?: string;
  /** 就绪校验清单（缺省真实清单 minBytes；测试注入 tiny）。 */
  modelFiles?: RerankModelFileSpec[];
}

interface PendingScore {
  resolve: (scores: number[] | null) => void;
  timer: NodeJS.Timeout | null;
}

interface PendingLoad {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class LocalReranker implements MemoryReranker {
  private readonly opts: Required<
    Pick<LocalRerankerOptions, "modelDir" | "idleUnloadMs" | "loadTimeoutMs" | "inferTimeoutMs" | "failureRetryMs" | "allowAutoDownload">
  > &
    LocalRerankerOptions;
  private worker: RerankWorkerLike | null = null;
  private currentState: LocalRerankerState = "idle";
  /** 主动 terminate 置位——"exit" 事件据此区分意外崩溃。 */
  private terminating = false;
  private disposed = false;
  private pendingLoad: PendingLoad | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly pendingScores = new Map<number, PendingScore>();
  private nextId = 1;
  private failedAt: number | null = null;
  private downloadPromise: Promise<boolean> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(opts: LocalRerankerOptions) {
    this.opts = {
      idleUnloadMs: 600_000,
      loadTimeoutMs: 300_000,
      inferTimeoutMs: 30_000,
      failureRetryMs: 60_000,
      allowAutoDownload: true,
      ...opts,
    };
  }

  get state(): LocalRerankerState {
    return this.currentState;
  }

  async rerank(query: string, docs: string[]): Promise<RerankResult[] | null> {
    if (this.disposed) return null;
    if (docs.length === 0) return [];
    const now = Date.now();
    if (
      this.currentState === "failed" &&
      this.failedAt !== null &&
      now - this.failedAt < this.opts.failureRetryMs
    ) {
      return null; // 冷却期内：直接 null，不重 spawn
    }
    if (!isRerankModelReady(this.opts.modelDir, this.opts.modelFiles)) {
      return this.triggerDownloadAndDegrade();
    }
    try {
      await this.ensureLoaded();
    } catch {
      return null; // ensureLoaded 内部已 markFailed
    }
    return await this.postScore(query, docs);
  }

  /** 显式卸载（池 reset / 优雅关停用）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    this.failAllPending();
    await this.terminateWorker();
    this.currentState = "idle";
  }

  /* ---------- 内部：加载 ---------- */

  private async ensureLoaded(): Promise<void> {
    if (this.worker && this.currentState === "ready") return;
    if (this.loadPromise) return this.loadPromise;
    this.clearIdleTimer();
    this.terminating = false;
    let worker: RerankWorkerLike;
    try {
      worker = (this.opts.spawnWorker ?? this.defaultSpawnWorker.bind(this))();
    } catch (err) {
      this.markFailed(err instanceof Error ? err.message : String(err));
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.worker = worker;
    this.currentState = "loading";
    this.failedAt = null;
    worker.on("message", (msg) => this.onWorkerMessage(msg));
    worker.on("error", (err) => {
      if (this.terminating) return;
      this.killWorker(`worker crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    worker.on("exit", (code) => {
      if (this.terminating) return; // 主动卸载/击杀的退出不算崩溃
      this.killWorker(`worker exited unexpectedly (code ${code})`);
    });
    this.loadPromise = new Promise<void>((resolve, reject) => {
      const timer =
        this.opts.loadTimeoutMs > 0
          ? setTimeout(() => {
              this.killWorker(`load timeout after ${this.opts.loadTimeoutMs}ms`);
            }, this.opts.loadTimeoutMs)
          : null;
      timer?.unref?.();
      this.pendingLoad = { resolve, reject, timer };
      try {
        worker.postMessage({ type: "load", modelDir: this.opts.modelDir });
      } catch (err) {
        this.killWorker(`postMessage(load) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private defaultSpawnWorker(): RerankWorkerLike {
    return new Worker(new URL("./rerank-worker.mjs", import.meta.url), {
      workerData: { modelDir: this.opts.modelDir, transformersEntryUrl: this.opts.transformersEntryUrl },
    }) as unknown as RerankWorkerLike;
  }

  private onWorkerMessage(msg: RerankWorkerResponse): void {
    if (msg.type === "loaded") {
      if (this.pendingLoad) {
        if (this.pendingLoad.timer) clearTimeout(this.pendingLoad.timer);
        const { resolve } = this.pendingLoad;
        this.pendingLoad = null;
        this.currentState = "ready";
        resolve();
      }
      return;
    }
    if (msg.type === "scores") {
      const entry = this.pendingScores.get(msg.id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingScores.delete(msg.id);
        entry.resolve(msg.scores);
        this.armIdleUnload();
      }
      return;
    }
    // error：id=null → load 级失败（worker 废弃）；id!=null → score 级失败（该请求 null，worker 留存）
    if (msg.id === null) {
      this.killWorker(`load failed: ${msg.message}`);
    } else {
      const entry = this.pendingScores.get(msg.id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingScores.delete(msg.id);
        entry.resolve(null);
        this.armIdleUnload();
      }
    }
  }

  /* ---------- 内部：打分 ---------- */

  private postScore(query: string, docs: string[]): Promise<RerankResult[] | null> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<number[] | null>((resolve) => {
      const timer =
        this.opts.inferTimeoutMs > 0
          ? setTimeout(() => {
              this.pendingScores.delete(id);
              this.killWorker(`infer timeout after ${this.opts.inferTimeoutMs}ms`);
              resolve(null);
            }, this.opts.inferTimeoutMs)
          : null;
      timer?.unref?.();
      this.pendingScores.set(id, { resolve, timer });
      try {
        worker.postMessage({ type: "score", id, query, docs });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingScores.delete(id);
        this.killWorker(`postMessage(score) failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve(null);
      }
    }).then((scores) => {
      if (!scores) return null;
      if (scores.length !== docs.length || !scores.every((s) => Number.isFinite(s))) {
        return null; // 非有限分数/长度不符 → 降级（worker 留存，不计 failed）
      }
      return scores
        .map((score, index) => ({ index, score }))
        .sort((a, b) => b.score - a.score);
    });
  }

  /* ---------- 内部：失败/清理 ---------- */

  /** 击杀 worker（假死/崩溃/load 失败）：terminate + markFailed + 全部 pending → null。 */
  private killWorker(reason: string): void {
    // 先捕获 worker 引用——markFailed 会置空 this.worker，之后 terminateWorker 就找不到它了
    const worker = this.worker;
    if (this.pendingLoad) {
      if (this.pendingLoad.timer) clearTimeout(this.pendingLoad.timer);
      const { reject } = this.pendingLoad;
      this.pendingLoad = null;
      reject(new Error(reason));
    }
    this.failAllPending();
    this.markFailed(reason);
    void this.terminateWorker(worker);
  }

  private failAllPending(): void {
    for (const [, entry] of this.pendingScores) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingScores.clear();
  }

  private markFailed(reason: string): void {
    this.currentState = "failed";
    this.failedAt = Date.now();
    this.worker = null;
    void reason;
  }

  private async terminateWorker(worker?: RerankWorkerLike | null): Promise<void> {
    const target = worker ?? this.worker;
    this.worker = null;
    if (!target) return;
    this.terminating = true;
    try {
      await target.terminate();
    } catch {
      /* terminate 失败不抛（worker 可能已死） */
    }
  }

  /* ---------- 内部：模型缺失 → 下载触发 ---------- */

  private triggerDownloadAndDegrade(): Promise<RerankResult[] | null> {
    if (this.opts.allowAutoDownload && !this.downloadPromise) {
      const starter =
        this.opts.downloadStarter ??
        ((o: { modelDir: string }) => startRerankModelDownload({ modelDir: o.modelDir }));
      this.downloadPromise = starter({ modelDir: this.opts.modelDir })
        .catch(() => false)
        .then((ok) => {
          if (!ok) this.markFailed("rerank model download failed"); // 冷却防打爆；成功不置 failed
          return ok;
        })
        .finally(() => {
          this.downloadPromise = null;
        });
    }
    return Promise.resolve(null); // fire-and-forget：本次 null，下载完成后下次调用可加载
  }

  /* ---------- 内部：idle 卸载 ---------- */

  private armIdleUnload(): void {
    this.clearIdleTimer();
    if (this.opts.idleUnloadMs <= 0) return; // 0 = 常驻
    if (this.pendingScores.size > 0 || this.pendingLoad) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pendingScores.size > 0 || this.pendingLoad || this.disposed) return;
      if (this.currentState !== "ready" || !this.worker) return;
      void this.terminateWorker();
      this.currentState = "idle"; // 卸载后回 idle：下次请求重 spawn
    }, this.opts.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/* ---------- 进程级单例池（同一模型目录全局一份） ---------- */

const sharedPool = new Map<string, LocalReranker>();

export function getSharedLocalReranker(opts: LocalRerankerOptions): LocalReranker {
  const key = path.resolve(opts.modelDir);
  const existing = sharedPool.get(key);
  if (existing) return existing;
  const instance = new LocalReranker(opts);
  sharedPool.set(key, instance);
  return instance;
}

/** 测试专用：dispose 全部池内实例并清空（beforeEach 同步调 / afterEach await 均可）。 */
export async function resetLocalRerankerPoolForTests(): Promise<void> {
  const instances = [...sharedPool.values()];
  sharedPool.clear();
  await Promise.all(instances.map((r) => r.dispose().catch(() => undefined)));
}
