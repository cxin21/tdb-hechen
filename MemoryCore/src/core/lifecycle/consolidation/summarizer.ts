/**
 * H 巩固 · 持续态摘要：把一组同主题点状 L1 熬成一条"持续态"记录（TSM 思路）。
 * best-effort：LLM 失败返回 null，不阻塞。
 */
import type { ConsolidationGroup } from "./grouping.js";
import type { LLMRunner, Logger } from "../../types.js";

export interface DurativeRecord {
  content: string;
  /** 归并键（subject）：worker 填充；作持续态幂等匹配键（metadata.subject）。 */
  subject?: string;
  occurred_at: string;      // 组内最新
  valid_start?: string;     // 组内最早
  valid_end?: string;       // 组内最新
  significance: number;     // 组内 max
  certainty: "observed";    // 持续态只基于 observed（reconsolidation 红线）
  /** 该结论被观察到的次数 = 组内源记忆条数（真实计数，供 M 反漂移 minObserved 用） */
  observedCount: number;
}

export interface SummarizerConfig {
  model?: string;
  /** 生成持续态的 system prompt 前缀（可整体覆盖） */
  promptPrefix?: string;
}

const DEFAULT_PROMPT_PREFIX =
  "你是记忆巩固器。把同一主题的多条点状记忆合并成一条【持续态摘要】——概括稳定现状、变化轨迹与当前结论，" +
  "不要编造组内没有的事实。只输出JSON：{content, certainty:'observed'}，不要其他文字。";

export function buildSummarizePrompt(group: ConsolidationGroup): string {
  const lines = group.memories.map((m) => `- [${m.type}] ${m.content}`).join("\n");
  return `主题：${group.subject}\n\n组内记忆：\n${lines}\n\n输出合并后的持续态摘要。`;
}

/**
 * 生成一条持续态摘要。仅当组内存在可观察(observed)记忆可用；返回 null 表示不巩固。
 */
export async function buildDurativeSummary(
  group: ConsolidationGroup,
  deps: { llmRunner: LLMRunner; config?: SummarizerConfig; logger?: Logger },
): Promise<DurativeRecord | null> {
  const cfg = deps.config ?? {};
  const sys = cfg.promptPrefix ?? DEFAULT_PROMPT_PREFIX;
  try {
    const raw = await deps.llmRunner.run({
      prompt: buildSummarizePrompt(group),
      systemPrompt: sys,
      taskId: "l1-consolidation",
      timeoutMs: 30_000,
    });
    let parsed: { content?: string; certainty?: string };
    try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")); }
    catch { return null; }
    if (!parsed?.content?.trim()) return null;
    const latest = new Date(group.latestTs).toISOString();
    const earliest = new Date(group.earliestTs).toISOString();
    // H-B8：读组内顶层 significance 真实 max（P2a 权威字段），不再用 priority/100 伪造；
    // 半数以上缺值才退中性 0.5（P-D：拿不到真值不造假值，但也不放弃真实信息）。
    // C4 策略统一（spec §5）：significance 提取改顶层→metadata 双兜底，与
    // forgetting/scorer.ts significanceOf 同构——行来源（queryL1Records + T17.5
    // mapL1RowToRecord）把 metadata_json 并入 metadata，顶层缺值时 metadata
    // 仍携带真值，旧实现只读顶层会把真值丢成 0.5。
    // S3（C4 审计 Minor #3）：提取即 clamp [0,1]（与 scorer 同构）——越界
    // LLM/legacy 值不再污染持续态 salience，界内逐位不变。
    const sigs = group.memories
      .map((m) => {
        const rec = m as { significance?: number; metadata?: Record<string, unknown> };
        let v: number | null = null;
        if (typeof rec.significance === "number") v = rec.significance;
        else {
          const metaSig = rec.metadata?.significance;
          if (typeof metaSig === "number") v = metaSig;
        }
        return v === null ? null : Math.min(Math.max(v, 0), 1);
      })
      .filter((v): v is number => v !== null);
    const significance = sigs.length >= Math.ceil(group.memories.length / 2)
      ? Math.max(...sigs)
      : 0.5;
    return {
      content: parsed.content.trim(),
      occurred_at: latest,
      valid_start: earliest,
      valid_end: latest,
      significance,
      // 防御断言（登记，不加代码）：此处 certainty 恒 "observed" 的前提是上游
      // consolidation-worker 的 sourceMemories 已过滤 inferred（P0-T1 守卫）。
      // 若上游回归（inferred 混进组），这里会把推断内容洗成 observed——届时须在
      // 本层补 isObservable 门，而不是依赖上游单点。
      certainty: "observed",
      observedCount: group.memories.length,
    };
  } catch (err) {
    deps.logger?.warn?.(`[consolidation] summarize failed for "${group.subject}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}