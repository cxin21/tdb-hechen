import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM helper shared with scripts/deploy.sh (no .d.ts on purpose)
import {
  BEGIN,
  END,
  extractManagedBody,
  hasArrayContent,
  hasManaged,
  managedBlock,
  restoreArraySeed,
  setIdentityInBlock,
  stripManaged,
  upsertManaged,
} from "../scripts/patch-util.mjs";

const BODY = [
  "- insert:",
  "    - id: tdb-agemem-dsh",
  "      name: ./node_modules/@tdb/agemem-dsh/dist/index.js",
].join("\n");

describe("patch-util", () => {
  it("wraps the entry in an identifiable region", () => {
    const out = managedBlock(BODY);
    expect(out.startsWith(BEGIN)).toBe(true);
    expect(out.trimEnd().endsWith(END)).toBe(true);
    expect(out).toContain("- id: tdb-agemem-dsh");
  });

  it("appends to a file whose other entries are preserved", () => {
    const before = ["- id: agent-default-model", "  config:", "    provider: scm"].join("\n") + "\n";
    const out = upsertManaged(before, BODY);
    expect(out).toContain("- id: agent-default-model");
    expect(out).toContain(BEGIN);
    expect(hasManaged(out)).toBe(true);
  });

  it("upgrades in place instead of appending a second copy", () => {
    const once = upsertManaged("- id: other\n", BODY);
    const twice = upsertManaged(once, BODY.replace("dist/index.js", "dist/index2.js"));
    expect(twice.match(/- id: tdb-agemem-dsh/g)).toHaveLength(1);
    expect(twice).toContain("dist/index2.js");
    expect(twice).not.toContain("dist/index.js");
    // Everything outside the region survives, exactly once.
    expect(twice.match(/- id: other/g)).toHaveLength(1);
    expect(twice.split(BEGIN)).toHaveLength(2);
  });

  it("re-deploy keeps the managed region in place so later patch rows still win", () => {
    // The loader replaces an entry's config wholesale and later rows win, so a
    // re-deploy that appends the region at EOF shadows every Settings-page
    // override written after it. The region must stay where it is.
    const deployed = upsertManaged("# header\n- id: other\n", BODY);
    const withOverride = deployed + "- id: tdb-agemem-dsh\n  config:\n    debug: true\n";
    const redeployed = upsertManaged(withOverride, BODY.replace("dist/index.js", "dist/index2.js"));
    expect(redeployed.indexOf(BEGIN)).toBeLessThan(redeployed.indexOf("debug: true"));
    expect(redeployed).toContain("dist/index2.js");
  });

  it("preserves edits made after a deploy when stripping", () => {
    const deployed = upsertManaged("- id: other\n", BODY) + "- id: added-later\n  disabled: true\n";
    const { text, removed } = stripManaged(deployed);
    expect(removed).toBe(true);
    expect(text).toContain("- id: other");
    expect(text).toContain("- id: added-later");
    expect(text).not.toContain("tdb-agemem-dsh");
    expect(text).not.toContain(BEGIN);
  });

  it("strips a legacy trailing block (pre-region deploys)", () => {
    const legacy = [
      "- id: other",
      "",
      "# tdb-agemem-dsh (added 2026-10-31T21:00:00+08:00); remove with dsh-plugin/scripts/rollback.sh",
      "- insert:",
      "    - id: tdb-agemem-dsh",
      "      name: ./node_modules/@tdb/agemem-dsh/dist/index.js",
      "",
    ].join("\n");
    const { text, removed, legacySkipped } = stripManaged(legacy);
    expect(removed).toBe(true);
    expect(legacySkipped).toBe(false);
    expect(text).toContain("- id: other");
    expect(text).not.toContain("tdb-agemem-dsh");
  });

  it("refuses to guess when a legacy marker is not a single trailing entry", () => {
    const ambiguous = [
      "# tdb-agemem-dsh (added 2026-10-31T21:00:00+08:00)",
      "- id: someone-elses-plugin",
      "  config: {}",
    ].join("\n");
    const res = stripManaged(ambiguous);
    expect(res.legacySkipped).toBe(true);
    expect(res.text).toContain("someone-elses-plugin");
  });

  it("leaves an unterminated region without eating the file", () => {
    const broken = ["- id: other", BEGIN, "- insert:", "    - id: tdb-agemem-dsh"].join("\n");
    const res = stripManaged(broken);
    expect(res.removed).toBe(true);
    expect(res.text).toContain("- id: other");
    expect(res.text).not.toContain("tdb-agemem-dsh");
  });

  it("restores the [] seed when stripping emptied the array", () => {
    // Reproduces the task-31 e2e rollback: deploy.sh drops the "[]" seed line
    // before appending its block, so stripping leaves comments only — and the
    // host refuses to boot ("must be a top-level YAML array of loader patch
    // entries"). The seed has to come back.
    const header = ["# Your patch layer for this dsh profile.", "# a top-level YAML array"].join("\n");
    const deployed = upsertManaged(header, BODY);
    const stripped = restoreArraySeed(stripManaged(deployed).text);
    expect(hasArrayContent(stripped)).toBe(true);
    expect(stripped).toContain("[]");
    expect(stripped).toContain("# Your patch layer for this dsh profile.");
    expect(stripped).not.toContain("tdb-agemem-dsh");
    // Idempotent, and a file that still holds other entries is left alone.
    expect(restoreArraySeed(stripped)).toBe(stripped);
    const withOther = restoreArraySeed("- id: other\n");
    expect(withOther).toBe("- id: other\n");
    expect(withOther).not.toContain("[]");
  });


  describe("identity rewriting (userkey CLI)", () => {
    const FULL_BODY = [
      "- insert:",
      "    - id: tdb-agemem-dsh",
      "      name: ./node_modules/@tdb/agemem-dsh/dist/index.js",
      "      config:",
      "        server:",
      '          baseUrl: "http://127.0.0.1:8420"',
      '          serviceId: "default"',
      '          apiKeyRef: "TDAI_GATEWAY_APIKEY"',
      '          teamId: ""',
      '          agentId: ""',
      '          userId: ""',
      "        writeback:",
      "          skillFeed: false",
    ].join("\n");

    it("returns the managed body byte-for-byte, or undefined when absent", () => {
      const file = upsertManaged("# header\n", FULL_BODY);
      expect(extractManagedBody(file)).toBe(FULL_BODY);
      expect(extractManagedBody("# header\n[]\n")).toBeUndefined();
    });

    it("rewrites only the three identity lines under config.server", () => {
      const res = setIdentityInBlock(FULL_BODY, { teamId: "team-1", agentId: "agt-2", userId: "usr-3" });
      expect(res.changed).toBe(true);
      expect(res.inserted).toEqual([]);
      expect(res.missingServer).toBe(false);
      expect(res.body).toContain('teamId: "team-1"');
      expect(res.body).toContain('agentId: "agt-2"');
      expect(res.body).toContain('userId: "usr-3"');
      // Everything else — including the operator's own knobs — is untouched.
      expect(res.body).toContain('apiKeyRef: "TDAI_GATEWAY_APIKEY"');
      expect(res.body).toContain("skillFeed: false");
      expect(res.body).toContain("- id: tdb-agemem-dsh");
      // Second run is a no-op, so a re-deploy cannot churn the file.
      const again = setIdentityInBlock(res.body, { teamId: "team-1", agentId: "agt-2", userId: "usr-3" });
      expect(again.changed).toBe(false);
      expect(again.body).toBe(res.body);
    });

    it("inserts missing fields inside server instead of appending them elsewhere", () => {
      const body = ["config:", "  server:", '    baseUrl: "http://h"', '    serviceId: "default"'].join("\n");
      const res = setIdentityInBlock(body, { teamId: "t", agentId: "a", userId: "u" });
      expect(res.inserted).toEqual(["teamId", "agentId", "userId"]);
      expect(res.body).toBe(
        ["config:", "  server:", '    teamId: "t"', '    agentId: "a"', '    userId: "u"', '    baseUrl: "http://h"', '    serviceId: "default"'].join("\n"),
      );
    });

    it("quotes values so an id cannot change the YAML shape", () => {
      const res = setIdentityInBlock(FULL_BODY, { teamId: 'a: b # c', agentId: "agt", userId: "usr" });
      expect(res.body).toContain('teamId: "a: b # c"');
      // ...and the rest of the block still parses as YAML lines, not as a comment.
      expect(res.body.split("\n").filter((line) => line.trim() === "skillFeed: false")).toHaveLength(1);
    });

    it("reports a block without a server section instead of guessing", () => {
      const res = setIdentityInBlock("- insert:\n    - id: tdb-agemem-dsh", { teamId: "t" });
      expect(res.missingServer).toBe(true);
      expect(res.changed).toBe(false);
    });
  });

  it("reports absence on an empty or unrelated patch file", () => {
    expect(hasManaged("")).toBe(false);
    expect(hasManaged("[]\n")).toBe(false);
    expect(stripManaged("[]\n").removed).toBe(false);
  });
});
