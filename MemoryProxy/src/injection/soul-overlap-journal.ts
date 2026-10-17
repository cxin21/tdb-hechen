/**
 * #26（R5）：soul/core 注入内容重叠观测 journal —— 纯函数层。
 *
 * 目的（r5-26.md）：
 *   每轮记录 soul_chars / core_chars 及两组注入内容 hash（复用 soul-assembler
 *   fnv1a32 指纹思路），零行为变化（不改动任何注入字节）；逐日统计（报告脚本
 *   可选 days 时间窗，R5-F3 名实相符）
 *
 * 口径版本（#51/H26，2026-10-17）：journal 行带 `norm` 字段标记行 hash 计算口径
 *   —— 1 = 行 hash 按 normalizeJournalLine 归一化口径（ffc33e1 起）；历史行
 *   （ffc33e1 之前）无该字段 = 0 口径（同文异装格式噪声，恒 0% 伪影）。旧行与新行
 *   hash 不互通且不可离线重算（journal 无原文列）→ 报告侧口径感知见
 *   soul-overlap-report.ts（三档判定只消费同口径数据；窗口跨切换日 →
 *   insufficient-window 诚实降级）。
 *
 * 并发假设（R5-F7 注记）：单 proxy 进程单写者；跨进程并发追加在 Windows 上可能
 * 撕裂行（报告脚本按行解析失败即跳过容忍）；缺省 file 相对进程 cwd，生产建议
 * 显式配置绝对路径。
 *   Jaccard 重叠率 + token 成本；结论适用范围=「内容源重叠」，非「注入层重叠」
 *   （soul-identity 走 MemoryCore 召回块、core_memory 走主链路 system prompt，
 *   两侧不同层）。
 *
 * 预注册决策规则（R5 对抗审查修正，防数据出来后拍板拉锯）：
 *   重叠 >80% → 归一通道；60-80% → 标注分工边界；<60% → 维持双通道关票。
 *
 * 本文件不依赖 observer/pipeline —— 可独立单测；side-effect 只在 appendJournalEntry。
 */

import fs from "node:fs";
import path from "node:path";

/** #51：journal 行口径版本当前值（写入面使用；读取面用 journalNormVersion 容错）。 */
export const JOURNAL_NORM_VERSION = 1;

/** 单轮 journal 条目（JSONL 一行一条）。 */
export interface SoulOverlapJournalEntry {
  /** ISO 时间戳。 */
  ts: string;
  /** 会话键（缺失记 "unknown"）。 */
  session: string;
  /** 轮次序号（缺失记 -1）。 */
  turn_seq: number;
  soul_chars: number;
  core_chars: number;
  /** 整段内容 fnv1a32 hex（与 MemoryCore soul-assembler 同算法）。 */
  soul_hash: string;
  core_hash: string;
  /** 逐行 hash 集合（Jaccard 的计算材料；空行剔除）。 */
  soul_line_hashes: string[];
  core_line_hashes: string[];
  /** 行 hash 口径版本（#51）：1=归一化口径；缺省/0=未归一旧口径（向后兼容）。 */
  norm?: number;
}

/**
 * 读取行口径版本：缺省/undefined/NaN/非数字 → 0（旧口径，向后兼容不炸）。
 * 判定语义见 soul-overlap-report.ts（三档规则只消费同口径数据）。
 */
export function journalNormVersion(e: { norm?: number } | undefined): number {
  const n = e?.norm;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** FNV-1a 32bit（与 MemoryCore/src/core/hooks/soul-assembler.ts 同算法，跨包一致性）。 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 从注入块中提取 soul 与 core 两个内容源。
 *
 * soul  = <soul-identity>…</soul-identity> + <soul-feeling>…</soul-feeling>（MemoryCore 召回侧）
 * core  = <tdai_profile_memory>…</tdai_profile_memory>（主链路 system prompt 侧）
 *
 * 两者皆空返回 null（该轮无需记账）。
 */
export function extractSoulCore(
  blocks: { content: string }[],
): { soul: string; core: string } | null {
  let soul = "";
  let core = "";
  for (const b of blocks ?? []) {
    const content = typeof b?.content === "string" ? b.content : "";
    if (!content) continue;
    const soulIdentity = content.match(/<soul-identity>[\s\S]*?<\/soul-identity>/g);
    const soulFeeling = content.match(/<soul-feeling>[\s\S]*?<\/soul-feeling>/g);
    if (soulIdentity) soul += soulIdentity.join("\n\n");
    if (soulFeeling) soul += (soul ? "\n\n" : "") + soulFeeling.join("\n\n");
    const profile = content.match(/<tdai_profile_memory>[\s\S]*?<\/tdai_profile_memory>/g);
    if (profile) core += (core ? "\n\n" : "") + profile.join("\n\n");
  }
  if (!soul && !core) return null;
  return { soul, core };
}

/**
 * 行级归一化（H26，2026-10-17）：soul 侧 slot 行带「（我是谁）- [slot] - 」包装、core 侧为裸文本/markdown 行，
 * 同文异装字节不同 → 行 hash 恒不同 → 重叠恒 0%（生产 372 行实证，预注册规则两周后将被误判关票）。
 * 剥包装后再 hash：① soul slot 段前缀；② slot 标记 `- [x] - `；③ 两侧列表标记 `- `。
 * 兼容性：hash 值与未归一版本不互通——跨版本窗口混装期以同期行为准（报告按日聚合，影响可忽略）。
 */
export function normalizeJournalLine(line: string): string {
  return line
    .replace(/^（我是谁）\s*/, "")
    .replace(/^（我心中的他）\s*/, "")
    .replace(/^-\s*\[[^\]]+\]\s*-\s*/, "")
    .replace(/^-\s+/, "")
    .trim();
}

/** 逐行 hash 集合（空行剔除；行内 trim+H26 归一化后 hash）。 */
export function lineHashes(text: string): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => normalizeJournalLine(l.trim()))
    .filter((l) => l.length > 0)
    .map((l) => fnv1a32(l));
}

/** Jaccard：|A∩B| / |A∪B|；两侧皆空返回 0（无材料不计重叠）。 */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 组装单轮条目；无 soul/core 材料返回 null。 */
export function buildJournalEntry(
  blocks: { content: string }[],
  meta: { sessionKey?: string; turnSeq?: number } | undefined,
  now: Date = new Date(),
): SoulOverlapJournalEntry | null {
  const extracted = extractSoulCore(blocks);
  if (!extracted) return null;
  return {
    ts: now.toISOString(),
    session: meta?.sessionKey ?? "unknown",
    turn_seq: typeof meta?.turnSeq === "number" ? meta.turnSeq : -1,
    soul_chars: extracted.soul.length,
    core_chars: extracted.core.length,
    soul_hash: extracted.soul ? fnv1a32(extracted.soul) : "",
    core_hash: extracted.core ? fnv1a32(extracted.core) : "",
    soul_line_hashes: lineHashes(extracted.soul),
    core_line_hashes: lineHashes(extracted.core),
    norm: JOURNAL_NORM_VERSION, // #51：lineHashes 已按归一化口径计算（ffc33e1 起）
  };
}

/** 追加一条 JSONL（目录不存在则创建；同步 append 保证行序）。错误向上抛，由 observer 吞。 */
export function appendJournalEntry(file: string, entry: SoulOverlapJournalEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}
