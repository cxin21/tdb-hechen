import { createHash } from "node:crypto";
/** 页面 content 的 sha256 指纹。空 content → 空串。 */
export function contentSha256(content: string): string {
  if (!content) return "";
  return createHash("sha256").update(content, "utf8").digest("hex");
}