/**
 * P1 召回质量（spec §4.3/§4.5，task-1/task-3）：rerank provider 工厂——config → MemoryReranker。
 *
 * 路由合同（spec §4.3 / brief）：enabled=false、provider=none、未配置 → null
 * （=skip，调用方降级现状，零行为变化）；siliconflow/dashscope → 对应云端 adapter；
 * provider='local' → transformers.js 本地 reranker（task-3）：LocalReranker 走进程级
 * 单例池（同一模型目录全局一份，keyed by path.resolve(modelDir)——wiring 每次调用都
 * 会经过这里，池保证 worker 只加载一次），模型缺失时由 provider 内部触发下载器单例。
 * config 校验失败（云端缺 apiKey 等）时 parseConfig 已强制 enabled=false，
 * 这里自然落到 null（双保险，不重复实现校验）。
 */
import os from "node:os";
import path from "node:path";

import type { RecallRerankConfig } from "../../../config.js";
import { DashscopeReranker } from "./dashscope.js";
import { SiliconflowReranker } from "./siliconflow.js";
import { DEFAULT_RERANK_REPO } from "./downloader.js";
import { getSharedLocalReranker } from "./local.js";
import type { LocalRerankerOptions } from "./local.js";
import type { MemoryReranker } from "./types.js";

export interface RerankerFactoryOpts {
  /** 依赖注入 fetch（测试/代理链路用；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
  /** dataDir DI（缺省 TDAI_DATA_DIR env → ~/.memory-tencentdb/memory-tdai）。 */
  dataDir?: string;
  /** local provider 选项覆盖（测试注入 spawnWorker/downloadStarter/modelFiles 等）。 */
  local?: Partial<LocalRerankerOptions>;
}

/**
 * local 模型目录解析：config.local.modelDir 显式指定 > opts.dataDir DI >
 * TDAI_DATA_DIR env > 规范缺省 ~/.memory-tencentdb/memory-tdai（与 gateway
 * resolveDefaultDataDir 的目录约定一致，见 gateway/config.ts）。
 */
export function resolveLocalModelDir(config: RecallRerankConfig, dataDir?: string): string {
  const explicit = config.local?.modelDir?.trim();
  if (explicit) return path.resolve(explicit);
  const root =
    dataDir ??
    process.env.TDAI_DATA_DIR ??
    path.join(os.homedir(), ".memory-tencentdb", "memory-tdai");
  return path.join(root, "models", "reranker", DEFAULT_RERANK_REPO);
}

export function createReranker(config: RecallRerankConfig, opts?: RerankerFactoryOpts): MemoryReranker | null {
  if (!config?.enabled) return null;
  switch (config.provider) {
    case "siliconflow":
      return new SiliconflowReranker({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        timeoutMs: config.timeoutMs,
        fetchImpl: opts?.fetchImpl,
      });
    case "dashscope":
      return new DashscopeReranker({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        timeoutMs: config.timeoutMs,
        fetchImpl: opts?.fetchImpl,
      });
    case "local": {
      // task-3：transformers.js 本地 reranker（worker_threads 懒加载/崩溃隔离/空闲卸载）；
      // 模型缺失时由 LocalReranker 内部触发下载器单例（fire-and-forget），本次调用 null 降级。
      return getSharedLocalReranker({
        modelDir: resolveLocalModelDir(config, opts?.dataDir),
        idleUnloadMs: config.local?.idleUnloadMs,
        ...(opts?.local ?? {}),
      });
    }
    case "none":
    default:
      return null;
  }
}
