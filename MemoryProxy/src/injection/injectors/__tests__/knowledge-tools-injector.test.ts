/**
 * Task 5 (P1-recall-quality M2 #4) — knowledge-tools-injector advertises wiki_fetch.
 *
 * The <knowledge_tools> block must tell the agent how to fetch a wiki page
 * body on demand: wiki_fetch with doc_path (or exact-title fallback) and an
 * optional section; single call capped at ≤4000 chars with a [truncated] marker.
 */

import { describe, it, expect } from "vitest";
import { renderKnowledgeToolsBlock } from "../knowledge-tools-injector.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";

function wikiItem(): KnowledgeItem {
  return {
    knowledge_id: "wiki-12345678",
    type: "wiki",
    service_url: "http://127.0.0.1:8421/v3",
    name: "设计知识库",
    summary: "记忆系统设计文档",
    team_id: "team",
    user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("renderKnowledgeToolsBlock — wiki_fetch tool description", () => {
  it("renders null without resources", () => {
    expect(renderKnowledgeToolsBlock([], "svc")).toBeNull();
  });

  it("keeps the wiki resource tag and the two-step discovery flow", () => {
    const block = renderKnowledgeToolsBlock([wikiItem()], "svc")!;
    expect(block).toContain('<knowledge type="wiki" id="wiki-12345678"');
    expect(block).toContain("tools/list");
    expect(block).toContain("tools/call");
  });

  it("advertises wiki_fetch with doc_path/title/section usage and the truncation marker", () => {
    const block = renderKnowledgeToolsBlock([wikiItem()], "svc")!;
    expect(block).toContain("wiki_fetch");
    expect(block).toContain("doc_path");
    expect(block).toContain("section");
    expect(block).toContain("[truncated");
  });
});
