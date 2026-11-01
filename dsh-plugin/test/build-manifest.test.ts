import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM helper shared with scripts/deploy.sh (no .d.ts on purpose)
import { buildManifest } from "../scripts/build-manifest.mjs";

const roots: string[] = [];

function pkg(files: string[] | undefined, contents: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tdb-manifest-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", files }));
  for (const [rel, body] of Object.entries(contents)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("build-manifest", () => {
  it("hashes every file under the packed entries, not just the entry names", () => {
    const root = pkg(["dist", "client"], {
      "dist/index.js": "export const a = 1;\n",
      "dist/nested/deep.js": "export const b = 2;\n",
      "client/client.js": "export const c = 3;\n",
      // not packed: must not move the hash
      "src/index.ts": "export const d = 4;\n",
    });
    const manifest = buildManifest(root);
    expect(manifest.count).toBe(3);
    expect(manifest.paths).toEqual(["client/client.js", "dist/index.js", "dist/nested/deep.js"]);
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across runs and independent of file write order", () => {
    const contents = { "dist/a.js": "a\n", "dist/b.js": "b\n" };
    const first = buildManifest(pkg(["dist"], contents)).hash;
    const reordered: Record<string, string> = {};
    for (const key of Object.keys(contents).reverse()) reordered[key] = contents[key] as string;
    expect(buildManifest(pkg(["dist"], reordered)).hash).toBe(first);
  });

  it("changes when a file OUTSIDE dist changes (the 2026-11-01 stale-install bug)", () => {
    const base = { "dist/index.js": "same\n", "client/client.js": "old\n" };
    const before = buildManifest(pkg(["dist", "client"], base)).hash;
    const after = buildManifest(
      pkg(["dist", "client"], { ...base, "client/client.js": "new\n" }),
    ).hash;
    expect(after).not.toBe(before);

    // and leaving dist/index.js alone is exactly what fooled the old single-file check
    const distOnly = buildManifest(pkg(["dist"], base)).hash;
    expect(buildManifest(pkg(["dist"], { ...base, "client/client.js": "new\n" })).hash).toBe(distOnly);
  });

  it("folds an absent packed entry into the hash instead of throwing", () => {
    const full = buildManifest(pkg(["dist"], { "dist/a.js": "a\n" })).hash;
    const missing = buildManifest(pkg(["dist", "cordis.bundle.yml"], { "dist/a.js": "a\n" }));
    expect(missing.count).toBe(1);
    expect(missing.hash).toBe(full);
  });

  it("refuses a package that declares no files[]", () => {
    expect(() => buildManifest(pkg(undefined, { "dist/a.js": "a\n" }))).toThrow(/no files/);
    expect(() => buildManifest(pkg([], {}))).toThrow(/no files/);
  });
});
