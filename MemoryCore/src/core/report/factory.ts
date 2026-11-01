/**
 * Observability Backend Factory — 工厂函数 + 全局单例管理。
 *
 * DSH-only 构建只保留两个后端（docs/adr/0021「可选后端退场」）：
 * - "noop"    → NoopObservabilityBackend（默认，零开销）
 * - "console" → ConsoleObservabilityBackend（开发调试，输出到 stdout）
 *
 * OTLP / internal（私有子模块，智研 + Kafka + Langfuse）/ ClickHouse 已在
 * DSH-only 构建中整体退场：构造期读到这些类型**直接抛错**，不做静默降级
 * ——老部署静默跑在 noop 上比启动即报错更危险。
 */

import type { IObservabilityBackend, ObservabilityConfig } from "./types.js";
import { NoopObservabilityBackend } from "./noop-backend.js";
import { ConsoleObservabilityBackend } from "./console-backend.js";

const TAG = "[observability][factory]";

/** 已退场的可观测性后端类型（读到即抛错）。 */
export const RETIRED_OBSERVABILITY_BACKENDS = [
  "otlp",
  "internal",
  "clickhouse",
  "kafka",
  "langfuse",
] as const;

/** 配置里写了已退场后端时抛出的错误。 */
export class RetiredObservabilityBackendError extends Error {
  readonly backend: string;

  constructor(backend: string) {
    super(
      `[observability] backend "${backend}" has been retired in the DSH-only build ` +
        `(removed: otlp / clickhouse / kafka / langfuse / internal private module). ` +
        `Nothing was started and no silent fallback happened: configure observability.type to ` +
        `"noop" (default, zero cost) or "console" (stdout, dev only) instead. ` +
        `If you are upgrading an old deployment whose gateway.yaml still sets ` +
        `observability.otel/clickhouse/kafka/langfuse, switch observability.type to "noop" and ` +
        `drop those blocks — see docs/adr/0021.`,
    );
    this.name = "RetiredObservabilityBackendError";
    this.backend = backend;
  }
}

/**
 * 校验后端类型是否仍受支持：只有 noop / console 可用，其余一律抛错。
 * 供网关在启动早期调用（fail-loud，先于任何 IO）。
 */
export function assertObservabilityBackendSupported(type: string): void {
  if (type === "noop" || type === "console") return;
  throw new RetiredObservabilityBackendError(type);
}

// ============================
// 工厂函数
// ============================

/**
 * 创建可观测性后端实例。
 *
 * @param config 可观测性配置
 * @returns IObservabilityBackend 实例
 * @throws RetiredObservabilityBackendError 配置了已退场的后端类型
 */
export async function createObservabilityBackend(
  config: ObservabilityConfig,
): Promise<IObservabilityBackend> {
  const type = config.type ?? "noop";
  assertObservabilityBackendSupported(type);

  switch (type) {
    case "console": {
      const backend = new ConsoleObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "noop":
    default: {
      const backend = new NoopObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }
  }
}

// ============================
// 全局单例管理
// ============================

/** 全局可观测性后端实例 */
let _globalBackend: IObservabilityBackend = new NoopObservabilityBackend();

/** 是否已初始化 */
let _initialized = false;

/**
 * 获取全局可观测性后端实例。
 * 如果尚未初始化，返回 Noop 实例（安全降级）。
 */
export function getObservabilityBackend(): IObservabilityBackend {
  return _globalBackend;
}

/**
 * 初始化全局可观测性后端。
 * 幂等：多次调用只有第一次生效。
 *
 * 注意：已退场后端类型**不会**被 try/catch 吞掉（那正是「静默降级」），
 * 校验发生在 try 之外，直接冒泡给启动流程。
 *
 * @param config 可观测性配置
 */
export async function initObservabilityBackend(config: ObservabilityConfig): Promise<void> {
  if (_initialized) return;
  assertObservabilityBackendSupported(config.type ?? "noop");

  try {
    _globalBackend = await createObservabilityBackend(config);
    _initialized = true;
    console.log(`${TAG} Observability backend initialized: type=${_globalBackend.type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} Failed to initialize observability backend: ${msg}. Using noop.`);
    _globalBackend = new NoopObservabilityBackend();
    _initialized = true;
  }
}

/**
 * 重置全局可观测性后端（用于插件热重载和测试）。
 * 会先调用当前后端的 shutdown()。
 */
export async function resetObservabilityBackend(): Promise<void> {
  try {
    await _globalBackend.shutdown();
  } catch {
    // 静默
  }
  _globalBackend = new NoopObservabilityBackend();
  _initialized = false;
}