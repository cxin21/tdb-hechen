import { describe, expect, it } from "vitest";
import { pageWikiGraph } from "../src/routes/wiki.js";
import { parseStructureGraphBody } from "../src/routes/code-graph.js";
import { listGraph, type CodeGraphInstance } from "../src/engines/code/bridge.js";

function wikiNodes(n: number, community = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    label: `L${i}`,
    type: "page",
    path: `p${i}.md`,
    linkCount: 1,
    community,
  }));
}

describe("wiki graph paging", () => {
  it("omits limit and stays full when node count <= 200", () => {
    const nodes = wikiNodes(3);
    const edges = [{ source: "n0", target: "n1", weight: 1 }, { source: "n1", target: "n2", weight: 1 }];
    const page = pageWikiGraph({ nodes, edges, communities: [] }, {});
    expect("error" in page).toBe(false);
    if ("error" in page) return;
    expect(page.nodes).toHaveLength(3);
    expect(page.edges).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);
  });

  it("slices when limit omitted and nodes exceed 200, dropping outside edges", () => {
    const nodes = wikiNodes(201);
    const edges = [
      { source: "n0", target: "n1", weight: 1 },
      { source: "n0", target: "n200", weight: 1 },
    ];
    const page = pageWikiGraph({ nodes, edges, communities: [] }, {});
    if ("error" in page) throw new Error(page.error);
    expect(page.nodes).toHaveLength(80);
    expect(page.total).toBe(201);
    expect(page.truncated).toBe(true);
    expect(page.edges).toEqual([{ source: "n0", target: "n1", weight: 1 }]);
  });

  it("filters by community string before paging", () => {
    const nodes = [
      ...wikiNodes(2, 1),
      { id: "x", label: "X", type: "page", path: "x.md", linkCount: 0, community: 2 },
    ];
    const page = pageWikiGraph(
      { nodes, edges: [{ source: "n0", target: "x", weight: 1 }], communities: [{ id: 1 }] },
      { community: "1" },
    );
    if ("error" in page) throw new Error(page.error);
    expect(page.total).toBe(2);
    expect(page.nodes.map((n) => (n as { id: string }).id)).toEqual(["n0", "n1"]);
    expect(page.edges).toEqual([]);
    expect(page.truncated).toBe(false);
  });
});

describe("code graph structure read", () => {
  it("defaults edge kinds and bounds", () => {
    const parsed = parseStructureGraphBody({ code_graph_id: "cg1" });
    expect(parsed).toEqual({
      kinds: undefined,
      edgeKinds: ["calls", "imports", "contains"],
      limit: 80,
      offset: 0,
    });
  });

  it("pages by kind and drops edges whose target is outside the page", () => {
    const nodes = [
      { id: "f1", kind: "file", name: "a.ts" },
      { id: "c1", kind: "class", name: "A", qualifiedName: "A", filePath: "a.ts", language: "ts", startLine: 1, endLine: 4, signature: "class A", isExported: true },
      { id: "fn1", kind: "function", name: "run" },
      { id: "fn2", kind: "function", name: "other" },
    ];
    const cg = {
      iterateNodesByKind(kind: string) {
        return nodes.filter((n) => n.kind === kind);
      },
      getAllNodes() {
        throw new Error("getAllNodes must not be called");
      },
      getOutgoingEdgesFrom(ids: string[], kinds: string[]) {
        expect(ids).toEqual(["f1", "c1"]);
        expect(kinds).toEqual(["calls"]);
        return [
          { source: "f1", target: "c1", kind: "contains", line: 1 },
          { source: "f1", target: "fn2", kind: "calls", line: 9 },
        ];
      },
    };
    const instance = { cg, handler: {}, projectRoot: "/tmp" } as CodeGraphInstance;
    const page = listGraph(instance, { kinds: ["file", "class"], edgeKinds: ["calls"], limit: 2, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
    expect(page.nodes.map((n) => n.id)).toEqual(["f1", "c1"]);
    expect(page.edges).toEqual([{ source: "f1", target: "c1", kind: "contains", line: 1 }]);
    expect(page.nodes[1]?.qualifiedName).toBe("A");
  });
});
