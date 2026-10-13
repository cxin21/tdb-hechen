/**
 * anchor-desc.ts — 锚点 description 写入口 sanitizer 单一源（P0-1A，issue #1，2026-10-13）。
 *
 * 问题：sanitizeDescription 原居 gateway/pending-adopt-merge.ts——core/lifecycle 的
 * auto-growth 采纳端（anchor-growth.ts）按引用方向（core→core 合法，core→gateway 非法）
 * 无法复用，导致 LLM 自生长采纳时 attrs_json 落 "{}"、rationale 丢弃（issue #1 根因）。
 * 本文件把 sanitizer 搬进 core/hooks（soul-assembler/episode-gate 同族），gateway 改为
 * re-export 保持公共 API 不变。
 *
 * 同步规则（pending-adopt-merge.ts 2026-10-04 灵魂注入质量轮，何晨令）：
 * 60 字窗口内含句末标点（。！？；）→ 截到最后句末标点；窗口内无句末标点：
 * 尾悬空（以，、, 结尾=写入口截断实锤特征）→ 置空（宁缺毋滥不入半句），
 * 完整短语（尾非悬空）→ 原样保留。
 */
import { isDanglingTail } from "./soul-assembler.js";
import { looksLikeEpisode } from "./episode-gate.js";

export function sanitizeAnchorDescription(raw: string, maxChars: number): string {
  const full = String(raw ?? "").trim();
  if (!full) return "";
  const truncated = [...full].length > maxChars;
  const s = [...full].slice(0, maxChars).join("");
  const cut = Math.max(s.lastIndexOf("。"), s.lastIndexOf("！"), s.lastIndexOf("？"), s.lastIndexOf("；"));
  if (cut >= 0) return s.slice(0, cut + 1); // 有句末标点 → 截到最后句末标点
  if (truncated) return ""; // 超长截断且窗口内无句末标点 = 半句实锤 → 置空
  return isDanglingTail(s) ? "" : s; // v18-d 单一源：尾悬空标点/长句无句读（>12 字）→ 置空；≤12 字完整短语保留
}

/**
 * 采纳端便捷口：sanitize + episode 双门后非空才回 attrs（空 = attrs_json 不写
 * description 字段，渲染端宁缺毋滥跳过——与 coerceCoreValueAnchor 的 desc 置空语义一致）。
 * episode 门（R2 同款）：LLM rationale/description 若为具体事件叙述（commit hash/HTTP/
 * 日期等硬特征）→ 置空不落库（锚保留；coerce 的整锚拒门针对用户显式提案，此处宽一档）。
 */
export function anchorDescriptionAttr(raw: string | undefined | null, maxChars = 60): { description: string } | undefined {
  const description = sanitizeAnchorDescription(String(raw ?? ""), maxChars);
  if (!description || looksLikeEpisode(description)) return undefined;
  return { description };
}

/**
 * Standards 终审 #4（dup 消解，2026-10-13）：读既有锚 attrs_json 的 description
 * （非空字符串才有效）。auto-growth theme/person 重采纳守卫共用——prior 锚已有
 * 非空 description 时不允许 LLM 侧重写（attrs=undefined 不碰语义）。
 */
export function existingDescription(attrsJson: string | null | undefined): string | undefined {
  if (!attrsJson || attrsJson === "{}") return undefined;
  try {
    const parsed = JSON.parse(attrsJson) as { description?: unknown } | null;
    const d = parsed?.description;
    return typeof d === "string" && d.trim() ? d : undefined;
  } catch {
    return undefined; // 坏行 JSON：按无描述处理（走补写路径）
  }
}
