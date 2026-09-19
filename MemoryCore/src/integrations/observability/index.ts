/**
 * observability module stub——@opentelemetry 依赖不可用时的 best-effort 空实现。
 * D-R5-2：模块不存在导致 TS2307；此处创建最小 stub 让 tsc 通过，运行时正常。
 */
export interface ObservabilityBackend {
  shutdown(): Promise<void>;
}

export function getObservabilityBackend(): ObservabilityBackend | undefined {
  return undefined;
}
