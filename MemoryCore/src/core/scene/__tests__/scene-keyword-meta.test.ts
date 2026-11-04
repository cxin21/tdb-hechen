/**
 * 缺口 B · 场景块触发词落库形态（META 第五字段）RED 套件。
 *
 * 合同：
 *  - META 增可选 keywords 行（`keywords: k1，k2`）；**缺省不输出** ⇒ 无触发词块逐位等于旧格式；
 *  - parseSceneBlock 还原数组；索引透传 keywords；
 *  - 结构化形态（生产 persona.l2Form.structured=true）与 maxBlockBytes 裁剪都不丢 keywords：
 *    META 完整性优先，裁剪只动主张/事件/摘要；
 *  - prompt guidance 仅在 structuredForm.enabled=true 时要求触发词，legacy 逐位不变。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMeta, formatSceneBlock, parseSceneBlock } from "../scene-format.js";
import { readSceneIndex, syncSceneIndex } from "../scene-index.js";
import {
  buildStructuredFormGuidance,
  compactStructuredBlock,
  parseStructuredBlock,
  renderStructuredBlock,
} from "../scene-structured.js";
import { buildSceneExtractionPrompt } from "../../prompts/scene-extraction.js";

const BASE_META = {
  created: "2026-11-01T00:00:00.000Z",
  updated: "2026-11-02T00:00:00.000Z",
  summary: "摘要",
  heat: 3,
};

describe("B · META keywords 字段", () => {
  it("keywords 往返：format → parse 逐字还原；缺省（无触发词）逐位等于旧格式", () => {
    const withKw = parseSceneBlock(formatSceneBlock({ ...BASE_META, keywords: ["缓存对账", "召回"] }, "正文"), "a.md");
    expect(withKw.meta.keywords).toEqual(["缓存对账", "召回"]);
    expect(withKw.content).toBe("正文");

    const legacy = formatMeta(BASE_META);
    expect(legacy.split("\n")).toHaveLength(6);
    expect(legacy).not.toContain("keywords");
    expect(formatSceneBlock({ ...BASE_META, keywords: [] }, "正文")).toBe(formatSceneBlock(BASE_META, "正文"));
  });

  it("META 字段顺序：keywords 在 heat 之后、META-END 之前（不破坏既有四字段行位）", () => {
    const text = formatMeta({ ...BASE_META, keywords: ["a", "b"] });
    const lines = text.split("\n");
    expect(lines[1]!.startsWith("created:")).toBe(true);
    expect(lines[2]!.startsWith("updated:")).toBe(true);
    expect(lines[3]!.startsWith("summary:")).toBe(true);
    expect(lines[4]!.startsWith("heat:")).toBe(true);
    expect(lines[5]!.startsWith("keywords:")).toBe(true);
    expect(lines[6]).toBe("-----META-END-----");
  });

  it("结构化渲染保留 keywords；maxBlockBytes 极小仍不丢（META 完整性优先）", () => {
    const raw = [
      formatMeta({ ...BASE_META, summary: "很长的摘要".repeat(20), keywords: ["缓存对账", "召回", "阈值"] }),
      "## 摘要",
      "摘要正文".repeat(30),
      "## 主张",
      "- [heat:1] 主张一",
      "## 事件流",
      "- 2026-11-01T00:00:00.000Z | 事件一",
    ].join("\n\n");
    const parsed = parseStructuredBlock(raw);
    expect(parsed.meta.keywords).toEqual(["缓存对账", "召回", "阈值"]);
    const rendered = renderStructuredBlock({
      meta: parsed.meta,
      summary: parsed.summary,
      claims: parsed.claims,
      events: parsed.events,
    });
    expect(parseSceneBlock(rendered, "x.md").meta.keywords).toEqual(["缓存对账", "召回", "阈值"]);

    const compacted = compactStructuredBlock(parsed, 320);
    expect(compacted.text.length).toBeGreaterThan(0);
    const meta = parseSceneBlock(compacted.text, "x.md").meta;
    expect(meta.keywords).toEqual(["缓存对账", "召回", "阈值"]);
    expect(meta.created).toBe(BASE_META.created);
    expect(meta.heat).toBe(3);
  });

  it("索引透传 keywords（syncSceneIndex → readSceneIndex 往返）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-kw-"));
    try {
      mkdirSync(join(dir, "scene_blocks"), { recursive: true });
      writeFileSync(
        join(dir, "scene_blocks", "kv-cache.md"),
        formatSceneBlock({ ...BASE_META, keywords: ["缓存对账", "召回"] }, "## 摘要\n正文"),
        "utf8",
      );
      writeFileSync(join(dir, "scene_blocks", "plain.md"), formatSceneBlock(BASE_META, "## 摘要\n正文2"), "utf8");
      const synced = await syncSceneIndex(dir);
      expect(synced.find((e) => e.filename === "kv-cache.md")?.keywords).toEqual(["缓存对账", "召回"]);
      expect(synced.find((e) => e.filename === "plain.md")?.keywords).toBeUndefined();
      const read = await readSceneIndex(dir);
      expect(read.find((e) => e.filename === "kv-cache.md")?.keywords).toEqual(["缓存对账", "召回"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("B · prompt：触发词要求只在结构化形态出现", () => {
  it("structuredForm.enabled=true 的 guidance 要求 keywords（3-8 个中文原词），legacy 无此字样", () => {
    const guidance = buildStructuredFormGuidance(4096);
    expect(guidance).toContain("keywords:");
    expect(guidance).toContain("3-8");
    const base = {
      memoriesJson: "[]",
      sceneSummaries: "当前场景总数：0 / 15\n\n（暂无场景文件）",
      currentTimestamp: "2026-11-02T00:00:00.000Z",
      maxScenes: 15,
    };
    const legacy = buildSceneExtractionPrompt(base);
    expect(legacy.systemPrompt).not.toContain("keywords:");
    expect(legacy.userPrompt).not.toContain("keywords:");
    const structured = buildSceneExtractionPrompt({ ...base, structuredForm: { enabled: true, maxBlockBytes: 4096 } });
    // 触发词要求属于「结构化形态追加段」⇒ 落在 userPrompt 尾部，systemPrompt 逐位不变
    expect(structured.systemPrompt).toBe(legacy.systemPrompt);
    expect(structured.userPrompt).toContain("keywords:");
    expect(structured.userPrompt.startsWith(legacy.userPrompt)).toBe(true);
  });
});
