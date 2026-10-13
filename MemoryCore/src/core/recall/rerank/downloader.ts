/**
 * P1 召回质量（spec §4.4，task-3）：rerank 本地模型自动下载器。
 *
 * 合同（spec §4.4 / brief / spike 铁律）：
 * - 文件清单固定 5 个（config.json / tokenizer.json / tokenizer_config.json /
 *   special_tokens_map.json / onnx/model_quantized.onnx），落盘 <modelDir>/ 相对路径。
 * - fetch 直链 + 浏览器 UA + 指数退避（429/408/5xx/网络错误可重试；其余 4xx 单源 fatal）
 *   + Range 断点续传（.part 文件；206 校验 Content-Range 起点；200 = 源不支持 Range，弃 .part 全量重下）。
 * - 双源：主 hf-mirror.com（/resolve/main/），备 ModelScope（/models/…/resolve/master/）；
 *   单源重试穷尽（maxRetriesPerSource+1 次）后切换下一源。
 * - 校验（Content-Length 一致性 + 每文件 minBytes）失败 → 可重试；最终失败 → 回滚
 *   （删除本 run 写入的目标文件与 .part 半成品，绝不留半成品 ready 态）。
 * - 状态可查询（模块级注册表快照副本，无推送依赖，Task 4 panel 轮询用）。
 * - 绝不使用 transformers.js 内建下载器（hf-mirror 429 已证）——本实现全部自管 HTTP。
 * 全部 HTTP 走注入 fetchImpl（缺省 globalThis.fetch）；测试可注入 tiny modelFiles 与
 * loopback 基址，零真实网络。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 缺省模型仓（spec §4.4 固定档：Xenova/bge-reranker-base INT8 q8）。 */
export const DEFAULT_RERANK_REPO = "Xenova/bge-reranker-base";

export interface RerankModelFileSpec {
  /** 模型目录内相对路径（POSIX 分隔，落盘时按段 join）。 */
  rel: string;
  /** 就绪校验最小字节数（防截断/HTML 错误页冒充）。 */
  minBytes: number;
}

/** 真实清单（spec §4.4）：tokenizer.json ~17MB / q8 onnx ~266MB，minBytes 取量级下界。 */
export const DEFAULT_RERANK_MODEL_FILES: RerankModelFileSpec[] = [
  { rel: "config.json", minBytes: 200 },
  { rel: "tokenizer.json", minBytes: 10_000_000 },
  { rel: "tokenizer_config.json", minBytes: 200 },
  { rel: "special_tokens_map.json", minBytes: 100 },
  { rel: "onnx/model_quantized.onnx", minBytes: 200_000_000 },
];

const DEFAULT_HF_BASE = "https://hf-mirror.com";
const DEFAULT_MODELSCOPE_BASE = "https://modelscope.cn";
/** 浏览器 UA 前缀（直链下载必要伪装；绝不走 transformers.js 内建下载器）。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MemoryCore-RerankDownloader/1.0";

export type RerankDownloadFileState = "pending" | "downloading" | "done" | "failed";

export interface RerankDownloadFileStatus {
  rel: string;
  state: RerankDownloadFileState;
  bytesReceived?: number;
  totalBytes?: number;
  error?: string;
}

export type RerankDownloadState = "idle" | "downloading" | "ready" | "failed";

export interface RerankDownloadStatus {
  state: RerankDownloadState;
  /** 0-100（按文件等权 + 当前文件字节比例）。 */
  percent: number;
  repo: string;
  modelDir: string;
  files: RerankDownloadFileStatus[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** 可重试错误（429/408/5xx/网络/校验失败）；fatal = 切下一源。 */
class RerankDownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RerankDownloadError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface RerankModelDownloaderOptions {
  /** 模型落盘根目录（清单相对路径落在此之下）。 */
  modelDir: string;
  /** 仓 id（缺省 Xenova/bge-reranker-base）。 */
  repo?: string;
  /** 依赖注入 fetch（缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
  /** 重试退避基值毫秒（缺省 500；第 n 次重试等待 base*2^n）。 */
  backoffBaseMs?: number;
  /** 每源额外重试次数（缺省 3 → 每源至多 4 次）。 */
  maxRetriesPerSource?: number;
  /** 文件清单（缺省真实清单；测试注入 tiny 门槛）。 */
  modelFiles?: RerankModelFileSpec[];
  /** 主源基址（缺省 hf-mirror；测试指向 loopback 静态服务器）。 */
  hfBaseUrl?: string;
  /** 备源基址（缺省 ModelScope；测试指向 loopback 静态服务器）。 */
  modelScopeBaseUrl?: string;
}

interface SourceDef {
  id: string;
  build: (repo: string, rel: string) => string;
}

export function isRerankModelReady(modelDir: string, files?: RerankModelFileSpec[]): boolean {
  const specs = files ?? DEFAULT_RERANK_MODEL_FILES;
  for (const spec of specs) {
    try {
      const p = path.join(modelDir, ...spec.rel.split("/"));
      const st = fs.statSync(p);
      if (!st.isFile() || st.size < spec.minBytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function makeIdleSnapshot(repo: string): RerankDownloadStatus {
  return {
    state: "idle",
    percent: 0,
    repo,
    modelDir: "",
    files: (DEFAULT_RERANK_MODEL_FILES as RerankModelFileSpec[]).map((s) => ({ rel: s.rel, state: "pending" as const })),
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function copySnapshot(s: RerankDownloadStatus): RerankDownloadStatus {
  return {
    ...s,
    files: s.files.map((f) => ({ ...f })),
    error: s.error ?? null,
  };
}

/* ---------- 模块级单例状态注册表（panel 轮询面；无推送依赖） ---------- */

let registrySnapshot: RerankDownloadStatus = makeIdleSnapshot(DEFAULT_RERANK_REPO);
let inflight: { promise: Promise<boolean> } | null = null;

/** 读注册表快照（深副本：调用方改动不影响注册表）。 */
export function getRerankModelStatus(): RerankDownloadStatus {
  return copySnapshot(registrySnapshot);
}

/** 测试专用：清空注册表与进行中下载句柄。 */
export function resetRerankDownloadStateForTests(): void {
  registrySnapshot = makeIdleSnapshot(DEFAULT_RERANK_REPO);
  inflight = null;
}

/* ---------- 下载器本体 ---------- */

export class RerankModelDownloader {
  private readonly modelDir: string;
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffBaseMs: number;
  private readonly maxRetriesPerSource: number;
  private readonly files: RerankModelFileSpec[];
  private readonly sources: SourceDef[];
  private progress: RerankDownloadStatus;

  constructor(opts: RerankModelDownloaderOptions) {
    this.modelDir = opts.modelDir;
    this.repo = opts.repo ?? DEFAULT_RERANK_REPO;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.backoffBaseMs = Math.max(0, opts.backoffBaseMs ?? 500);
    this.maxRetriesPerSource = Math.max(0, Math.floor(opts.maxRetriesPerSource ?? 3));
    this.files = (opts.modelFiles ?? DEFAULT_RERANK_MODEL_FILES).map((s) => ({ ...s }));
    const hfBase = (opts.hfBaseUrl ?? DEFAULT_HF_BASE).replace(/\/+$/, "");
    const msBase = (opts.modelScopeBaseUrl ?? DEFAULT_MODELSCOPE_BASE).replace(/\/+$/, "");
    this.sources = [
      { id: "hf-mirror", build: (repo, rel) => `${hfBase}/${repo}/resolve/main/${rel}` },
      { id: "modelscope", build: (repo, rel) => `${msBase}/models/${repo}/resolve/master/${rel}` },
    ];
    this.progress = {
      state: "downloading",
      percent: 0,
      repo: this.repo,
      modelDir: this.modelDir,
      files: this.files.map((s) => ({ rel: s.rel, state: "pending" as const })),
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
  }

  /** 读本下载器进度快照（深副本）。 */
  status(): RerankDownloadStatus {
    return copySnapshot(this.progress);
  }

  /** 全量下载（幂等：文件已齐且过校验 → 零网络直接 ready）。失败回滚，不留半成品。 */
  async download(): Promise<boolean> {
    this.publish();
    if (isRerankModelReady(this.modelDir, this.files)) {
      this.markReady();
      return true;
    }
    fs.mkdirSync(this.modelDir, { recursive: true });
    for (let i = 0; i < this.files.length; i++) {
      const spec = this.files[i];
      this.markFile(i, { state: "downloading" });
      try {
        const bytes = await this.fetchFileIntoPlace(spec, i);
        this.markFile(i, { state: "done", bytesReceived: bytes, totalBytes: bytes, error: undefined });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.markFile(i, { state: "failed", error: message });
        this.rollback(spec);
        this.fail(message);
        return false;
      }
    }
    this.markReady();
    return true;
  }

  /* ---------- 内部 ---------- */

  private finalPath(rel: string): string {
    return path.join(this.modelDir, ...rel.split("/"));
  }

  private publish(): void {
    registrySnapshot = copySnapshot(this.progress);
  }

  private markFile(i: number, patch: Partial<RerankDownloadFileStatus> & { state: RerankDownloadFileState }): void {
    const f = this.progress.files[i];
    this.progress.files[i] = { ...f, ...patch };
    if (patch.state === "done") this.progress.percent = this.computePercent(i, 1);
    this.publish();
  }

  /** 等权文件数 + 当前文件字节比例（206 时按 resume+CL 估总量）。 */
  private computePercent(currentIdx: number, currentFraction: number): number {
    const n = this.files.length;
    const doneWeight = this.progress.files.filter((f) => f.state === "done").length;
    let pct = ((doneWeight + Math.max(0, Math.min(1, currentFraction))) / n) * 100;
    if (currentIdx === n - 1 && doneWeight >= n - 1 && currentFraction >= 1) pct = 100;
    return Math.max(0, Math.min(100, Math.floor(pct)));
  }

  private markReady(): void {
    this.progress.state = "ready";
    this.progress.percent = 100;
    this.progress.error = null;
    this.progress.finishedAt = Date.now();
    this.publish();
  }

  private fail(message: string): void {
    this.progress.state = "failed";
    this.progress.error = message;
    this.progress.finishedAt = Date.now();
    // 整体失败：清扫全部 .part 半成品（不留可被误续传的脏状态）
    for (const spec of this.files) {
      try {
        fs.rmSync(`${this.finalPath(spec.rel)}.part`, { force: true });
      } catch {
        /* 清扫失败不掩盖主错误 */
      }
    }
    this.publish();
  }

  /** 单文件最终失败：删目标文件（本 run 写入的半成品）与 .part。 */
  private rollback(spec: RerankModelFileSpec): void {
    try {
      fs.rmSync(`${this.finalPath(spec.rel)}.part`, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(this.finalPath(spec.rel), { force: true });
    } catch {
      /* ignore */
    }
  }

  private async fetchFileIntoPlace(spec: RerankModelFileSpec, fileIdx: number): Promise<number> {
    let lastError: unknown = null;
    for (const source of this.sources) {
      for (let attempt = 0; attempt <= this.maxRetriesPerSource; attempt++) {
        try {
          return await this.fetchOnce(source, spec, fileIdx);
        } catch (err) {
          lastError = err;
          const retryable = err instanceof RerankDownloadError ? err.retryable : true;
          if (!retryable) break; // fatal → 换下一源
          if (attempt < this.maxRetriesPerSource) {
            await sleep(this.backoffBaseMs * 2 ** attempt);
          }
        }
      }
    }
    throw lastError ?? new Error(`all sources exhausted for ${spec.rel}`);
  }

  private async fetchOnce(source: SourceDef, spec: RerankModelFileSpec, fileIdx: number): Promise<number> {
    const finalPath = this.finalPath(spec.rel);
    const partPath = `${finalPath}.part`;
    fs.mkdirSync(path.dirname(partPath), { recursive: true });
    let resumeFrom = 0;
    try {
      resumeFrom = fs.statSync(partPath).size;
    } catch {
      resumeFrom = 0;
    }
    const url = source.build(this.repo, spec.rel);
    const headers: Record<string, string> = { "User-Agent": BROWSER_UA, Accept: "*/*" };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
    const res = await this.fetchImpl(url, { headers });
    let expectedTotal: number | undefined;
    if (res.status === 206) {
      const contentRange = res.headers.get("content-range") ?? "";
      const m = /^bytes (\d+)-\d+\/(\d+)/.exec(contentRange);
      if (!m || Number(m[1]) !== resumeFrom) {
        // 206 起点对不上 → 丢弃旧 .part，可重试（下一轮无 .part → 全量）
        try {
          fs.rmSync(partPath, { force: true });
        } catch {
          /* ignore */
        }
        throw new RerankDownloadError(`content-range mismatch for ${spec.rel}: ${contentRange || "missing"}`, true);
      }
      expectedTotal = resumeFrom + (Number(res.headers.get("content-length")) || 0);
      await this.consumeBody(res, partPath, { append: true, fileIdx, expectedTotal });
    } else if (res.status === 200) {
      // 源不支持 Range（或无 .part）→ 弃旧 .part 全量重写，内容不被拼接污染
      try {
        fs.rmSync(partPath, { force: true });
      } catch {
        /* ignore */
      }
      expectedTotal = Number(res.headers.get("content-length")) || undefined;
      await this.consumeBody(res, partPath, { append: false, fileIdx, expectedTotal });
    } else {
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      throw new RerankDownloadError(`HTTP ${res.status} for ${url}`, retryable);
    }
    // 校验 + 原子落位
    const size = fs.statSync(partPath).size;
    if (size < spec.minBytes) {
      throw new RerankDownloadError(`file ${spec.rel} too small: ${size} < ${spec.minBytes} bytes`, true);
    }
    fs.renameSync(partPath, finalPath);
    return size;
  }

  private async consumeBody(
    res: Response,
    partPath: string,
    opts: { append: boolean; fileIdx: number; expectedTotal?: number },
  ): Promise<void> {
    const expectedLen = Number(res.headers.get("content-length"));
    let received = 0;
    const baseReceived = opts.append ? Math.max(0, (opts.expectedTotal ?? 0) - (Number(res.headers.get("content-length")) || 0)) : 0;
    const ws = fs.createWriteStream(partPath, { flags: opts.append ? "a" : "w" });
    const counter = new TransformCounter((chunk) => {
      received += chunk.length;
      const total = opts.expectedTotal;
      if (total && total > 0) {
        this.progress.files[opts.fileIdx] = {
          ...this.progress.files[opts.fileIdx],
          bytesReceived: baseReceived + received,
          totalBytes: total,
        };
      }
    });
    try {
      if (res.body) {
        await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, ws);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        received = buf.length;
        await new Promise<void>((resolve, reject) => {
          ws.on("error", reject);
          ws.end(buf, () => resolve());
        });
      }
    } finally {
      ws.destroy();
    }
    if (Number.isFinite(expectedLen) && expectedLen > 0 && received !== expectedLen) {
      throw new RerankDownloadError(
        `content-length mismatch for ${partPath}: got ${received}, want ${expectedLen} (truncated stream)`,
        true,
      );
    }
  }
}

/** 字节计数 Transform（进度回写用；独立小类避免每 chunk 闭包膨胀）。 */
import { Transform } from "node:stream";
class TransformCounter extends Transform {
  constructor(private readonly onChunk: (chunk: Buffer) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    try {
      this.onChunk(chunk);
      cb(null, chunk);
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/* ---------- 单例入口（fire-and-forget + 去重；LocalReranker/panel 共用） ---------- */

export interface StartRerankModelDownloadOptions extends RerankModelDownloaderOptions {}

/** 触发下载（幂等）：已 ready → true 零网络；进行中 → 复用同一 promise；否则开新下载。 */
export function startRerankModelDownload(opts: StartRerankModelDownloadOptions): Promise<boolean> {
  const files = opts.modelFiles ?? DEFAULT_RERANK_MODEL_FILES;
  const repo = opts.repo ?? DEFAULT_RERANK_REPO;
  if (isRerankModelReady(opts.modelDir, files)) {
    registrySnapshot = {
      state: "ready",
      percent: 100,
      repo,
      modelDir: opts.modelDir,
      files: files.map((s) => ({ rel: s.rel, state: "done" as const, bytesReceived: undefined, totalBytes: undefined })),
      error: null,
      startedAt: null,
      finishedAt: Date.now(),
    };
    return Promise.resolve(true);
  }
  if (inflight) return inflight.promise;
  const dl = new RerankModelDownloader(opts);
  const promise: Promise<boolean> = dl.download().finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { promise };
  return promise;
}
