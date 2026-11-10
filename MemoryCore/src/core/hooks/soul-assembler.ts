/**
 * soul-assembler —— 灵魂组装器的历史入口；**人格渲染已退役**（2026-11-07，task-6）。
 *
 * 人格注入已收敛为 DSH 插件两段，本模块不再参与生产注入：
 *   ① 稳定卡：`dsh-plugin/src/persona-card.ts` 的 `tdb-agemem:persona-card` systemPrompt section；
 *   ② 每轮 volatile 段：Core 产出 `GET /v3/soul/card` 与 `GET /v3/soul/turn`（`src/core/soul/card-service.ts`）。
 *
 * 本文件删掉的东西（同一份人格曾因此可能被注入两次）：
 *   - core_memory 槽身份段与红线（strict_rule 段）渲染（旧红线渲染器已随之删除）；
 *   - soul_persona 段（经 renderPersonaBlock）；
 *   - 价值锚 / 重要的人 / 品格 / 承诺 / capabilities 渲染面；
 *   - soulPrefixCache（进程内前缀缓存）与渲染旁路快照落账（`soul_snapshots` 的唯一写者
 *     已归 card-service 的 worker tick 末，双写者会互刷「人格变更」假阳性）。
 *
 * 仅保留 `<soul-feeling>`（近期基调 + 当下状态）——`soul-introspect.ts` 的「当前渲染」面
 * 仍读它；auto-recall 的注入装配不再调用本函数，故注入块里不再出现人格段。
 * 纯函数（悬空尾判定/指纹）仍是既有调用方的公共工具：`anchor-desc.ts` 依赖 `isDanglingTail`。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";
import { renderStateIntent, renderStateLine, type SoulState } from "./soul-state.js";
import { renderMoodLine, type SoulMoodState } from "../soul/emotion.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG, type SoulMaintenanceConfig } from "../soul/types.js";

/**
 * v18-d（何晨拍板「全做」2026-10-05）：desc 悬空尾判定单一源（高置信断尾门）。
 * 置空判据只留确定性特征：剥尾引号[”"』」']后尾悬空标点[，、,]（截断在句读处 =
 * 后面还有内容被掐，语义未完态明确）。
 * 长度判据已删除（复跑实锤：合法锚 desc「所有结论须以真实代码与测试取证背书」17 字与
 * 断尾残句「何晨一贯要求系统行为」10 字区间完全重叠，任何阈值都同时误杀/放行——低置信
 * 不判，宁缺毋滥 ≠ 宁枉勿纵）。消费方：`anchor-desc.ts` 写入口（gateway→core/hooks 引用方向合法）。
 */
export function isDanglingTail(s: string): boolean {
  if (typeof s !== "string") return false;
  const bare = s.replace(/[”"』」']+/gu, "");
  return /[，、,]$/.test(bare);
}

/** 立项③：灵魂指纹（soulVersion）——双槽内容 ∪ 锚集合的稳定哈希（fnv-1a 32bit，零依赖）。
 *  未变化=桥接端可复用上轮 soul 字节（KV cache 连续性）；变化=立即重注入（人格不冻结）。
 *  注：人格渲染退役后本函数只剩调用方自用与单测引用（卡片的版本由 card-service 产出）。 */
export function computeSoulVersion(
  slots: Array<{ slot: string; content: string }>,
  values: Array<{ value_id?: string; label?: string; weight?: number; valence?: number | null; state?: string; node_type?: string; attrs_json?: string }>,
  moodTier?: string,
): string {
  // S-FEEL-1（M1/IF-2）：moodTier 缺省 undefined → payload 与现状逐字节一致（快照守卫断言）；
  // 只纳入档位（三值化控 KV 抖动——设计 §1.3），不纳入样本数。
  const payloadBase = {
    s: slots.map((x) => [x.slot, x.content]),
    v: values
      .map((x) => [x.value_id ?? x.label, x.label, x.weight ?? 0, x.valence ?? null, x.state ?? "active", x.node_type ?? "theme", x.attrs_json ?? "{}"])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  const payload = JSON.stringify(moodTier !== undefined ? { ...payloadBase, m: moodTier } : payloadBase);
  return `sv-${fnv1a32Hex(payload)}`;
}

/** FNV-1a 32bit（零依赖）→ 8 位十六进制（无前缀）。
 *  R5-F1（2026-10-16 对抗审查）：乘法用 Math.imul 保持 32 位语义——原 (h*0x01000193)>>>0
 *  中间积最高 ~7.2e16 超 2^53 精度丢失，非标准 FNV-1a；现与 MemoryProxy
 *  soul-overlap-journal.ts 同算法。>>>0 仍必须保留（Math.imul 返回带符号 int32，
 *  负数 toString(16) 会产出 sv--xxx 双横线畸形——P14/P50 探针抓到后修正）。
 *  R5-F2：sv（人格指纹=slots/values/mood）与快照 contentHash（渲染字节哈希）共用
 *  本算法但语义不同——同 sv 可有多个布局 payload，contentHash 逐一入账不互抑。 */
export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 段级渲染选项 —— 只保留 buildSoulPrefix 真正消费的四个字段（2026-11-07，task-12）。
 *
 * 人格/身份/红线/价值锚/承诺/能力清单渲染退役后，旧选项字段（身份与各段预算、快照落账、
 * 按轮次槽位、锚选取与打分配置、跨段去重门、承诺与能力清单渲染门）已无任何读取方，
 * 随对应死配置一并删除。
 */
export interface SoulRenderOptions {
  /** S-FEEL-1（M1）：近期情绪基调（mood-line.ts 聚合产出；缺省 undefined=基调行不渲染）。 */
  moodTier?: { tier: "positive" | "neutral" | "strained"; sampleCount: number } | null;
  /** #34（S13/R5）：会话级当下状态（soul-feeling 尾块行）。 */
  state?: SoulState | null;
  /** 自维护人格层的预算/阈值——仅 moodDeviationThreshold 被本层消费（心境偏移阈值）。 */
  soulMaintenance?: SoulMaintenanceConfig;
  /** 心境（soul_state 积分值）：与基线比的连续读数——一部分一条，绝不写成绝对档位。 */
  soulMood?: SoulMoodState;
}

/**
 * 组装注入前缀 —— **现在只输出 `<soul-feeling>`（近期基调 + 当下状态）**。
 *
 * 人格已移交插件（见文件头）。因此本函数：
 *   - 不读 core_memory 槽、不读 soul_persona、不读承诺、不选择锚、不写快照；
 *   - 不可能产出身份段 / 人格段 / 红线段 / 价值锚行（标签字面量不再出现在本模块）。
 * 宁缺毋滥：无 moodTier / soulMood / state → 返回空串（不注入空段）。
 *
 * 生产注入路径不再调用本函数（auto-recall 已删除 soulPrefix 组装）；现存调用方只有
 * `soul-introspect.ts`（POST /v3/soul/introspect 的「当前渲染」面）。
 */
export async function buildSoulPrefix(
  _store: IMemoryStore,
  _tenant: CoreTenant,
  _logger?: Logger,
  opts?: SoulRenderOptions,
): Promise<string> {
  const personaCfg = opts?.soulMaintenance ?? DEFAULT_SOUL_MAINTENANCE_CONFIG;
  const feel: string[] = [];
  if (opts?.soulMood) {
    // 阈值必须与 worker 生成 prompt/账本那一句时同口径（moodDeviationThreshold*0.5）：
    // 同一份心境，模型在 prompt 里读到「更能撑住」、注入里却一个字没有，等于两个自我描述。
    feel.push(
      renderMoodLine(opts.soulMood, {
        threshold: personaCfg.moodDeviationThreshold * 0.5,
        emotion: opts.soulMood.emotion
          ? {
              object: opts.soulMood.emotion.object,
              label: opts.soulMood.emotion.label,
              effectiveIntensity: opts.soulMood.emotion.intensity,
            }
          : undefined,
      }),
    );
  } else if (opts?.moodTier) {
    const tierLabel = opts.moodTier.tier === "positive" ? "偏积极" : opts.moodTier.tier === "strained" ? "偏承压" : "平稳";
    feel.push(`近期基调：${tierLabel}。`);
  }
  if (opts?.state) {
    // 自维护人格层在场时情绪已由 renderMoodLine（与基线比的连续读数）承载：再并列绝对
    // 档位句会出现两套互相矛盾的情绪自述。topValue 是意图不是情绪，单独保留。
    const stateLine = opts?.soulMood ? renderStateIntent(opts.state) : renderStateLine(opts.state);
    if (stateLine) feel.push(stateLine);
  }
  if (feel.length === 0) return "";
  return `<soul-feeling>\n## 当下的状态\n${feel.join("\n")}\n</soul-feeling>\n\n`;
}