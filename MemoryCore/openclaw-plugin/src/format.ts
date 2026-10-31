/**
 * Format recall results into prompt context.
 *
 * Output structure (mirrors original memory-tencentdb plugin):
 * - prependContext: dynamic L1 memories (changes per turn, injected before user message)
 * - appendSystemContext: stable content (Persona + Scene Nav + tools guide, appended to system prompt)
 */

import type { RecallResult } from "./hooks/recall.js";
// 注入文案（单一正文源在 MemoryCore/src/core/prompts/；本仓 src/prompt-context.ts 是构建期镜像，
// 逐字一致性由 MemoryCore/__tests__/openclaw-format-parity.test.ts 断言）。
import { MEMORY_TOOLS_GUIDE, RECALL_WRAPPER_HEAD, buildAnswerGuidance } from "./prompt-context.js";

interface L1Item {
  id: string;
  content: string;
  type: string;
  score?: number;
}

interface SceneEntry {
  path: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Format L1 memories as prependContext.
 */
function formatL1Memories(items: L1Item[]): string | undefined {
  if (items.length === 0) return undefined;

  // 口径与钩子路逐字一致（MemoryCore/src/core/hooks/auto-recall.ts:2192-2197）：
  // 包裹语（calibrated 档，不写「仅作参考」也不诱导拒答）→ 记忆行 → 答案口径段（币值/建议）。
  // 旧实现只输出裸 <relevant-memories>：既没有「请据此回答」的指示，也没有
  // 「有相关记录就必须作答并注明时间」的纪律 ⇒ 与钩子路分叉，是 OpenClaw 路径拒答率偏高的机制之一。
  const lines: string[] = [
    "<relevant-memories>",
    RECALL_WRAPPER_HEAD,
    "",
  ];

  for (const item of items) {
    const typeTag = item.type ? `[${item.type}]` : "";
    lines.push(`- ${typeTag} ${item.content}`);
  }

  const guidance = buildAnswerGuidance();
  if (guidance) {
    lines.push("");
    lines.push(guidance);
  }

  lines.push("");
  lines.push("</relevant-memories>");

  return lines.join("\n");
}

/**
 * Format stable system context: Persona + Scene Navigation + Tools Guide.
 */
function formatSystemContext(
  persona: string | null,
  scenes: SceneEntry[],
): string | undefined {
  const parts: string[] = [];

  // Persona (L3)
  if (persona) {
    parts.push("<user-persona>");
    parts.push(persona);
    parts.push("</user-persona>");
  }

  // Scene Navigation (L2 index) — only if not already in persona
  if (scenes.length > 0 && (!persona || !persona.includes("Scene Navigation"))) {
    parts.push("");
    parts.push("## 🗺️ Scene Navigation");
    parts.push("*以下是当前场景记忆索引，可使用 tdai_read_cos 读取详细内容。*");
    parts.push("");
    for (const scene of scenes) {
      parts.push(`- \`${scene.path}\``);
    }
  }

  // Tools guide (always append)
  parts.push("");
  parts.push(MEMORY_TOOLS_GUIDE);

  const result = parts.join("\n").trim();
  return result || undefined;
}

/**
 * Main format function: produce RecallResult for prompt injection.
 */
export function formatRecallResult(
  l1Items: L1Item[],
  persona: string | null,
  scenes: SceneEntry[],
): RecallResult {
  return {
    prependContext: formatL1Memories(l1Items),
    appendSystemContext: formatSystemContext(persona, scenes),
  };
}
