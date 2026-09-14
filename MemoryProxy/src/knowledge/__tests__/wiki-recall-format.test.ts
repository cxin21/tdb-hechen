// MemoryProxy/src/knowledge/__tests__/wiki-recall-format.test.ts
import { describe, expect, it } from "vitest";
import { renderWikiRecallBlock } from "../wiki-recall-utils.js";
import type { WikiRecallRenderEntry } from "../wiki-recall-utils.js";

const e = (over: Partial<WikiRecallRenderEntry>): WikiRecallRenderEntry => ({
  wikiName: "Coding-WiKi", type: "concept", title: "暂估应收回冲机制", score: 13.3,
  normScore: 0.62, snippet: "机制说明", path: "wiki/concepts/a.md", hop: 0, ...over,
});

const GUIDANCE_1 = "以下是当前轮用户问题自动召回的团队 wiki 片段（按相关度排序）；每条前的 [wiki:xxx] 标注其来源知识库（如 Coding-WiKi / Standards-WiKi / AgentSkill-WiKi），多 wiki 命中时据此区分来源。";
const GUIDANCE_2 = "仅辅助回答当前这一轮；若需完整正文，请用 <knowledge_tools> 里的 tools/call wiki read_page（path 见下）。";

describe("renderWikiRecallBlock", () => {
  it("returns null for empty entries", () => {
    expect(renderWikiRecallBlock([])).toBeNull();
  });

  it("renders the full block: header, guidance copy, closing tag", () => {
    const text = renderWikiRecallBlock([e({})])!;
    expect(text).toContain("<tdai_recalled_wiki>");
    expect(text.endsWith("</tdai_recalled_wiki>")).toBe(true);
    expect(text).toContain(GUIDANCE_1);
    expect(text).toContain(GUIDANCE_2);
  });

  it("renders wiki: prefix, type, norm score, em-dash title, path, snippet", () => {
    const text = renderWikiRecallBlock([e({})])!;
    expect(text).toContain("[wiki:Coding-WiKi] [concept] score=0.62 — 暂估应收回冲机制");
    expect(text).toContain(" — ");
    expect(text).toContain("path: wiki/concepts/a.md");
    expect(text).toContain("机制说明");
  });

  it("numbers entries 1-based (1. 2. …)", () => {
    const text = renderWikiRecallBlock([e({}), e({})])!;
    const numbers = Array.from(text.matchAll(/(^|\n)(\d+)\.[^\n]*/gm), (m) => m[2]);
    expect(numbers).toEqual(["1", "2"]);
  });

  it("marks hop>0 as [图展开] and leaves the hop=0 sibling unmarked", () => {
    const text = renderWikiRecallBlock([e({ hop: 1 }), e({ hop: 0 })])!;
    // Only the hop>0 entry may carry [图展开].
    expect((text.match(/\[图展开\]/g) ?? []).length).toBe(1);
    expect(text).toContain("score=0.62 [图展开] — ");
    const second = text.split("\n").find((l) => /^2\. /.test(l)) ?? "";
    expect(second).toContain("[wiki:Coding-WiKi]");
    expect(second).not.toContain("[图展开]");
  });
});