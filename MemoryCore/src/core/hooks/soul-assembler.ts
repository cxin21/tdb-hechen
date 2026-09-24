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

/**
 * D-1（2026-09-21，用户拍板"全做"）：F17 截断改按行（事实）边界。
 *
 * 旧行为（§2.7 F17 字符 slice）截在事实句中间——注入块以残句喂 LLM，主语完整性破损
 *（2026-09-21 活体实证：self 600 字符截于"如 identit"）。新行为：逐行累积预算内整行、
 * 超限行整体丢弃（宁缺毋滥）；无一行可用时退回首行字符截断（槽不空，避免整段注入丢失）。
 * A/B 新旧对照 ≥10 组（真实生产槽内容）见 UI 对话验收记录与 spec §2.7 注记。
 */
export function truncateByLines(content: string, budget: number): string {
  if (budget <= 0 || content.length <= budget) return content;
  const lines = content.split("\n");
  if (lines.length <= 1) return content.slice(0, budget);
  let acc = "";
  for (const line of lines) {
    const next = acc ? `${acc}\n${line}` : line;
    if (next.length > budget) break;
    acc = next;
  }
  // 无任何完整行可用（首行即超预算）→ 首行字符截断兜底（宁缺毋滥不等于整段清空）
  if (!acc) return content.slice(0, budget);
  return acc;
}

function valenceDir(v: number | null | undefined): string {
  if (v === 1) return "趋近";
  if (v === -1) return "审慎";
  if (v === 0) return "中性";
  return "";
}

/** V6-1b：weight 显示值（两位小数去尾零：0.33→"0.33"、0.8→"0.8"、1→"1"）。 */
function weightLabel(w: number): string {
  return w.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** P2（spec §2.7）：人物锚关系方向词——与主题价值方向（审慎）区分（回避≠审慎）。 */
function personDir(v: number | null | undefined): string {
  if (v === 1) return "趋近";
  if (v === -1) return "回避";
  if (v === 0) return "中性";
  return "";
}

/** DS-SOUL-MEMORY-002 P1（F17）：段级渲染选项。缺省（undefined）= 旧渲染字节级一致。 */
export interface SoulRenderOptions {
  selfIdentityEnabled?: boolean;
  budgetSelfChars?: number;
  budgetIdentityChars?: number;
  /** F17（审计补齐）：重要的人 行数上限（weight DESC 截断）；缺省 5=原行为。 */
  maxRelationLines?: number;
}

/** 立项①（2026-09-23 拍板）：attrs_json 安全解析（description/role/aliases；损坏→undefined 宁缺毋滥）。 */
function attrsOf(attrsJson?: string): { description?: string; role?: string; aliases?: string[] } | undefined {
  if (!attrsJson || attrsJson === "{}") return undefined;
  try {
    const p = JSON.parse(attrsJson);
    return p && typeof p === "object" ? (p as { description?: string; role?: string; aliases?: string[] }) : undefined;
  } catch {
    return undefined;
  }
}

/** 立项③：灵魂指纹（soulVersion）——双槽内容 ∪ 锚集合的稳定哈希（fnv-1a 32bit，零依赖）。
 *  未变化=桥接端可复用上轮 soul 字节（KV cache 连续性）；变化=立即重注入（人格不冻结）。 */
export function computeSoulVersion(
  slots: Array<{ slot: string; content: string }>,
  values: Array<{ value_id?: string; label?: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string }>,
): string {
  const payload = JSON.stringify({
    s: slots.map((x) => [x.slot, x.content]),
    v: values
      .map((x) => [x.value_id ?? x.label, x.label, x.weight ?? 0, x.valence ?? null, x.state ?? "active", x.node_type ?? "theme", x.attrs_json ?? "{}"])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `sv-${h.toString(16).padStart(8, "0")}`;
}

/** 立项③ TDB 内部完整实现（2026-09-23 拍板）：soul 前缀会话级缓存——指纹未变化跳过渲染，
 *  变化时重渲染并打「人格变更」日志（审计面）。Map 按租户隔离，上限 100 条。
 *  零外部依赖——整个优化闭环在 TDB 内核完成。 */
const soulPrefixCache = new Map<string, { version: string; text: string }>();
const SOUL_CACHE_MAX = 100;

export async function buildSoulPrefix(
  store: IMemoryStore,
  tenant: CoreTenant,
  logger?: Logger,
  opts?: SoulRenderOptions,
  metaOut?: { soulVersion?: string },
): Promise<string> {
  const parts: string[] = [];
  let soulVer = '';
  let cacheKey = '';
  try {
    const slots = ((await Promise.resolve(store.readCore?.(tenant))) ?? []) as Array<{ slot: string; content: string }>;
    const values = ((await Promise.resolve(store.listValues?.(tenant))) ?? []) as Array<{ value_id?: string; label: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string }>;
    const activeAll = values.filter((v) => v.state === undefined || v.state === "active");
    // P2（spec §2.7）：person 锚分流——主题锚渲染不变（undefined → theme 旧库兼容）；
    // 人物锚进「重要的人」行（weight DESC，行数上限 opts.maxRelationLines 缺省 5），不与价值审慎/趋近语义混淆。
    const active = activeAll.filter((v) => v.node_type !== "person");
    const personRows = activeAll
      .filter((v) => v.node_type === "person")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, opts?.maxRelationLines ?? 5)
      // 立项②（2026-09-23 拍板）：取舍按 weight、渲染按 value_id 稳定排序（KV cache 前缀连续性）
      .sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)));

    soulVer = computeSoulVersion(slots, activeAll);
    if (metaOut) metaOut.soulVersion = soulVer;

    // 立项③：指纹→缓存命中跳渲染 / 变更重渲染+人格变更日志
    cacheKey = `${tenant.teamId}|${tenant.userId}|${tenant.agentId}`;
    const cached = soulPrefixCache.get(cacheKey);
    if (cached && cached.version === soulVer) {
      logger?.debug?.(`[soul] prefix cache hit ${soulVer}`);
      return cached.text;
    }
    if (cached) {
      logger?.info?.(`[soul] 人格变更 ${cacheKey}: ${cached.version} → ${soulVer}`);
    }
    // ── 身份段：此刻的你 ──
    if (slots.length > 0 || activeAll.length > 0) {
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
        const content = budget !== undefined ? truncateByLines(s.content, budget) : s.content;
        const label = labelFor(s.slot);
        lines.push(dual && label ? `（${label}）- [${s.slot}] ${content}` : `- [${s.slot}] ${s.content}`);
      }
      if (active.length > 0) {
        // 立项②：渲染顺序按 value_id 稳定排序（weight 只用于取舍/排序上限，不决定注入序）
        const activeStable = [...active].sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)));
        lines.push(
          `价值锚：${activeStable.map((v) => {
            const desc = attrsOf(v.attrs_json)?.description;
            const descSeg = typeof desc === "string" && desc.trim() !== "" ? `：${escapeXmlTags(desc.trim())}` : "";
            // V6-1b：weight 显示（仅展示信念强度，不改渲染序——立项② value_id 稳定排序不变；
            // weight ≤0 视为未测量不展示，宁缺毋滥）
            const dir = valenceDir(v.valence);
            const wSeg = typeof v.weight === "number" && Number.isFinite(v.weight) && v.weight > 0
              ? `${dir ? "·" : ""}w${weightLabel(v.weight)}`
              : "";
            return `${escapeXmlTags(v.label)}${dir || wSeg ? `(${dir}${wSeg})` : ""}${descSeg}`;
          }).join("、")}`,
        );
      }
      // P2：重要的人 行——数据驱动（无 person 行 → 省略）；role 缺失只省 role 段
      if (personRows.length > 0) {
        lines.push(
          `重要的人：${personRows.map((v) => {
            // V6-1e：attrsOf 统一解析（含 description）——「label(role·方向)：描述」与价值锚行同构；
            // 当前生产 person 锚无 description=描述段休眠（数据面回填另行拍板）。
            const a = attrsOf(v.attrs_json) ?? {};
            const d = personDir(v.valence);
            const role = a.role ? `${escapeXmlTags(a.role)}·` : "";
            const pDesc = a.description && a.description.trim() !== "" ? `：${escapeXmlTags(a.description.trim())}` : "";
            return `${escapeXmlTags(v.label)}(${role}${d})${pDesc}`;
          }).join("、")}`,
        );
      }
      if (lines.length > 0) parts.push(`<soul-identity>\n## 此刻的你\n${lines.join("\n")}\n</soul-identity>`);
    }

    // ── 感受段：当下的感受 ──
    // F-EV12-5（A-5③，spec §2.7「soul-feeling 保持仅主题锚」）：character 锚不入感受段
    //（价值锚行保留 = §7「与主题锚共享注入预算」）；node_type 缺省 theme 旧库兼容。
    // 立项②：感受段与价值锚行同序（value_id 稳定）——pos/neg 清单不再随 weight 漂移
    const directional = [...active]
      .sort((a, b) => String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)))
      .filter((v) => (v.node_type ?? "theme") === "theme" && (v.valence === 1 || v.valence === -1));
    if (directional.length > 0) {
      const pos = directional.filter((v) => v.valence === 1).map((v) => escapeXmlTags(v.label));
      const neg = directional.filter((v) => v.valence === -1).map((v) => escapeXmlTags(v.label));
      const feel: string[] = [];
      // V6-1d（方案B，2026-09-23 用户授权自审定案）：渲染序保持 value_id 稳定（立项②）；
      // 「首要」锚按 weight 最高选取（选取与排序解耦），附 description 短句 ≤30 字（宁缺毋滥）。
      const topDescSeg = (rows: typeof directional): string => {
        const top = [...rows].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)))[0];
        if (!top || !((top.weight ?? 0) > 0)) return "";
        const d = attrsOf(top.attrs_json)?.description?.trim();
        if (!d) return "";
        // V7 方案A：首句优先（句边界截取；首句超预算或无句界且超 80 则省略=宁缺毋滥；与 Panel firstSentenceDesc 同构）
        const m = /[。！？；!?\n]/.exec(d);
        if (m) {
          return m.index + 1 <= 80 ? `；首要 ${escapeXmlTags(top.label ?? "")}：${escapeXmlTags(d.slice(0, m.index + 1).trim())}` : "";
        }
        return d.length <= 80 ? `；首要 ${escapeXmlTags(top.label ?? "")}：${escapeXmlTags(d)}` : "";
      };
      if (pos.length > 0) feel.push(`驱动我行动的价值：${pos.join("、")}${topDescSeg(directional.filter((v) => v.valence === 1))}`);
      if (neg.length > 0) feel.push(`提醒我审慎的价值：${neg.join("、")}${topDescSeg(directional.filter((v) => v.valence === -1))}`);
      if (feel.length > 0) parts.push(`<soul-feeling>\n## 当下的感受\n${feel.join("\n")}\n</soul-feeling>`);
    }
  } catch (err) {
    logger?.warn?.(`[soul] assemble failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
  if (soulVer) {
    if (soulPrefixCache.size >= SOUL_CACHE_MAX) {
      const oldest = soulPrefixCache.keys().next().value;
      if (oldest !== undefined) soulPrefixCache.delete(oldest);
    }
    soulPrefixCache.set(cacheKey, { version: soulVer, text: result });
  }
  return result;
}