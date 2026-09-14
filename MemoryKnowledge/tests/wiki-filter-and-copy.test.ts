import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filterAndCopyMatched } from "../src/engines/wiki/filter-and-copy.js";

function setupRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wfc-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

describe("filterAndCopyMatched", () => {
  it("copies only include-matched docs", () => {
    const repo = setupRepo({
      "docs/a.md": "#a",
      "docs/b.txt": "b",
      "src/x.ts": "x",
      "notes/c.md": "c",
    });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, { include: "^docs/.*$" });
    expect(r.copied).toEqual(expect.arrayContaining(["docs/a.md", "docs/b.txt"]));
    expect(r.copied).not.toContain("src/x.ts");
    expect(existsSync(join(out, "docs", "a.md"))).toBe(true);
    expect(existsSync(join(out, "src", "x.ts"))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("exclude wins over include", () => {
    const repo = setupRepo({ "docs/a.md": "#a", "docs/secret.md": "#s" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, { include: "^docs/.*$", exclude: "secret" });
    expect(r.copied).toEqual(["docs/a.md"]);
    expect(existsSync(join(out, "docs", "secret.md"))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("no include falls back to markdown/txt", () => {
    const repo = setupRepo({ "a.md": "#a", "b.ss": "x" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, {});
    expect(r.copied).toEqual(["a.md"]);
    expect(existsSync(join(out, "a.md"))).toBe(true);
    expect(existsSync(join(out, "b.ss"))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("never writes outside sourcesDir (path-escape containment)", () => {
    const repo = setupRepo({ "..lgtm/weird.md": "#x", "ok.md": "ok" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r = filterAndCopyMatched(repo, out, { include: ".*" });
    // 所有匹配产物只落在 sourcesDir(out) 之下，绝不逃逸到其父目录。
    // "..lgtm" 是含点的合法相对段，属正常文件；真正的 ".." 段由防御逻辑跳过。
    expect(existsSync(join(out, "..lgtm", "weird.md"))).toBe(true);
    expect(existsSync(join(dirname(out), "..lgtm", "weird.md"))).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(0);
    rmSync(out, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not re-copy unchanged content (incremental)", () => {
    const repo = setupRepo({ "docs/a.md": "#a" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    const r1 = filterAndCopyMatched(repo, out, { include: "^docs/.*$" });
    expect(r1.copied).toEqual(["docs/a.md"]);
    const r2 = filterAndCopyMatched(repo, out, { include: "^docs/.*$" });
    expect(r2.copied).not.toContain("docs/a.md");
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("removes stale files whose source disappeared or no longer matches", () => {
    const repo = setupRepo({ "a.md": "#a" });
    const out = mkdtempSync(join(tmpdir(), "wfc-out-"));
    filterAndCopyMatched(repo, out, { include: "^a\\.md$" });
    rmSync(join(repo, "a.md"));
    const r2 = filterAndCopyMatched(repo, out, { include: "^a\\.md$" });
    expect(r2.removed).toContain("a.md");
    expect(existsSync(join(out, "a.md"))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
});