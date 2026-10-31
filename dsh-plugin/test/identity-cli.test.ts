import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM helper shared with scripts/deploy.sh (no .d.ts on purpose)
import { CliError, chooseCandidate, parseArgs, profilePaths, run, updatePatchText } from "../scripts/agemem-identity.mjs";
// @ts-expect-error — same
import * as patchUtil from "../scripts/patch-util.mjs";

const BODY = [
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
].join(String.fromCharCode(10));

function fakeModules({ teams = [], agents = [], verify = { ok: true, valid: true, userId: "usr-1" } } = {}) {
  return async () => ({
    MemoryClient: class {
      verifyUserKey = vi.fn(async () => verify);
      listTeams = vi.fn(async () => ({ ok: true, items: teams, total: teams.length }));
      listAgents = vi.fn(async () => ({ ok: true, items: agents, total: agents.length }));
    },
    DEFAULT_CONFIG: {
      server: { baseUrl: "http://core.test", serviceId: "default", apiKeyRef: "TDAI_GATEWAY_APIKEY", requestTimeoutMs: 1000 },
      paths: {},
    },
    patchUtil,
    credentials: { getRef: (text: string, ref: string) => {
      const match = new RegExp("^  " + ref + ": (.*)$", "m").exec(text);
      return match ? match[1] : undefined;
    } },
  });
}

describe("identity CLI", () => {
  let dir: string;
  let patchPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agemem-identity-"));
    patchPath = join(dir, "cordis.patch.yml");
    writeFileSync(patchPath, "# patch layer" + String.fromCharCode(10) + patchUtil.managedBlock(BODY));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const io = (overrides: Record<string, unknown> = {}) => {
    const out: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
    const impl = {
      stdout: { write: (chunk: string) => { out.stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { out.stderr += chunk; return true; } },
      env: {},
      home: dir,
      isTTY: false,
      readFile: async (path: string) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      },
      writeFile: async (path: string, text: string) => { writeFileSync(path, text); },
      ...overrides,
    };
    return { impl, out };
  };

  it("parses flags, including --flag=value, and rejects anything else", () => {
    expect(parseArgs(["--profile", "web", "--team=t1", "--dry-run", "--json"])).toMatchObject({
      profile: "web",
      team: "t1",
      dryRun: true,
      json: true,
    });
    expect(parseArgs(["--base-url", "http://h:1"]).baseUrl).toBe("http://h:1");
    expect(() => parseArgs(["--nope"])).toThrow(CliError);
    expect(() => parseArgs(["--team"])).toThrow(CliError);
  });

  it("resolves the profile directory the way the host does", () => {
    const paths = profilePaths({ env: { DSH_HOME: "C:/h", DSH_PROFILE: "web" }, home: "C:/Users/x" });
    expect(paths.patchPath).toBe("C:/h/profiles/web/cordis.patch.yml");
    expect(paths.credentialsPath).toBe("C:/h/.credentials.yaml");
    // --patch wins, and a bare machine falls back to the desktop profile.
    expect(profilePaths({ patch: "/tmp/p.yml", env: {}, home: "C:/Users/x" }).patchPath).toBe("/tmp/p.yml");
    expect(profilePaths({ env: {}, home: "C:/Users/x" }).profile).toBe("desktop");
  });

  it("chooses exactly one candidate and refuses to guess between several", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const idOf = (item: { id: string }) => item.id;
    expect(chooseCandidate([{ id: "a" }], undefined, idOf)).toEqual({ kind: "chosen", item: { id: "a" } });
    expect(chooseCandidate(items, "b", idOf)).toEqual({ kind: "chosen", item: { id: "b" } });
    expect(chooseCandidate(items, "a", idOf).kind).toBe("chosen");
    expect(chooseCandidate(items, undefined, idOf)).toEqual({ kind: "needs-input" });
    expect(chooseCandidate(items, "zzz", idOf)).toEqual({ kind: "not-found" });
    expect(chooseCandidate([], undefined, idOf)).toEqual({ kind: "empty" });
  });

  it("rewrites only the managed block, and refuses a profile without one", () => {
    const patch = "# header" + String.fromCharCode(10) + patchUtil.managedBlock(BODY);
    const ok = updatePatchText(patch, patchUtil.extractManagedBody(patch), { teamId: "t1", agentId: "a1", userId: "u1" }, patchUtil);
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain('teamId: "t1"');
    expect(ok.text).toContain("# header");
    expect(ok.text).toContain("skillFeed: false");
    expect(updatePatchText(patch, undefined, { teamId: "t" }, patchUtil)).toEqual({ ok: false, reason: "no-managed-block" });
  });

  it("writes the resolved triple into the profile and never the user key", async () => {
    const { impl, out } = io({
      loadModules: fakeModules({ teams: [{ teamId: "team-1", name: "Alpha" }], agents: [{ agentId: "agt-1" }] }),
    });
    const code = await run(["--patch", patchPath, "--userkey", "uk-secret"], impl as any);

    expect(code).toBe(0);
    const written = readFileSync(patchPath, "utf8");
    expect(written).toContain('teamId: "team-1"');
    expect(written).toContain('agentId: "agt-1"');
    expect(written).toContain('userId: "usr-1"');
    // The key stays out of the profile — that is the whole point of the store.
    expect(written).not.toContain("uk-secret");
    expect(out.stdout).toContain("patch updated");
    expect(out.stdout).toContain("user key: from flag");
    expect(out.stdout).not.toContain("uk-secret");
  });

  it("--dry-run reports the change without touching the file", async () => {
    const before = readFileSync(patchPath, "utf8");
    const { impl, out } = io({
      loadModules: fakeModules({ teams: [{ teamId: "team-1" }], agents: [{ agentId: "agt-1" }] }),
    });
    await run(["--patch", patchPath, "--userkey", "uk", "--dry-run", "--json"], impl as any);
    expect(readFileSync(patchPath, "utf8")).toBe(before);
    const parsed = JSON.parse(out.stdout);
    expect(parsed).toMatchObject({ dryRun: true, changed: true, teamId: "team-1", agentId: "agt-1", userId: "usr-1" });
  });

  it("stops instead of guessing when the key matches several teams", async () => {
    const before = readFileSync(patchPath, "utf8");
    const { impl } = io({
      loadModules: fakeModules({ teams: [{ teamId: "team-a" }, { teamId: "team-b" }], agents: [{ agentId: "agt-1" }] }),
    });
    await expect(run(["--patch", patchPath, "--userkey", "uk"], impl as any)).rejects.toThrow(/several teams/);
    expect(readFileSync(patchPath, "utf8")).toBe(before);
  });

  it("takes the team and agent from flags when given", async () => {
    const { impl } = io({
      loadModules: fakeModules({ teams: [{ teamId: "team-a" }, { teamId: "team-b" }], agents: [{ agentId: "agt-9" }] }),
    });
    await run(["--patch", patchPath, "--userkey", "uk", "--team", "team-b"], impl as any);
    expect(readFileSync(patchPath, "utf8")).toContain('teamId: "team-b"');
  });

  it("refuses to run without a user key, and says how to store one", async () => {
    const { impl } = io({ loadModules: fakeModules() });
    await expect(run(["--patch", patchPath], impl as any)).rejects.toThrow(/credentials-util.mjs set/);
  });

  it("reads the user key from the credentials store before the environment", async () => {
    const storePath = join(dir, ".credentials.yaml");
    writeFileSync(storePath, "refs:" + String.fromCharCode(10) + "  TDAI_USER_KEY: stored-key" + String.fromCharCode(10));
    const { impl } = io({
      env: { TDAI_USER_KEY: "env-key" },
      loadModules: fakeModules({ teams: [{ teamId: "t" }], agents: [{ agentId: "a" }] }),
    });
    const code = await run(["--patch", patchPath, "--json"], impl as any);
    expect(code).toBe(0);
  });
});
