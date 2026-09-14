/**
 * K 核心记忆写入口 · 信任边界模型（审计 F2）。
 *
 * 依 K 设计 §4/§5 红线："core 只能被可信来源写，改动留痕（version/updated_at/source）——
 * 防投毒覆盖身份层"。本模块把"允许哪些 slot、content 多长、来源怎么标"收敛为
 * 一个可单测的纯函数，路由 handler 调用它做校验；失败返回结构化拒绝原因。
 * 不依赖 store —— 校验与持久化解耦，逻辑无副作用、可测。
 */
import type { MemoryCoreMemoryConfig } from "../../config.js";

export interface CoreWriteInput {
  slot: string;
  content: string;
  source: string;
}

export interface CoreWriteDecision {
  ok: boolean;
  reason?: string;
  /** 校验通过的 slot（白名单内、规范化后）。 */
  slot?: string;
  /** 校验通过的 content（去前后空白）。 */
  content?: string;
  /** 校验通过的 source（规范化：非空 fallback "api"）。 */
  source?: string;
}

const DEFAULT_SOURCE = "api";

/**
 * 校验一次 core 写入。
 * 返回 ok=true（可写）或 ok=false + reason（拒绝原因，可直接暴露给调用方）。
 */
export function validateCoreWrite(
  input: CoreWriteInput,
  cfg: MemoryCoreMemoryConfig,
): CoreWriteDecision {
  if (!cfg.writeEnabled) {
    return { ok: false, reason: "core write disabled by config (memory.coreMemory.writeEnabled=false)" };
  }
  const slot = typeof input.slot === "string" ? input.slot.trim() : "";
  if (!slot) return { ok: false, reason: "slot required" };
  if (cfg.allowedSlots.length === 0) {
    return { ok: false, reason: "core write not allowed (memory.coreMemory.allowedSlots is empty)" };
  }
  if (!cfg.allowedSlots.includes(slot)) {
    return { ok: false, reason: `slot "${slot}" not in allowed slots [${cfg.allowedSlots.join(", ")}]` };
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    return { ok: false, reason: "content (string) required" };
  }
  const content = input.content.trim();
  if (content.length > cfg.maxContentLength) {
    return {
      ok: false,
      reason: `content exceeds max length ${cfg.maxContentLength} (got ${content.length})`,
    };
  }
  // 来源规范化：空 → "api"；非空保留（came from caller），留痕用。不做来源可信判定
  // （传输层 apiKey 已挡非可信调用方；slot 白名单守住"身份层防投毒"）。
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : DEFAULT_SOURCE;
  return { ok: true, slot, content, source };
}