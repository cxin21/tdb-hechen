import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM helper shared with scripts/deploy.sh (no .d.ts on purpose)
import { getRef, hasRef, maskValue, removeRef, setRef, yamlValue } from "../scripts/credentials-util.mjs";

const KEY = "b8475f4b" + "0".repeat(52) + "d760";

const STORE = [
  "version: 1",
  "records:",
  "  {",
  "    client-connection/browser-session:",
  "      {",
  "        kind: browser",
  "        payload: opaque",
  "      }",
  "  }",
  "refs:",
  "  SCM_API_KEY: sk-scp-123",
  "  TDB_API_KEY: short",
  "",
].join(String.fromCharCode(10));

describe("credentials-util", () => {
  it("stores a ref inside the refs block and leaves records untouched", () => {
    const out = setRef(STORE, "TDAI_GATEWAY_APIKEY", KEY);
    expect(hasRef(out, "TDAI_GATEWAY_APIKEY")).toBe(true);
    // The nested flow mapping above must stay byte-identical.
    expect(out.slice(0, out.indexOf("refs:"))).toBe(STORE.slice(0, STORE.indexOf("refs:")));
    expect(out).toContain("  SCM_API_KEY: sk-scp-123");
    expect(out.trimEnd().endsWith("TDAI_GATEWAY_APIKEY: " + KEY)).toBe(true);
  });

  it("replaces an existing value in place instead of appending a second line", () => {
    const once = setRef(STORE, "TDAI_GATEWAY_APIKEY", KEY);
    const twice = setRef(once, "TDAI_GATEWAY_APIKEY", "rotated");
    expect(twice.match(/TDAI_GATEWAY_APIKEY:/g)).toHaveLength(1);
    expect(twice).toContain("TDAI_GATEWAY_APIKEY: rotated");
    expect(twice).not.toContain(KEY);
  });

  it("keeps a following top-level key after the refs block", () => {
    const withTrailer = STORE + "profiles:" + String.fromCharCode(10) + "  desktop: on" + String.fromCharCode(10);
    const out = setRef(withTrailer, "TDAI_GATEWAY_APIKEY", KEY);
    expect(out.indexOf("TDAI_GATEWAY_APIKEY")).toBeLessThan(out.indexOf("profiles:"));
    expect(out).toContain("profiles:" + String.fromCharCode(10) + "  desktop: on");
  });

  it("creates the refs block when the store has none", () => {
    const out = setRef("version: 1" + String.fromCharCode(10) + "records: {}" + String.fromCharCode(10), "X_KEY", "abc");
    expect(hasRef(out, "X_KEY")).toBe(true);
    expect(out).toContain("version: 1");
    expect(out).toContain("records: {}");
  });

  it("refuses to treat an empty value as configured", () => {
    const out = setRef(STORE, "EMPTY_REF", "");
    expect(hasRef(out, "EMPTY_REF")).toBe(false);
  });

  it("quotes a value that would break a plain YAML scalar", () => {
    expect(yamlValue("abc123")).toBe("abc123");
    expect(yamlValue("has space")).toBe('"has space"');
    const out = setRef(STORE, "SPACED", "a b");
    expect(out).toContain('SPACED: "a b"');
    expect(hasRef(out, "SPACED")).toBe(true);
  });

  it("removes exactly one ref", () => {
    const added = setRef(STORE, "TDAI_GATEWAY_APIKEY", KEY);
    const result = removeRef(added, "TDAI_GATEWAY_APIKEY");
    expect(result.removed).toBe(true);
    expect(result.text).not.toContain("TDAI_GATEWAY_APIKEY");
    expect(result.text).toContain("SCM_API_KEY: sk-scp-123");
    expect(removeRef(result.text, "TDAI_GATEWAY_APIKEY").removed).toBe(false);
  });

  it("reads a ref back for the identity CLI, unquoting stored scalars", () => {
    const stored = setRef(STORE, "TDAI_USER_KEY", "user key with spaces");
    expect(getRef(stored, "TDAI_USER_KEY")).toBe("user key with spaces");
    expect(getRef(stored, "SCM_API_KEY")).toBe("sk-scp-123");
    // Absent and empty are the same answer: "not configured".
    expect(getRef(stored, "TDAI_GATEWAY_APIKEY")).toBeUndefined();
    expect(getRef(setRef(STORE, "EMPTY_ONE", "").replace('EMPTY_ONE: ""', 'EMPTY_ONE: ""'), "EMPTY_ONE")).toBeUndefined();
    expect(getRef("", "TDAI_USER_KEY")).toBeUndefined();
  });

  it("masks a secret for logs", () => {
    const masked = maskValue(KEY);
    expect(masked).toContain("64 chars");
    expect(masked).toContain("d760");
    expect(masked).not.toContain("b8475f4b");
    expect(maskValue("")).toBe("<empty>");
  });
});
