/**
 * B3 输出预算的可复现测量（不是基准测试，只钉住「结构化形态不会比 legacy 更大」）。
 *
 * 测量方法（可照抄复跑）：用同一份典型 L2 文档形态（META + 7 个小节，合计约 4k 中文字符）
 * 分别走 legacy（原样）与结构化（applyStructuredForm + maxBlockBytes=4096），
 * 比较 UTF-8 字节数；再比较 legacy/structured 两种 prompt 的字符数。
 * 字节数除以 ~3 近似中文 token 数（未经真模型验证，仅作相对量级）。
 * 复跑：npx vitest run src/core/scene/__tests__/l2-structured-output-budget.test.ts
 */
import { describe, expect, it } from "vitest";
import { applyStructuredForm, parseStructuredBlock, structuredByteLength } from "../scene-structured.js";
import { buildSceneExtractionPrompt } from "../../prompts/scene-extraction.js";

const MAX_BLOCK_BYTES = 4096;
const SECTION_TITLES = ["用户基础信息", "用户核心特征", "用户偏好", "隐性信号", "核心叙事", "演变轨迹", "待确认矛盾点"];

function sentence(seed: string): string {
  return (
    seed +
    "：用户在本机受限网络环境里运维 A/B/C 三条线，习惯先立票只读取证再动手，" +
    "要求保留失败原因与回滚步骤，不接受未经验证的结论。"
  );
}

function buildLegacyRaw(): string {
  const body = SECTION_TITLES.map(
    (title) => "## " + title + "\n" + sentence(title) + sentence(title) + sentence(title),
  ).join("\n\n");
  return [
    "-----META-START-----",
    "created: 2026-10-01T00:00:00.000Z",
    "updated: 2026-11-01T00:00:00.000Z",
    "summary: 用户在受限网络环境中并行推进三条记忆系统线，偏好先取证再动手。",
    "heat: 7",
    "-----META-END-----",
    "",
    body,
  ].join("\n");
}

describe("B3 · 输出预算测量（字符近似，未经真模型验证）", () => {
  it("legacy 文档超上限时，结构化产物 ≤ maxBlockBytes（整篇形态只小幅缩小）", () => {
    const legacyRaw = buildLegacyRaw();
    const legacyBytes = structuredByteLength(legacyRaw);
    const upgraded = applyStructuredForm({
      raw: legacyRaw,
      previousRaw: null,
      maxBlockBytes: MAX_BLOCK_BYTES,
    });
    const structuredBytes = structuredByteLength(upgraded);

    const ratio = structuredBytes / legacyBytes;
    // eslint-disable-next-line no-console
    console.log(
      "[B3-measure] legacy=" +
        legacyBytes +
        "B structured=" +
        structuredBytes +
        "B ratio=" +
        (ratio * 100).toFixed(1) +
        "% (maxBlockBytes=" +
        MAX_BLOCK_BYTES +
        ")",
    );

    expect(structuredBytes).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    // 整篇形态本身不承诺大幅瘦身（内容没变，只是多了段结构）；降幅来自「第二轮起不再整篇重写」，见下一条用例
    expect(ratio).toBeLessThanOrEqual(1);
    // META 四字段保留 ⇒ 14 行索引与 scene 召回读得回
    const parsed = parseStructuredBlock(upgraded);
    expect(parsed.meta.summary.length).toBeGreaterThan(0);
    expect(parsed.meta.heat).toBe(7);
  });

  it("小文档（已是结构化形态）第二次追加只增长事件行，不重写整篇", () => {
    const first = applyStructuredForm({
      raw: [
        "-----META-START-----",
        "created: 2026-10-01T00:00:00.000Z",
        "updated: 2026-11-01T00:00:00.000Z",
        "summary: 短摘要",
        "heat: 3",
        "-----META-END-----",
        "",
        "## 摘要",
        "短摘要",
        "",
        "## 主张",
        "- [heat:5] 先取证再动手",
        "",
        "## 事件流",
        "- 2026-11-01 完成 A1 门控",
      ].join("\n"),
      previousRaw: null,
      maxBlockBytes: MAX_BLOCK_BYTES,
    });
    const second = applyStructuredForm({
      raw: [
        "-----META-START-----",
        "created: 2026-10-01T00:00:00.000Z",
        "updated: 2026-11-02T00:00:00.000Z",
        "summary: 短摘要",
        "heat: 3",
        "-----META-END-----",
        "",
        "## 摘要",
        "短摘要",
        "",
        "## 主张",
        "- [heat:5] 先取证再动手",
        "",
        "## 事件流",
        "- 2026-11-02 完成 B3 形态",
      ].join("\n"),
      previousRaw: first,
      maxBlockBytes: MAX_BLOCK_BYTES,
    });
    const parsed = parseStructuredBlock(second);
    const growth = structuredByteLength(second) - structuredByteLength(first);
    // eslint-disable-next-line no-console
    console.log(
      "[B3-measure] append growth=" +
        growth +
        "B (first=" +
        structuredByteLength(first) +
        "B second=" +
        structuredByteLength(second) +
        "B events=" +
        parsed.events.length +
        ")",
    );
    expect(parsed.events).toContain("2026-11-01 完成 A1 门控");
    expect(parsed.events).toContain("2026-11-02 完成 B3 形态");
    expect(growth).toBeLessThan(structuredByteLength(first) / 4);

    // 稳态对比：今天第二轮起是「整篇重写」，结构化是「只追加事件行」
    const legacyRewriteBytes = structuredByteLength(buildLegacyRaw());
    const docsPerRun = 14;
    const runsPerDay = 99;
    const legacyDaily = legacyRewriteBytes * docsPerRun * runsPerDay;
    const structuredDaily = growth * docsPerRun * runsPerDay;
    // eslint-disable-next-line no-console
    console.log(
      "[B3-measure] 稳态估算（14 篇/轮 × 99 轮/天，假设每轮触达全部文档）：legacy=" +
        legacyDaily +
        "B structured=" +
        structuredDaily +
        "B 降幅=" +
        ((1 - structuredDaily / legacyDaily) * 100).toFixed(1) +
        "%（每篇 append=" +
        growth +
        "B）",
    );
    expect(structuredDaily).toBeLessThan(legacyDaily * 0.5);
  });

  it("prompt 侧：structured 只追加格式要求，legacy 逐位不变", () => {
    const base = {
      memoriesJson: "[]",
      sceneSummaries: "当前场景总数：0 / 15\n\n（暂无场景文件）",
      currentTimestamp: "2026-11-02T00:00:00.000Z",
      maxScenes: 15,
    };
    const legacy = buildSceneExtractionPrompt(base);
    const disabled = buildSceneExtractionPrompt({
      ...base,
      structuredForm: { enabled: false, maxBlockBytes: MAX_BLOCK_BYTES },
    });
    const structured = buildSceneExtractionPrompt({
      ...base,
      structuredForm: { enabled: true, maxBlockBytes: MAX_BLOCK_BYTES },
    });
    const delta = Array.from(structured.userPrompt).length - Array.from(legacy.userPrompt).length;
    // eslint-disable-next-line no-console
    console.log("[B3-measure] prompt delta chars=" + delta);

    expect(disabled).toEqual(legacy);
    expect(structured.systemPrompt).toBe(legacy.systemPrompt);
    expect(structured.userPrompt.startsWith(legacy.userPrompt)).toBe(true);
    expect(delta).toBeGreaterThan(0);
    // 追加的格式要求本身很小（远小于一张场景块的预算）
    expect(delta).toBeLessThan(MAX_BLOCK_BYTES / 2);
  });
});
