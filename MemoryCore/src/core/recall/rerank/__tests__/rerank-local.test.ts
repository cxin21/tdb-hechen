/**
 * P1 召回质量（spec §4.5，task-3）：LocalReranker（transformers.js @ worker_threads）TDD。
 *
 * 合同（spec §4.5 / brief / T1-T2 接线约束）：
 * - MemoryReranker.rerank(query, docs)：[{index,score}] score 降序；null=降级；永不抛；空 docs=[]。
 * - 构造零重活（工厂每次 wiring 都会 new）；worker 懒 spawn；进程级单例池 keyed by modelDir。
 * - 状态机 idle/loading/ready/failed + 失败冷却 failureRetryMs（冷却期内直接 null 不重 spawn）。
 * - 模型文件缺失 → 触发下载器单例（fire-and-forget，去重）→ 本次 null。
 * - 崩溃/超时隔离：worker error/exit/假死 → markFailed + reject 全部 pending；score 超时 terminate（假死击杀）。
 * - idleUnloadMs>0：空闲后 terminate 卸载（0=常驻）。
 * - pair 编码必须 tokenizer(q,{text_pair:d,truncation:true})（spike 实测：第二位置参数会被吞）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { LocalReranker, getSharedLocalReranker, resetLocalRerankerPoolForTests } from "../local.js";
import type { RerankWorkerLike, RerankWorkerRequest } from "../local.js";
import type { RerankModelFileSpec } from "../downloader.js";

/* ---------- mock worker：EventEmitter 骨架 + 可编程 reply ---------- */

class MockWorker extends EventEmitter {
  sent: RerankWorkerRequest[] = [];
  terminated = 0;
  reply: (msg: RerankWorkerRequest, w: MockWorker) => void = () => {};

  postMessage(msg: RerankWorkerRequest): void {
    this.sent.push(msg);
    this.reply(msg, this);
  }

  async terminate(): Promise<unknown> {
    this.terminated += 1;
    return 1;
  }

  emitLoaded(): void {
    this.emit("message", { type: "loaded" });
  }

  emitScores(id: number, scores: number[]): void {
    this.emit("message", { type: "scores", id, scores });
  }

  emitError(id: number | null, message: string): void {
    this.emit("message", { type: "error", id, message });
  }
}

function asWorkerLike(w: MockWorker): RerankWorkerLike {
  return w as unknown as RerankWorkerLike;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 自动应答 worker：load→loaded，score→按入参给分。 */
function autoReplyWorker(scoresFor: (query: string, docs: string[]) => number[]): MockWorker {
  const w = new MockWorker();
  w.reply = (msg) => {
    if (msg.type === "load") setImmediate(() => w.emitLoaded());
    else if (msg.type === "score") setImmediate(() => w.emitScores(msg.id, scoresFor(msg.query, msg.docs)));
  };
  return w;
}

/** 建一个通过 readiness 校验的模型目录（配合注入的 tiny modelFiles 门槛）。 */
function makeReadyModelDir(root: string): string {
  const dir = path.join(root, "Xenova", "bge-reranker-base");
  for (const rel of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"]) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "x".repeat(8), "utf-8");
  }
  return dir;
}

const TINY_MODEL_FILES: RerankModelFileSpec[] = [
  { rel: "config.json", minBytes: 1 },
  { rel: "tokenizer.json", minBytes: 1 },
  { rel: "tokenizer_config.json", minBytes: 1 },
  { rel: "special_tokens_map.json", minBytes: 1 },
  { rel: "onnx/model_quantized.onnx", minBytes: 1 },
];

/* ---------- 套件 ---------- */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rk3-local-"));
  resetLocalRerankerPoolForTests();
});

afterEach(async () => {
  await resetLocalRerankerPoolForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeReranker(overrides: {
  modelDir?: string;
  spawn?: () => MockWorker;
  starter?: (o: { modelDir: string }) => Promise<boolean>;
} & Partial<ConstructorParameters<typeof LocalReranker>[0]> = {}): { r: LocalReranker; workers: MockWorker[]; starterCalls: Array<{ modelDir: string }> } {
  const workers: MockWorker[] = [];
  const starterCalls: Array<{ modelDir: string }> = [];
  const modelDir = overrides.modelDir ?? makeReadyModelDir(tmpRoot);
  const r = new LocalReranker({
    modelDir,
    ...overrides,
    spawnWorker: overrides.spawn ? () => asWorkerLike(overrides.spawn!()) : () => {
      const w = autoReplyWorker((q, docs) => docs.map((d) => (d.includes("b") ? 2 : d.includes("a") ? 0.5 : -1)));
      workers.push(w);
      return asWorkerLike(w);
    },
    downloadStarter: overrides.starter
      ? async (o) => {
          starterCalls.push(o);
          return overrides.starter!(o);
        }
      : undefined,
    // 测试模型目录文件很小，readiness 口径走 LocalReranker 的 modelFiles 注入（默认实现用真实 minBytes）
    modelFiles: TINY_MODEL_FILES,
  });
  return { r, workers, starterCalls };
}

describe("P1 task-3 LocalReranker：合同与状态机", () => {
  it("空 docs → []，零 spawn", async () => {
    const { r, workers } = makeReranker();
    expect(await r.rerank("q", [])).toEqual([]);
    expect(workers.length).toBe(0);
  });

  it("懒加载：构造零重活，首次 rerank 才 spawn 并发 load→score", async () => {
    const { r, workers } = makeReranker();
    const p = r.rerank("q", ["a", "b"]);
    await tick();
    expect(workers.length).toBe(1);
    expect(workers[0].sent.map((m) => m.type)).toEqual(["load", "score"]);
    await p;
  });

  it("score 结果降序映射 index；同一 worker 复用（ready 态二次请求不再 spawn）", async () => {
    const { r, workers } = makeReranker();
    const out = await r.rerank("q", ["c", "b", "a"]);
    expect(out).toEqual([
      { index: 1, score: 2 },
      { index: 2, score: 0.5 },
      { index: 0, score: -1 },
    ]);
    await r.rerank("q", ["a"]);
    expect(workers.length).toBe(1);
  });

  it("并发请求共享同一次 load（loading 期只 spawn 一次）", async () => {
    const { r, workers } = makeReranker();
    await Promise.all([r.rerank("q", ["a"]), r.rerank("q", ["b"])]);
    expect(workers.length).toBe(1);
  });

  it("load 失败（error id=null）→ null 且 state=failed", async () => {
    const w = new MockWorker();
    w.reply = (msg) => {
      if (msg.type === "load") setImmediate(() => w.emitError(null, "onnx load boom"));
    };
    const { r } = makeReranker({ spawn: () => w });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(r.state).toBe("failed");
  });

  it("load 超时 → null、failed、worker 被 terminate", async () => {
    const w = new MockWorker(); // 不应答
    const { r } = makeReranker({ spawn: () => w, loadTimeoutMs: 30 });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(r.state).toBe("failed");
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it("score 级 error → 该请求 null，worker 留存可继续服务", async () => {
    const w = new MockWorker();
    let n = 0;
    w.reply = (msg) => {
      if (msg.type === "load") setImmediate(() => w.emitLoaded());
      else if (msg.type === "score") {
        n += 1;
        if (n === 1) setImmediate(() => w.emitError(msg.id, "tensor boom"));
        else setImmediate(() => w.emitScores(msg.id, [0.9]));
      }
    };
    const { r } = makeReranker({ spawn: () => w });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(r.state).not.toBe("failed");
    expect(await r.rerank("q", ["a"])).toEqual([{ index: 0, score: 0.9 }]);
  });

  it("score 假死超时 → null、terminate（击杀假死）、failed", async () => {
    const w = new MockWorker();
    w.reply = (msg) => {
      if (msg.type === "load") setImmediate(() => w.emitLoaded());
      // score 不应答 = 假死
    };
    const { r } = makeReranker({ spawn: () => w, inferTimeoutMs: 30 });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(r.state).toBe("failed");
    expect(w.terminated).toBeGreaterThanOrEqual(1);
  });

  it("worker error 事件（崩溃）→ reject pending、null、failed", async () => {
    const w = new MockWorker();
    w.reply = (msg) => {
      if (msg.type === "load") setImmediate(() => w.emitLoaded());
    };
    const { r } = makeReranker({ spawn: () => w });
    const p = r.rerank("q", ["a"]);
    await tick();
    await tick();
    w.emit("error", new Error("worker OOM"));
    expect(await p).toBeNull();
    expect(r.state).toBe("failed");
  });

  it("worker 意外 exit（非主动 terminate）→ null、failed", async () => {
    const w = new MockWorker();
    w.reply = (msg) => {
      if (msg.type === "load") setImmediate(() => w.emitLoaded());
    };
    const { r } = makeReranker({ spawn: () => w });
    const p = r.rerank("q", ["a"]);
    await tick();
    await tick();
    w.emit("exit", 1);
    expect(await p).toBeNull();
    expect(r.state).toBe("failed");
  });

  it("失败冷却：failed 后冷却期内直接 null 不重 spawn；冷却过后重 spawn 恢复", async () => {
    let healthy = false;
    const spawned: MockWorker[] = [];
    const { r } = makeReranker({
      spawn: () => {
        const w = new MockWorker();
        spawned.push(w);
        w.reply = (msg) => {
          if (msg.type === "load") {
            if (healthy) setImmediate(() => w.emitLoaded());
            else setImmediate(() => w.emitError(null, "not ready"));
          } else if (msg.type === "score") setImmediate(() => w.emitScores(msg.id, [0.3]));
        };
        return w;
      },
      failureRetryMs: 50,
    });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(spawned.length).toBe(1);
    expect(await r.rerank("q", ["a"])).toBeNull(); // 冷却期内：不 spawn
    expect(spawned.length).toBe(1);
    await sleep(60);
    healthy = true;
    expect(await r.rerank("q", ["a"])).toEqual([{ index: 0, score: 0.3 }]);
    expect(spawned.length).toBe(2);
  });

  it("非有限分数（NaN）→ null 降级", async () => {
    const { r } = makeReranker({
      spawn: () => autoReplyWorker(() => [Number.NaN, 1]),
    });
    expect(await r.rerank("q", ["a", "b"])).toBeNull();
  });
});

describe("P1 task-3 LocalReranker：模型缺失与自动下载触发", () => {
  it("模型缺失 → null + 触发下载器单例一次（去重）；下载完成后下次调用可加载", async () => {
    const emptyDir = path.join(tmpRoot, "empty");
    let resolveDownload!: (v: boolean) => void;
    const starter = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const { r, starterCalls } = makeReranker({ modelDir: emptyDir, starter: starter as unknown as (o: { modelDir: string }) => Promise<boolean> });
    expect(await r.rerank("q", ["a"])).toBeNull(); // 模型缺失 → 触发下载 → 本次 null
    expect(await r.rerank("q", ["a"])).toBeNull(); // 下载仍在进行 → 仍 null，且不重复触发
    expect(starterCalls.length).toBe(1);
    // 模拟下载完成：文件就位 + promise resolve
    for (const rel of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"]) {
      fs.mkdirSync(path.join(emptyDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(emptyDir, rel), "x".repeat(8), "utf-8");
    }
    resolveDownload(true);
    expect(await r.rerank("q", ["a"])).toEqual([{ index: 0, score: 0.5 }]); // 文件已就位 → 加载成功（默认打分器 'a'→0.5）
  });

  it("allowAutoDownload=false 且模型缺失 → null 且不触发下载", async () => {
    const emptyDir = path.join(tmpRoot, "empty2");
    const starter = vi.fn(async () => true);
    const { r, starterCalls } = makeReranker({
      modelDir: emptyDir,
      allowAutoDownload: false,
      starter: starter as unknown as (o: { modelDir: string }) => Promise<boolean>,
    });
    expect(await r.rerank("q", ["a"])).toBeNull();
    expect(starterCalls.length).toBe(0);
  });
});

describe("P1 task-3 LocalReranker：idle 卸载", () => {
  it("idleUnloadMs>0：空闲超时后 terminate 卸载，state 回 idle；再次请求重 spawn", async () => {
    const { r, workers } = makeReranker({ idleUnloadMs: 40 });
    await r.rerank("q", ["a"]);
    expect(workers.length).toBe(1);
    await sleep(90);
    expect(workers[0].terminated).toBeGreaterThanOrEqual(1);
    expect(r.state).toBe("idle");
    await r.rerank("q", ["a"]);
    expect(workers.length).toBe(2);
  });

  it("idleUnloadMs=0：常驻不卸载", async () => {
    const { r, workers } = makeReranker({ idleUnloadMs: 0 });
    await r.rerank("q", ["a"]);
    await sleep(80);
    expect(workers[0].terminated).toBe(0);
    expect(r.state).toBe("ready");
  });
});

describe("P1 task-3 LocalReranker：进程级单例池", () => {
  it("同 modelDir 共享实例；不同 modelDir 各自实例", () => {
    const dirA = path.join(tmpRoot, "A");
    const dirB = path.join(tmpRoot, "B");
    const a1 = getSharedLocalReranker({ modelDir: dirA });
    const a2 = getSharedLocalReranker({ modelDir: path.join(tmpRoot, "A") });
    const b = getSharedLocalReranker({ modelDir: dirB });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});

describe("P1 task-3 LocalReranker：真 worker_threads bootstrap 协议（fixture stub 模块）", () => {
  it("eval worker 加载 stub transformers 模块：env 关远端开本地、localModelPath=dirname(modelDir)、text_pair 编码、scores 回传", async () => {
    const fixtureUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-transformers.mjs")).href;
    const dir = makeReadyModelDir(tmpRoot);
    const r = new LocalReranker({
      modelDir: dir,
      transformersEntryUrl: fixtureUrl,
      modelFiles: TINY_MODEL_FILES,
    });
    const out = await r.rerank("what is ai", ["机器学习", "做菜"]);
    expect(out).toEqual([
      { index: 0, score: 2.5 },
      { index: 1, score: 0.5 },
    ]);
    await r.dispose();
  });
});
