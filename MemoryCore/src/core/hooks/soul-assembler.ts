/**
 * soul-assembler —— 灵魂组装器（SOUL-PIPELINE §2.2，Phase 1）。
 *
 * 灵魂公式：此刻的你 + 过去的记忆 + 当下的感受 → 下一刻的你。
 * 本模块产出注入块前缀（身份段 + 感受段）；记忆段由既有 relevant-memories 块承载（零改动）。
 *
 * 设计决策：
 * - 加法式：前缀拼在既有块前，排序/过滤/消毒语义零回归。
 * - 身份材料：core_memory slots（identity 自发现产出）+ core_values 价值锚（自发现 + valence 方向）。
 * - 感受段：锚的 valence 方向合成（趋近/审慎）——moodSign 的可读形态。
 * - 全部材料 escapeXmlTags（程序化组装与写入路径同级消毒）。
 * - 宁缺毋滥：无材料 → 空串（不注入空段）。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";
import { escapeXmlTags } from "../../utils/sanitize.js";

function valenceDir(v: number | null | undefined): string {
  if (v === 1) return "趋近";
  if (v === -1) return "审慎";
  if (v === 0) return "中性";
  return "";
}

/** DS-SOUL-MEMORY-002 P1（F17）：段级渲染选项。缺省（undefined）= 旧渲染字节级一致。 */
export interface SoulRenderOptions {
  selfIdentityEnabled?: boolean;
  budgetSelfChars?: number;
  budgetIdentityChars?: number;
}

export async function buildSoulPrefix(
  store: IMemoryStore,
  tenant: CoreTenant,
  logger?: Logger,
  opts?: SoulRenderOptions,
): Promise<string> {
  const parts: string[] = [];
  try {
    const slots = ((await Promise.resolve(store.readCore?.(tenant))) ?? []) as Array<{ slot: string; content: string }>;
    const values = ((await Promise.resolve(store.listValues?.(tenant))) ?? []) as Array<{ label: string; weight?: number; valence?: number | null; state?: string }>;
    const active = values.filter((v) => v.state === undefined || v.state === "active");

    // ── 身份段：此刻的你 ──
    if (slots.length > 0 || active.length > 0) {
      const lines: string[] = [];
      // DS-SOUL-MEMORY-002 P1 四段渲染（gated）：非 dual 路径保持 `- [slot] content`
      // 原样且不做截断——逐位现状；dual 路径 self/identity 行分别带（我是谁）/（我心中的他）
      // 前缀（multi-line content 仅首行带前缀），F17 预算超限 slice 截断（宁缺毋滥，无省略号）。
      const dual = opts?.selfIdentityEnabled === true;
      const budgetFor = (slot: string): number | undefined =>
        !dual ? undefined
          : slot === "self_identity" ? (opts?.budgetSelfChars ?? 600)
          : slot === "identity" ? (opts?.budgetIdentityChars ?? 900)
          : undefined;
      const labelFor = (slot: string): string =>
        slot === "self_identity" ? "我是谁" : slot === "identity" ? "我心中的他" : "";
      // 渲染顺序=spec §2.7 不变量（:143-144：self 段在 identity 段前），不依赖 readCore 返回序；
      // stable 分区保持其余 slot 原相对序。legacy 路径（dual=false）保持原序逐位现状。
      const ordered = dual
        ? [...slots].sort((a, b) => {
            const rank = (slot: string) => (slot === "self_identity" ? 0 : slot === "identity" ? 1 : 2);
            return rank(a.slot) - rank(b.slot);
          })
        : slots;
      for (const s of ordered) {
        const budget = budgetFor(s.slot);
        const content = budget !== undefined && s.content.length > budget ? s.content.slice(0, budget) : s.content;
        const label = labelFor(s.slot);
        lines.push(dual && label ? `（${label}）- [${s.slot}] ${content}` : `- [${s.slot}] ${s.content}`);
      }
      if (active.length > 0) {
        lines.push(
          `价值锚：${active.map((v) => `${escapeXmlTags(v.label)}${valenceDir(v.valence) ? `(${valenceDir(v.valence)})` : ""}`).join("、")}`,
        );
      }
      if (lines.length > 0) parts.push(`<soul-identity>\n## 此刻的你\n${lines.join("\n")}\n</soul-identity>`);
    }

    // ── 感受段：当下的感受 ──
    const directional = active.filter((v) => v.valence === 1 || v.valence === -1);
    if (directional.length > 0) {
      const pos = directional.filter((v) => v.valence === 1).map((v) => escapeXmlTags(v.label));
      const neg = directional.filter((v) => v.valence === -1).map((v) => escapeXmlTags(v.label));
      const feel: string[] = [];
      if (pos.length > 0) feel.push(`驱动我行动的价值：${pos.join("、")}`);
      if (neg.length > 0) feel.push(`提醒我审慎的价值：${neg.join("、")}`);
      if (feel.length > 0) parts.push(`<soul-feeling>\n## 当下的感受\n${feel.join("\n")}\n</soul-feeling>`);
    }
  } catch (err) {
    logger?.warn?.(`[soul] assemble failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}