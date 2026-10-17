/**
 * #40（ADR0003-P3 接线票 B）· 工具面策展器——运行时实况 → soul 前缀 capabilities 段数据源。
 *
 * 合同（#40 票面 + ADR0003 §6 + #32 渲染一致性合同）：
 *   - 模板直出（禁 LLM、禁逐字 L1 片段，#27 提案门范式）：行 = `能力名：一句话`
 *     （描述取首行、>80 字符截断加 …；空描述 → 裸名）；
 *   - ≤5 行：声明序前 5（确定性输出，KV cache 稳定；一致性合同=渲染行=策展清单 1:1）；
 *   - 跳过空/纯空白名（宁缺毋滥）；空工具面 → 空数组（调用方据此不携带=核心不渲染）；
 *   - 记忆化：同工具面（指纹 = [name,description][] 序列化 FNV-1a 32bit，#34/#32/#39
 *     指纹先例同算法）→ 同引用（工具面未变更不重策展）；内容变更 → 重策展；
 *     上限 100 条 FIFO 淘汰（soul-assembler soulPrefixCache 同形）。
 *
 * #40-B（ADR0003 派生票 B，2026-10-17）工具面数据源合同修订：config lines 显式通道
 * （第 3 参 readonly string[]）。lines 非空 → 逐字 1:1 直出（config 即数据源，工具面
 * 实况不参与，不做 firstLine 截断），仍受 maxLines 上限保护；指纹覆盖 lines（前缀
 * "lines" 与工具面指纹空间隔离），config 行变更必换键 → 缓存失效重算。
 * lines 缺失/空 → 既有运行时策展（逐位现状，296 基线回归锚）。
 *
 * 消费方：tdai-l1-recall-injector（self ctx 专属携带 → /v3/recall body.capabilities →
 * MemoryCore auto-recall（config 门）→ buildSoulPrefix 渲染「## 我能做什么」）。
 */
import type { AgentTool } from "../types.js";
import { fnv1a32 } from "../soul-overlap-journal.js";

const DEFAULT_MAX_LINES = 5;
const DESC_MAX_CHARS = 80;
const CACHE_MAX = 100;
/** kill switch 返回值（m00265）：冻结空数组共享引用，语义=整段摘除（不入策展缓存）。 */
const FROZEN_EMPTY: readonly string[] = Object.freeze([]);

/** 策展结果记忆化（进程内；键=工具面内容指纹，非身份维度——策展是纯函数，租户无影响面）。
 *  值=readonly：#40-R5 缓存引用冻结，调用方突变在类型层即被拒绝。 */
const capabilityCache = new Map<string, readonly string[]>();

/** 测试专用：清空策展记忆化缓存（跨用例隔离，profile/corecache 测试同款导出先例）。 */
export function resetToolCapabilityCacheForTest(): void {
  capabilityCache.clear();
}

/** 描述首行（截断 ≤80 字符加省略号；缺省/空 → 空串=渲染裸名）。
 *  审查修补（#40-R4）：跳过前导空行——描述以空行开头的工具应取首个非空行，
 *  而非退化为裸名（裸名丢失一句话自述，违背策展意图）。 */
function firstLine(description: string | undefined): string {
  const lines = (description ?? "").split("\n");
  let first = "";
  for (const line of lines) {
    const t = line.trim();
    if (t) {
      first = t;
      break;
    }
  }
  return first.length > DESC_MAX_CHARS ? `${first.slice(0, DESC_MAX_CHARS)}…` : first;
}

/**
 * 工具面策展（模板直出，零 LLM）：返回 ≤maxLines 行能力自述清单。
 * 输出确定性：声明序前 maxLines 行（KV cache 前缀稳定）；同名重复工具不去重
 * （协议层 tools 清单本身无重复语义，逐位直出）。
 *
 * #40-B：configLines 非空 → 逐字 1:1 直出（config 即数据源，工具面实况不参与、
 * 不做 firstLine 截断），仍受 maxLines 上限保护；缺失/空 → 既有运行时策展。
 *
 * kill switch（m00265 用户终审 2026-10-17）：enabled=false → 先于 literal/策展
 * 两路径返回冻结空数组（config-first 缺省 true 零行为变化）。空数组语义=调用方
 * 不携带 capabilities → 核心不渲染「## 我能做什么」标题（soul-assembler :599 门）。
 * 关断结果不入缓存（kill switch 非策展结论，关断期不污染正常指纹空间）。
 */
export function curateToolCapabilities(
  tools: AgentTool[] | undefined | null,
  maxLines = DEFAULT_MAX_LINES,
  configLines?: readonly string[],
  enabled?: boolean,
): readonly string[] {
  // kill switch 先于两路径（m00265）：整段摘除唯一入口；冻结空数组=调用方省键。
  if (enabled === false) return FROZEN_EMPTY;

  // #40-B config 显式通道：指纹前缀 "lines" 与工具面指纹空间隔离（键含 maxLines
  // + lines 全量序列化——纯函数两参数全量进入键空间，config 行变更必失效重算）。
  if (configLines && configLines.length > 0) {
    const fingerprint = fnv1a32(`lines\u0000${maxLines}\u0000${JSON.stringify(configLines)}`);
    const cached = capabilityCache.get(fingerprint);
    if (cached) return cached;
    return cachePut(fingerprint, Object.freeze(configLines.slice(0, maxLines)));
  }

  const list = Array.isArray(tools) ? tools : [];
  // 指纹并入 maxLines（审查 M-2）：未来第二调用点传不同截断行数时不会命中
  // 首个调用点的缓存（键=行数+工具面内容，纯函数两参数全量进入键空间）。
  const fingerprint = fnv1a32(
    `${maxLines}\u0000${JSON.stringify(list.map((t) => [t?.name ?? "", t?.description ?? ""]))}`,
  );
  const cached = capabilityCache.get(fingerprint);
  if (cached) return cached;

  const lines: string[] = [];
  for (const t of list) {
    if (lines.length >= maxLines) break;
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    if (!name) continue; // 空/纯空白名跳过（宁缺毋滥）
    const desc = firstLine(t?.description);
    lines.push(desc ? `${name}：${desc}` : name);
  }

  return cachePut(fingerprint, Object.freeze(lines)); // #40-R5：缓存引用冻结
}

/** 缓存写入（100 FIFO 淘汰 + 返回冻结引用；两条策展路径共用，#40-R5 语义不变）。 */
function cachePut(fingerprint: string, frozen: readonly string[]): readonly string[] {
  if (capabilityCache.size >= CACHE_MAX) {
    const oldest = capabilityCache.keys().next().value;
    if (oldest !== undefined) capabilityCache.delete(oldest);
  }
  capabilityCache.set(fingerprint, frozen);
  return frozen;
}
