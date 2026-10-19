/**
 * 凭据占位符合同（ADR-0006，#70）。
 *
 * 云部署模板（tdai-gateway.cloud.yaml 等）以 __XXX__ 或 ${XXX} 形态占位；
 * 未替换/未展开的占位符一律视为「未设置」，禁止当作真实凭据采信。
 * 单一源：src 与 scripts（read-llm-credential 等）共同引用。
 */

const CREDENTIAL_PLACEHOLDER = /^(?:__[A-Za-z0-9_]+__|\$\{[A-Za-z0-9_]+\})$/;

export function isPlaceholderCredential(value: unknown): boolean {
  return typeof value === "string" && CREDENTIAL_PLACEHOLDER.test(value.trim());
}

/** 非空字符串且非占位符 → 可采信的凭据值。 */
export function isSetCredential(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !isPlaceholderCredential(value);
}