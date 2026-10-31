/**
 * dedupe.ts — skill conversation-add 入口幂等（task-26）。
 *
 * 背景（docs/ops/skill-feed-dedupe-evidence.md 实测）：`/v3/skill/conversation/add`
 * 以前是纯追加、零去重。同一 payload 连投两次 → data-current 2→4 条、
 * byte_count 362→724；只有 3 个唯一 tool_call 的载荷投 4 次就把阈值 10 打满
 * 并归档 48 条（唯一内容 12 条），重复内容整批进 L2 extractor。
 * 插件 outbox 失败重试、双写者（proxy + 插件）都会触发这种重放。
 *
 * 本模块把 L0 的 F-DUP-1 语义（同 session + role + content 在窗口内视为重复）
 * 搬到 skill buffer 入口：
 *   - 普通消息按 (role, content) 比对；
 *   - tool_call / tool_result 按 (role, tool_call_id) 比对（content 里可能带
 *     时间戳/序列化差异，id 才是配对锚点）；
 *   - 比对范围 = 当前 data-current 里的消息 + meta 里持久化的「最近指纹环」。
 *     指纹环跨归档保留（归档只清 buffer，不清 meta 的环），这样「首次 POST 成功
 *     但响应丢失 → outbox 退避重试」落在归档之后也能被拦住。
 *   - 环容量/窗口可配，缺省 200 条 / 10 分钟，与 F-DUP-1 对齐。
 *
 * 边界（写进文档，不做过度承诺）：两个写者的同一回合内容通常并不逐字相同
 * （proxy 的 user 文本带 <acp …> 等上下文），所以内容级去重能拦住「同一写者
 * 重试/重放」与「内容偶然一致」，不能替代运维层排他（双喂只开一条写路径）。
 */

import { createHash } from "node:crypto";

import type { CompressibleMessage } from "./message-compressor.js";

/** 缺省窗口：10 分钟（对齐 L0 F-DUP-1）。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** 缺省环容量：200 条。 */
export const DEFAULT_DEDUPE_MAX_ENTRIES = 200;

/** meta.json 里持久化的单条指纹。t = 该消息被接受时的 wall clock ms。 */
export interface DedupeFingerprint {
  h: string;
  t: number;
}

export interface DedupeOutcome {
  /** 判重后真正应该入 buffer 的消息（保持原始顺序）。 */
  accepted: CompressibleMessage[];
  /** 被判为重复、未入 buffer 的条数（含批内重复）。 */
  skipped: number;
  /** 更新后的指纹环（已按窗口/容量裁剪），调用方负责写回 meta。 */
  ring: DedupeFingerprint[];
}

export interface DedupeInput {
  incoming: readonly CompressibleMessage[];
  /** 当前 data-current 里的消息（历史遗留的重复内容也在这里被比对到）。 */
  buffered: readonly Record<string, unknown>[];
  /** meta.recent_fingerprints（缺省空）。 */
  ring?: readonly DedupeFingerprint[];
  nowMs: number;
  /** 0 = 关闭入口幂等；缺省 DEFAULT_DEDUPE_WINDOW_MS。 */
  windowMs?: number;
  /** 缺省 DEFAULT_DEDUPE_MAX_ENTRIES。 */
  maxEntries?: number;
}

const TOOL_PAIR_ROLES: ReadonlySet<string> = new Set(["tool_call", "tool_result"]);

/**
 * 单条消息的幂等键（sha256 前 32 hex）：
 *   - tool_call / tool_result → role + tool_call_id（配对标；content 可能不同）
 *   - 其他 role              → role + content
 */
export function messageFingerprint(m: {
  role: string;
  content: string;
  tool_call_id?: unknown;
}): string {
  const anchor =
    TOOL_PAIR_ROLES.has(m.role) && typeof m.tool_call_id === "string" && m.tool_call_id.length > 0
      ? `id:${m.tool_call_id}`
      : `content:${m.content}`;
  return createHash("sha256").update(`${m.role}\u0000${anchor}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * 对 incoming 逐条判重，返回去重后的消息 + 更新后的指纹环。
 *
 * 判重集合 = 窗口内的历史指纹（ring） ∪ 当前 buffer 里的消息指纹。
 * 后者的加入是刻意的：buffer 里的内容即将被归档，即使它比窗口更老，
 * 再追加一次也只会制造重复归档（历史污染的 buffer 同样因此不会继续被加倍）。
 */
export function dedupeMessages(input: DedupeInput): DedupeOutcome {
  const windowMs = Math.max(0, input.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
  const maxEntries = Math.max(1, Math.floor(input.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES));

  if (windowMs === 0) {
    // 显式关闭：不判重、不留环（配置错误时行为可预期，而不是半开）。
    return { accepted: [...input.incoming], skipped: 0, ring: [] };
  }

  const cutoff = input.nowMs - windowMs;
  const ring: DedupeFingerprint[] = [];
  for (const fp of input.ring ?? []) {
    if (!fp || typeof fp.h !== "string" || typeof fp.t !== "number") continue;
    if (fp.t > cutoff) ring.push({ h: fp.h, t: fp.t });
  }

  const seen = new Set<string>(ring.map((fp) => fp.h));
  for (const m of input.buffered) {
    const role = typeof m.role === "string" ? m.role : "";
    if (role === "") continue;
    const content = typeof m.content === "string" ? m.content : "";
    seen.add(messageFingerprint({ role, content, tool_call_id: m.tool_call_id }));
  }

  const accepted: CompressibleMessage[] = [];
  let skipped = 0;
  for (const m of input.incoming) {
    const fp = messageFingerprint(m);
    if (seen.has(fp)) {
      skipped += 1;
      continue;
    }
    seen.add(fp);
    accepted.push(m);
    ring.push({ h: fp, t: input.nowMs });
  }

  if (ring.length > maxEntries) ring.splice(0, ring.length - maxEntries);
  return { accepted, skipped, ring };
}
