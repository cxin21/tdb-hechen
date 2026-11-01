/**
 * State Backend — 接口 + 默认实现导出 + 后端工厂。
 *
 * DSH-only 构建只保留内置 LocalStateBackend（docs/adr/0021「可选后端退场」）：
 * 定时器/任务状态落在本地（local-backend.ts）。历史上还有一个 Redis 后端
 * （ZSET 分片定时器 + 消费组语义），它依赖 `src/integrations/redis/` 私有子模块，
 * 该子模块在本仓从未存在 —— 也就是说 `state_backend: redis` 在 OSS 构建里
 * 从来跑不起来，只会抛错。现在把它明确退场：配置里仍写 redis 时**构造期直接抛错**，
 * 报错信息给出迁移路径，不做静默降级。
 */

export type {
  IStateBackend,
  PipelineSessionState,
  TimerEntry,
  TaskPayload,
  CaptureAtomicParams,
  CaptureAtomicResult,
} from "./types.js";
export { DEFAULT_PIPELINE_STATE } from "./types.js";

export { LocalStateBackend } from "./local-backend.js";

import type { IStateBackend, TimerEntry } from "./types.js";
import { LocalStateBackend } from "./local-backend.js";

/** 唯一受支持的状态后端类型。 */
export type StateBackendType = "local";

export interface StateBackendConfig {
  type: StateBackendType;
  local?: {
    onTimerExpired?: (entry: TimerEntry) => void;
  };
}

/** 配置里写了已退场状态后端时抛出的错误。 */
export class RetiredStateBackendError extends Error {
  readonly backend: string;

  constructor(backend: string) {
    super(
      `[state-backend] "${backend}" has been retired in the DSH-only build ` +
        `(Redis 后端依赖的 src/integrations/redis/ 私有子模块在本仓从未存在，该路径只会抛错). ` +
        `Nothing was started and no silent fallback happened: set state_backend: "local" ` +
        `(default) in your gateway config. Pending ZSET timers left in Redis are NOT migrated ` +
        `automatically — see docs/adr/0021.`,
    );
    this.name = "RetiredStateBackendError";
    this.backend = backend;
  }
}

/**
 * 校验状态后端类型是否仍受支持：只有 local 可用，其余一律抛错。
 * 供网关在启动早期调用（fail-loud，先于任何 IO）。
 */
export function assertStateBackendSupported(type: string): void {
  if (type === "local") return;
  throw new RetiredStateBackendError(type);
}

/**
 * 工厂函数：根据配置创建对应的 State Backend。
 *
 * - type === "local": 内置 LocalStateBackend，零外部依赖
 * - 其它类型：已退场，抛 RetiredStateBackendError（不静默降级）
 */
export async function createStateBackend(config: StateBackendConfig): Promise<IStateBackend> {
  assertStateBackendSupported(config.type);

  const backend = new LocalStateBackend(config.local);
  await backend.initialize?.();
  return backend;
}