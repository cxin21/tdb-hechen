/**
 * B0 校尺修复（bench/recall-opt）：精排子进程宿主——bench 进程内注入用。
 * 为什么不用 src 的 worker_threads LocalReranker：onnxruntime-node 在 bench 进程内
 * 会原生崩溃带走整进程（exit 127，2026-10-27 二分实锤）。子进程崩 → 本次 null（降级
 * 原序）→ 下次调用重拉（最多 maxRespawns 次）。模型与打分代码与生产完全同款，
 * 只是传输层 worker_threads → child_process（偏差说明记录）。
 * 注入点：makeRecall 传 rerankDeps={reranker, breaker?} → performLayeredRecall 
 * resolveRerankWiring 用注入实例（auto-recall.ts:474），minScore/candidates 仍读沙箱 cfg。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "rerank-child.mjs");

export class ChildProcessReranker {
  constructor({ modelDir, idleUnloadMs = 0, timeoutMs = 60_000, maxRespawns = 400, recycleAfter = 4, logger } = {}) {
    this.modelDir = modelDir;
    this.idleUnloadMs = idleUnloadMs;
    this.timeoutMs = timeoutMs;
    this.maxRespawns = maxRespawns;
    this.recycleAfter = recycleAfter;
    this.logger = logger;
    this.child = null;
    this.nextId = 1;
    this.respawns = 0;
    this.pending = new Map(); // id -> {resolve, timer}
  }

  #spawn() {
        // 必须带 --import tsx：子脚本 import 仓库 .ts 模块（裸 node 直接 ERR_UNKNOWN_FILE_EXTENSION 崩）
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, this.modelDir, String(this.idleUnloadMs)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RERANK_RECYCLE_AFTER: String(this.recycleAfter ?? 4) },
    });
    this._served = 0;
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        this._served = (this._served ?? 0) + 1;
        if (msg.ok && Array.isArray(msg.scores)) entry.resolve(msg.scores);
        else entry.resolve(null);
      }
    });
    child.on("exit", (code) => {
      this.child = null;
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(null); // 子进程崩：本次降级，调用方按 null 处理
      }
      this.pending.clear();
      this.logger?.warn?.(`[rerank-child] 子进程退出 code=${code} served=${this._served ?? "?"} stderr=${(child.stderrTail?.() ?? "").slice(-300).replace(/\n/g, " | ")}`);
    });
    let stderrTail = "";
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    child.stderrTail = () => stderrTail;
    this.child = child;
    return child;
  }

  async rerank(query, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return [];
    if (!this.child) {
      if (this.respawns >= this.maxRespawns) {
        this.logger?.warn?.(`[rerank-child] 重拉次数超上限（${this.maxRespawns}），永久降级`);
        return null;
      }
      this.respawns++;
      this.#spawn();
    }
    const id = this.nextId++;
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { child.kill(); } catch { /* 已死 */ }
        this.child = null;
        resolve(null); // 超时：击杀子进程，下次重拉
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, query, docs }) + "\n");
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        this.child = null;
        resolve(null);
      }
    });
  }

  async dispose() {
    if (this.child) { try { this.child.kill(); } catch { /* 已死 */ } this.child = null; }
  }
}