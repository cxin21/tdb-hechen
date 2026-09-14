/**
 * Bearer token 统一解析（P2-T11+13 复核修补 I-1）。
 *
 * 背景：鉴权翻转（拍板③）后网关侧 `server.apiKey` 恒有值（缺失即生成临时密钥），
 * 跨进程调用方必须在 env/yaml 配置同一把 key，否则一律 401 断供。
 * skill / knowledge / meta 三条链路原先只读各自的 `serviceToken`（默认空），
 * 不在 `TDAI_GATEWAY_APIKEY` 透传范围内 —— 鉴权翻转后这三条链路会静默 401。
 *
 * 本模块复用 `src/tdai/client.ts` bearerToken 的 env 兜底模式，提供共享解析：
 *
 *   1. env `TDAI_GATEWAY_APIKEY` —— 部署侧透传，优先级最高（对齐 MemoryPanel
 *      "env 覆盖全部实例" 的运维习惯）；
 *   2. `tdai.apiKey` 配置 —— yaml 显式配置（由 bootstrap 经
 *      `setTdaiGatewayApiKey` 注入一次）；
 *   3. 原 `serviceToken` —— 各链路历史配置，行为不变（历史默认空 →
 *      `Bearer ` 与翻转前一致，本机无鉴权网关场景不受影响）。
 */

let tdaiApiKeyConfig = "";

/**
 * bootstrap 注入 yaml `tdai.apiKey`（index.ts 装配时调用一次）。
 * 测试环境不调用 —— 单测直接走 env 或 serviceToken 兜底。
 */
export function setTdaiGatewayApiKey(key: string | undefined): void {
  tdaiApiKeyConfig = (key ?? "").trim();
}

/** 仅供测试复位模块状态。 */
export function resetTdaiGatewayApiKeyForTest(): void {
  tdaiApiKeyConfig = "";
}

/**
 * 解析三条链路（skill / knowledge / meta）共用的 Bearer token。
 *
 * @param serviceToken 该链路原配置 token（CoreSkillConfig.serviceToken 等）
 * @returns 最终放进 `Authorization: Bearer <token>` 的 token
 */
export function resolveBearerToken(serviceToken: string): string {
  const envKey = (process.env.TDAI_GATEWAY_APIKEY ?? "").trim();
  if (envKey) return envKey;
  if (tdaiApiKeyConfig) return tdaiApiKeyConfig;
  return serviceToken;
}
