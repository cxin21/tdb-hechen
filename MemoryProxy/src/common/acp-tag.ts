/**
 * #89：剥除 DSH 运行时注入的 acp 标签（形如 <acp tokens="22" type="text">m00458</acp>）。
 * 标签是 harness 元数据，不是记忆内容；在 L0 写边界（recordTdaiTurn 三路）统一剥除。
 * 分类语义不受影响（intent-classifier 仍看原始文本）。
 * 容差：畸形闭合 <//acp>（镜像 classifier P1 修复）；未闭合标签不动（无法安全定界）。
 */
const BS = String.fromCharCode(92); // 反斜杠——规避传输层转义吞噬
const ACP_TAG_RE = new RegExp(
  "<acp" + BS + "b[^>]*>[" + BS + "s" + BS + "S]*?<" + BS + "/+" + BS + "s*acp" + BS + "s*>",
  "gi"
);
const MULTI_NL_RE = new RegExp(BS + "n{3,}", "g");
const NL2 = String.fromCharCode(10) + String.fromCharCode(10);

export function stripDshAcpTags(text: string): string {
  if (!text) return text;
  return text.replace(ACP_TAG_RE, "").replace(MULTI_NL_RE, NL2).trim();
}
