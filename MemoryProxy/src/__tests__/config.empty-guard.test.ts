import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYamlConfig } from "../config.js";

// #93 read-side guard: an EXISTING config file that parses to empty/invalid
// YAML (0-byte, whitespace-only, comments-only) must fail fast instead of
// silently falling back to DEFAULT_CONFIG. Missing file keeps the legacy
// default behavior (regression anchors R4-R6).

const dir = mkdtempSync(join(tmpdir(), "cfg-guard-"));

const wf = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadYamlConfig - #93 empty-config read-side guard", () => {
  it("R1 0-byte file exists -> throws (fail fast)", () => {
    const p = wf("empty.yaml", "");
    expect(() => loadYamlConfig(p)).toThrow(/empty\/invalid YAML/);
  });

  it("R2 whitespace-only file -> throws", () => {
    const p = wf("blank.yaml", "   \n\n\t\n");
    expect(() => loadYamlConfig(p)).toThrow(/empty\/invalid YAML/);
  });

  it("R3 comments-only file -> throws", () => {
    const p = wf("comments.yaml", "# just a comment\n# another\n");
    expect(() => loadYamlConfig(p)).toThrow(/empty\/invalid YAML/);
  });

  it("R4 missing file -> legacy defaults (empty object, no throw)", () => {
    expect(loadYamlConfig(join(dir, "definitely-missing.yaml"))).toEqual({});
  });

  it("R5 valid non-empty yaml -> parsed object", () => {
    const p = wf("ok.yaml", "server:\n  port: 9999\n");
    const parsed = loadYamlConfig(p) as { server?: { port?: number } };
    expect(parsed.server?.port).toBe(9999);
  });

  it("R6 syntax-error yaml -> throws (unchanged)", () => {
    const p = wf("broken.yaml", "server: [unclosed\n");
    expect(() => loadYamlConfig(p)).toThrow();
  });
});
