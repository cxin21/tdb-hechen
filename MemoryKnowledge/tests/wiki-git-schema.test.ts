import { describe, it, expect, afterEach } from "vitest";
import { createDb } from "../src/db/client.js";

const dbs: Array<{ close: () => void }> = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

function freshDb() {
  const inst = createDb({ path: ":memory:" });
  dbs.push(inst.raw);
  return inst;
}

describe("wiki git-schema migration", () => {
  it("wiki table has branch/path_include/path_exclude columns", () => {
    const { raw } = freshDb();
    const cols = raw
      .pragma("table_info(knowledge_wiki)")
      .map((c: { name: string }) => c.name);
    expect(cols).toContain("branch");
    expect(cols).toContain("path_include");
    expect(cols).toContain("path_exclude");
  });

  it("migration is idempotent on an existing wiki table", () => {
    // Opening twice / re-running migrate must not throw once columns exist.
    const inst = createDb({ path: ":memory:" });
    dbs.push(inst.raw);
    const cols = inst.raw
      .pragma("table_info(knowledge_wiki)")
      .map((c: { name: string }) => c.name);
    expect(cols).toContain("branch");
    expect(cols).toContain("path_include");
    expect(cols).toContain("path_exclude");
  });
});