#!/usr/bin/env node
/**
 * Pick THE identity a profile writes memory for, from a user key.
 *
 * Why a user key: a team/agent/user triple pasted into a patch file pins one
 * person forever ("the memory of whoever deployed it"), and the same patch gets
 * copied between machines. A user key says "this human", and the core answers
 * with the teams and agents that human owns. Per docs/ops/cross-host-deployment
 * §10 the flow is: verify the key -> list teams -> list agents -> pick one ->
 * write ONLY the triple into the managed patch block.
 *
 * The user key itself is never written into the profile: a patch is copied,
 * printed by --dump-config and grepped by everyone. It stays in the host
 * credentials store (`refs.TDAI_USER_KEY`) or the environment.
 *
 * Usage:
 *   node scripts/agemem-identity.mjs [options]
 *
 *   --profile <name>    dsh profile to edit (default: $DSH_PROFILE, else desktop)
 *   --patch <file>      explicit cordis.patch.yml (overrides --profile)
 *   --base-url <url>    core origin (default: config default, 127.0.0.1:8420)
 *   --userkey <key>     user key (default: credentials ref, then $TDAI_USER_KEY)
 *   --team <id>         team id — skips the picker
 *   --agent <id>        agent id — skips the picker
 *   --dry-run           print the resulting block, write nothing
 *   --json              machine-readable output
 *
 * Exit codes: 0 written/nothing to do, 1 core or key problem, 2 usage/env
 * problem (missing build, missing profile, ambiguous candidates in a
 * non-interactive shell).
 */

const USAGE = `usage: node scripts/agemem-identity.mjs [--profile <name>] [--patch <file>]
         [--base-url <url>] [--userkey <key>] [--team <id>] [--agent <id>]
         [--dry-run] [--json]`;

const USER_KEY_REF = "TDAI_USER_KEY";

export class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Flags only; anything positional or unknown is a mistake, not a guess. */
export function parseArgs(argv) {
  const out = { json: false, dryRun: false, help: false };
  const takesValue = new Set(["--profile", "--patch", "--base-url", "--userkey", "--team", "--agent"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!takesValue.has(flag)) throw new CliError(`unknown argument: ${arg}\n${USAGE}`);
    const value = equals === -1 ? argv[(index += 1)] : arg.slice(equals + 1);
    if (value === undefined || value === "") throw new CliError(`${flag} needs a value`);
    out[flag.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  }
  return out;
}

/**
 * Decide one candidate from a list, without guessing.
 *
 * One candidate = decided. Explicit flag = decided (exact id, or a unique id
 * prefix so `--agent agt-2m7` works). Several candidates and no flag = the
 * caller shows a list; in a non-interactive shell that is a hard stop, because
 * picking by order would silently write memories into somebody else's agent.
 *
 * @returns {{kind: 'chosen', item: any} | {kind: 'empty'} | {kind: 'not-found'} | {kind: 'needs-input'}}
 */
export function chooseCandidate(candidates, wantedId, idOf) {
  const items = Array.isArray(candidates) ? candidates : [];
  if (items.length === 0) return { kind: "empty" };
  const wanted = typeof wantedId === "string" ? wantedId.trim() : "";
  if (wanted !== "") {
    const exact = items.filter((item) => idOf(item) === wanted);
    if (exact.length === 1) return { kind: "chosen", item: exact[0] };
    const prefixed = items.filter((item) => idOf(item).startsWith(wanted));
    if (prefixed.length === 1) return { kind: "chosen", item: prefixed[0] };
    return { kind: "not-found" };
  }
  if (items.length === 1) return { kind: "chosen", item: items[0] };
  return { kind: "needs-input" };
}

/** Render the candidate list for a human (ids always, names when known). */
export function renderCandidates(candidates, idOf) {
  return (candidates ?? [])
    .map((item, index) => {
      const name = item?.name ? ` (${item.name})` : "";
      return `  ${index + 1}. ${idOf(item)}${name}`;
    })
    .join("\n");
}

/**
 * Rewrite a patch file's managed block with the resolved triple.
 *
 * Kept separate from I/O so it can be asserted directly: it must never touch a
 * profile that has no managed block (that would mean the plugin was never
 * deployed — telling the operator to deploy first is the honest answer), and it
 * must leave every other line byte-identical.
 */
export function updatePatchText(patchText, body, identity, { upsertManaged, setIdentityInBlock }) {
  if (body === undefined) {
    return { ok: false, reason: "no-managed-block" };
  }
  const edited = setIdentityInBlock(body, identity);
  if (edited.missingServer) return { ok: false, reason: "no-server-section" };
  const next = upsertManaged(patchText, edited.body);
  return { ok: true, text: next, changed: edited.changed, inserted: edited.inserted };
}

async function ask(prompt, { stdin, stdout }) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Resolve one level (teams or agents) into a single choice.
 * @returns {Promise<any>} the chosen item
 */
async function resolveLevel({ candidates, flagValue, idOf, label, io, json }) {
  const choice = chooseCandidate(candidates, flagValue, idOf);
  if (choice.kind === "chosen") return choice.item;
  if (choice.kind === "empty") {
    throw new CliError(`this user key resolves to no ${label} — nothing to bind`, 1);
  }
  if (choice.kind === "not-found") {
    throw new CliError(
      `--${label} ${flagValue} is not one of this user's ${label}s:\n` + renderCandidates(candidates, idOf),
      2,
    );
  }
  // needs-input
  if (!io.isTTY) {
    throw new CliError(
      `this user key matches several ${label}s; pass --${label} <id> (non-interactive shell):\n` +
        renderCandidates(candidates, idOf),
      2,
    );
  }
  if (json) {
    // Machine mode cannot prompt: the caller must re-run with --team/--agent.
    throw new CliError(`--json cannot prompt; pass --${label} <id>:\n` + renderCandidates(candidates, idOf), 2);
  }
  io.stdout.write(`this user key matches several ${label}s:\n` + renderCandidates(candidates, idOf) + "\n");
  const answer = (await ask(`choose ${label} [1-${candidates.length}]: `, io)).trim();
  const byIndex = Number.parseInt(answer, 10);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= candidates.length) {
    return candidates[byIndex - 1];
  }
  const byId = candidates.find((item) => idOf(item) === answer);
  if (byId !== undefined) return byId;
  throw new CliError(`could not match "${answer}" to a ${label}`, 2);
}

export function profilePaths({ profile, patch, env, home }) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== "" ? env.DSH_HOME.trim() : home + "/.dsh";
  const resolvedProfile = profile ?? (env.DSH_PROFILE && env.DSH_PROFILE.trim() !== "" ? env.DSH_PROFILE.trim() : "desktop");
  const patchPath = patch ?? `${dshHome}/profiles/${resolvedProfile}/cordis.patch.yml`;
  return { dshHome, profile: resolvedProfile, patchPath, credentialsPath: `${dshHome}/.credentials.yaml` };
}

export async function run(argv, io) {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(USAGE + "\n");
    return 0;
  }

  // The wire contract lives in the built client: re-implementing verify/list
  // here would let the CLI and the plugin drift on headers and paths. io can
  // supply the modules instead, which is how the tests run without a build.
  const loadModules =
    io.loadModules ??
    (async () => {
      const [{ MemoryClient }, { DEFAULT_CONFIG }, patchUtil, credentials] = await Promise.all([
        import("../dist/memory-client.js"),
        import("../dist/config.js"),
        import("./patch-util.mjs"),
        import("./credentials-util.mjs"),
      ]);
      return { MemoryClient, DEFAULT_CONFIG, patchUtil, credentials };
    });
  let MemoryClient;
  let DEFAULT_CONFIG;
  let patchUtil;
  let credentials;
  try {
    ({ MemoryClient, DEFAULT_CONFIG, patchUtil, credentials } = await loadModules());
  } catch (error) {
    throw new CliError(`cannot load the built plugin (run "npm run build" first): ${error.message}`, 2);
  }

  const paths = profilePaths({ profile: args.profile, patch: args.patch, env: io.env, home: io.home });
  const baseUrl = args.baseUrl ?? DEFAULT_CONFIG.server.baseUrl;

  const storeText = await io.readFile(paths.credentialsPath);
  const resolveCoreKey = async () => {
    const value = storeText === undefined ? undefined : credentials.getRef(storeText, DEFAULT_CONFIG.server.apiKeyRef);
    if (value !== undefined) return value;
    return io.env[DEFAULT_CONFIG.server.apiKeyRef] || undefined;
  };
  const userKey = args.userkey ?? (storeText === undefined ? undefined : credentials.getRef(storeText, USER_KEY_REF)) ?? io.env[USER_KEY_REF];
  if (!userKey || userKey.trim() === "") {
    throw new CliError(
      `no user key: pass --userkey, or store one first:\n` +
        `  node scripts/credentials-util.mjs set ${paths.credentialsPath} ${USER_KEY_REF}\n` +
        `  (paste the key on stdin), or export ${USER_KEY_REF}`,
      2,
    );
  }

  const client = new MemoryClient({
    baseUrl,
    apiKeyRef: DEFAULT_CONFIG.server.apiKeyRef,
    identity: { serviceId: DEFAULT_CONFIG.server.serviceId, teamId: "", agentId: "", userId: "" },
    requestTimeoutMs: DEFAULT_CONFIG.server.requestTimeoutMs,
    paths: DEFAULT_CONFIG.paths,
    resolveApiKey: resolveCoreKey,
  });

  const verified = await client.verifyUserKey(userKey, DEFAULT_CONFIG.server.requestTimeoutMs);
  if (!verified.ok) {
    throw new CliError(`the core did not answer the user-key check (${verified.reason ?? "unknown"})`, 1);
  }
  if (verified.valid !== true) {
    throw new CliError("the core rejected this user key", 1);
  }
  const userId = verified.userId;
  if (!userId) throw new CliError("the core verified the key but returned no user_id", 1);

  const teams = await client.listTeams(userId, { userKey, timeoutMs: DEFAULT_CONFIG.server.requestTimeoutMs });
  if (!teams.ok) throw new CliError(`cannot list teams (${teams.reason ?? "unknown"})`, 1);
  const team = await resolveLevel({
    candidates: teams.items,
    flagValue: args.team,
    idOf: (item) => item.teamId,
    label: "team",
    io,
    json: args.json,
  });

  const agents = await client.listAgents(team.teamId, userId, {
    userKey,
    timeoutMs: DEFAULT_CONFIG.server.requestTimeoutMs,
  });
  if (!agents.ok) throw new CliError(`cannot list agents (${agents.reason ?? "unknown"})`, 1);
  const agent = await resolveLevel({
    candidates: agents.items,
    flagValue: args.agent,
    idOf: (item) => item.agentId,
    label: "agent",
    io,
    json: args.json,
  });

  const identity = { teamId: team.teamId, agentId: agent.agentId, userId };
  const patchText = await io.readFile(paths.patchPath);
  if (patchText === undefined) {
    throw new CliError(`no patch file at ${paths.patchPath}: deploy the plugin first (scripts/deploy.sh)`, 2);
  }
  const body = patchUtil.extractManagedBody(patchText);
  const updated = updatePatchText(patchText, body, identity, patchUtil);
  if (!updated.ok) {
    throw new CliError(
      updated.reason === "no-managed-block"
        ? `${paths.patchPath} has no tdb-agemem-dsh managed block: deploy the plugin first (scripts/deploy.sh)`
        : `the managed block has no config.server section; re-run scripts/deploy.sh to rewrite it`,
      2,
    );
  }

  if (!args.dryRun && updated.changed) {
    await io.writeFile(paths.patchPath, updated.text);
  }

  const summary = {
    profile: paths.profile,
    patch: paths.patchPath,
    baseUrl,
    teamId: team.teamId,
    agentId: agent.agentId,
    userId,
    changed: updated.changed,
    dryRun: Boolean(args.dryRun),
    userKeySource: args.userkey ? "flag" : storeText !== undefined && credentials.getRef(storeText, USER_KEY_REF) ? "credentials" : "env",
  };

  if (args.json) {
    io.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    io.stdout.write(
      [
        `profile:  ${summary.profile}`,
        `patch:    ${summary.patch}`,
        `core:     ${summary.baseUrl}`,
        `team:     ${team.teamId}${team.name ? " (" + team.name + ")" : ""}`,
        `agent:    ${agent.agentId}${agent.name ? " (" + agent.name + ")" : ""}`,
        `user:     ${userId}`,
        summary.dryRun
          ? "dry run: nothing written"
          : summary.changed
            ? "patch updated — restart the host for the new identity to take effect"
            : "patch already has this identity — nothing to do",
        `user key: from ${summary.userKeySource}; it is NOT written into the patch. Keep it in ${paths.credentialsPath} (refs.${USER_KEY_REF}) or ${USER_KEY_REF}.`,
      ].join("\n") + "\n",
    );
  }
  return 0;
}

async function main() {
  const fs = await import("node:fs/promises");
  const io = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    home: (await import("node:os")).homedir(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    readFile: async (path) => {
      try {
        return await fs.readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: (path, text) => fs.writeFile(path, text),
  };
  try {
    process.exitCode = await run(process.argv.slice(2), io);
  } catch (error) {
    const code = error instanceof CliError ? error.exitCode : 1;
    process.stderr.write(String(error && error.message ? error.message : error) + "\n");
    // In --json mode keep stdout parseable: failures go to stderr only.
    process.exitCode = code;
  }
}

if (process.argv[1] && process.argv[1].endsWith("agemem-identity.mjs")) {
  main();
}
