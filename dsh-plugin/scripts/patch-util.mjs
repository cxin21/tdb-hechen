#!/usr/bin/env node
/**
 * Managed-block editor for a dsh profile's patch layer (cordis.patch.yml).
 *
 * deploy.sh appends one insert entry whose config carries the memory identity,
 * the core URL and the core API key. That entry has to be REPLACEABLE, not just
 * appending: re-running deploy on an already-deployed profile must upgrade the
 * config instead of silently doing nothing (the old script exited 0 there), and
 * rollback must remove exactly that entry and nothing else (the old script
 * rewrote the whole file from a backup, which also destroyed edits made after
 * the deploy).
 *
 * So the entry lives inside an explicit managed region:
 *
 *   # >>> tdb-agemem-dsh managed block (scripts/deploy.sh) — do not edit by hand
 *   - insert:
 *       - id: tdb-agemem-dsh
 *         ...
 *   # <<< tdb-agemem-dsh managed block
 *
 * Legit edits outside the region are preserved by construction: the file is
 * rewritten line-wise and only the region's lines are replaced.
 *
 * The first deploys (before the region existed) appended a legacy block marked
 * with `# tdb-agemem-dsh (added <ts>)` at end of file. `stripManaged` removes
 * that too, but refuses (returns skipped=false) when the tail no longer looks
 * like a single trailing insert entry — guessing there could delete somebody
 * else's plugin.
 */

export const BEGIN = "# >>> tdb-agemem-dsh managed block (scripts/deploy.sh) — do not edit by hand";
export const END = "# <<< tdb-agemem-dsh managed block";
const LEGACY_MARKER = /^# tdb-agemem-dsh \(added /;

/** Wrap `body` (a YAML block, no leading blank line) in the managed region. */
export function managedBlock(body) {
  const lines = body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return [BEGIN, ...lines.split("\n"), END].join("\n") + "\n";
}

/**
 * Does the file already contain our entry (managed region or legacy tail)?
 */
export function hasManaged(text) {
  return text.includes(BEGIN) || LEGACY_MARKER.test(text) || /^\s*- id: tdb-agemem-dsh\s*$/m.test(text);
}

/**
 * Remove the managed region, and a legacy trailing block when it can be
 * identified without doubt.
 * @returns {{text: string, removed: boolean, legacySkipped: boolean}}
 */
export function stripManaged(text) {
  const src = text.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out = [];
  let removed = false;
  let inside = false;
  for (const line of lines) {
    if (!inside && line.trim() === BEGIN) {
      inside = true;
      removed = true;
      continue;
    }
    if (inside) {
      if (line.trim() === END) inside = false;
      continue;
    }
    out.push(line);
  }
  if (inside) {
    // Unterminated region: everything after BEGIN was ours anyway.
    return { text: out.join("\n"), removed, legacySkipped: false };
  }
  // Legacy trailing block (pre-region deploys).
  let marker = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (LEGACY_MARKER.test(out[i])) marker = i;
  }
  if (marker === -1) return { text: out.join("\n"), removed, legacySkipped: false };
  const tail = out.slice(marker + 1).filter((line) => line.trim() !== "");
  const entryStarts = tail.findIndex((line) => line === "- insert:" || line.startsWith("- insert:"));
  const otherTopLevel = tail.some(
    (line) => /^- /.test(line) && !(line === "- insert:" || line.startsWith("- insert:")),
  );
  if (entryStarts !== 0 || otherTopLevel) {
    // Not a single trailing entry: leave it alone, the caller must handle it.
    return { text: out.join("\n"), removed, legacySkipped: true };
  }
  return { text: out.slice(0, marker).join("\n"), removed: true, legacySkipped: false };
}

/**
 * Does the file still hold any YAML entry (a non-blank line that is not a
 * comment)? A patch file is a top-level array; comments alone parse to null and
 * the host refuses to boot with "must be a top-level YAML array of loader patch
 * entries".
 */
export function hasArrayContent(text) {
  return text
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/**
 * Restore the `[]` seed when stripping emptied the array.
 *
 * deploy.sh removes the seed line before appending its block (a block-style
 * entry after `[]` is invalid YAML), so a naive strip leaves only the header
 * comments — and the next `--dump-config` dies. Found in the task-31 e2e: the
 * rollback "verification" step was the first thing to notice.
 */
export function restoreArraySeed(text) {
  if (hasArrayContent(text)) return text;
  const body = text.replace(/\s+$/, "");
  return (body === "" ? "" : body + "\n") + "[]\n";
}

/**
 * Replace the managed region *in place*, or append it when the file has none.
 * Keeps everything outside it.
 *
 * In-place matters, not just to avoid churn: a re-deploy used to strip the
 * region and append it at EOF, which moved our `insert:` entry *after* any
 * later patch row. The loader replaces an entry's config wholesale (never deep
 * merges), and later rows win, so re-running deploy silently shadowed every
 * Settings-page override — and the next save then failed dsh-config-editor's
 * guard ("Configuration for … is overridden by a home patch"). Measured on
 * 2026-11-01 in an isolated profile: override row last => override wins;
 * after one re-deploy the managed block sat last => deploy's config won and
 * the user's edit vanished from the composed config.
 */
export function upsertManaged(text, body) {
  const block = managedBlock(body);
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && line.trim() === END);
    if (end !== -1) {
      return [
        ...lines.slice(0, start),
        ...block.replace(/\n$/, "").split("\n"),
        ...lines.slice(end + 1),
      ].join("\n");
    }
  }
  const stripped = stripManaged(text).text;
  const base = stripped.replace(/\s+$/, "");
  const head = base === "" ? "" : base + "\n";
  return head + block;
}

/**
 * Return the YAML body inside the managed region (without the BEGIN/END marker
 * lines), or undefined when the region is absent.
 *
 * The identity CLI edits this body in place instead of re-rendering it: the
 * block also carries the operator's own knobs (writeback.skillFeed,
 * volatile.maxChars, an inline apiKey …) and re-rendering would silently reset
 * them to this script's defaults.
 */
export function extractManagedBody(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.trim() === END);
  return (end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end)).join("\n");
}

const IDENTITY_FIELDS = ["teamId", "agentId", "userId"];

/**
 * Rewrite only teamId / agentId / userId under `config.server:` in a managed
 * body, leaving every other line byte-identical.
 *
 * @returns {{body: string, changed: boolean, inserted: string[], missingServer: boolean}}
 */
export function setIdentityInBlock(body, identity) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const indentOf = (line) => line.length - line.trimStart().length;

  let serverLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "server:") {
      serverLine = i;
      break;
    }
  }
  if (serverLine === -1) {
    return { body: lines.join("\n"), changed: false, inserted: [], missingServer: true };
  }
  const serverIndent = indentOf(lines[serverLine]);

  // Section = lines after `server:` up to the first sibling key (indent <=
  // server indent) that is not blank/comment.
  let end = lines.length;
  for (let i = serverLine + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentOf(lines[i]) <= serverIndent) {
      end = i;
      break;
    }
  }
  const childIndent = (() => {
    for (let i = serverLine + 1; i < end; i += 1) {
      if (lines[i].trim() !== "") return indentOf(lines[i]);
    }
    return serverIndent + 2;
  })();

  const out = lines.slice();
  const inserted = [];
  let changed = false;
  let lastIdentityIndex = serverLine;

  for (const key of IDENTITY_FIELDS) {
    const value = identity?.[key] ?? "";
    let found = -1;
    for (let i = serverLine + 1; i < end; i += 1) {
      if (new RegExp("^" + " ".repeat(childIndent) + key + "\\s*:").test(lines[i])) {
        found = i;
        break;
      }
    }
    // Quote with JSON.stringify: ids are opaque, so a value containing '#' or
    // ':' must not be able to change the YAML shape (or start a comment).
    const rendered = " ".repeat(childIndent) + key + ": " + JSON.stringify(String(value ?? ""));
    if (found === -1) {
      inserted.push(key);
      continue;
    }
    if (out[found] !== rendered) {
      out[found] = rendered;
      changed = true;
    }
    lastIdentityIndex = Math.max(lastIdentityIndex, found);
  }

  // Missing keys go right after the last identity line so the server block
  // stays readable and neighbouring settings keep their order.
  if (inserted.length > 0) {
    const additions = IDENTITY_FIELDS.filter((key) => inserted.includes(key)).map(
      (key) => " ".repeat(childIndent) + key + ": " + JSON.stringify(String(identity?.[key] ?? "")),
    );
    out.splice(lastIdentityIndex + 1, 0, ...additions);
    changed = true;
  }

  return { body: out.join("\n"), changed, inserted, missingServer: false };
}

/** CLI: upsert <patchFile> <blockFile> | strip <patchFile> | has <patchFile> */
async function main(argv) {
  const [cmd, file, bodyFile] = argv;
  const { readFile, writeFile } = await import("node:fs/promises");
  if (cmd === "has") {
    const text = await readFile(file, "utf8").catch(() => "");
    process.stdout.write(hasManaged(text) ? "yes\n" : "no\n");
    return;
  }
  if (cmd === "strip") {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text === "") return;
    const res = stripManaged(text);
    // Keep the file bootable: comments alone are not a YAML array.
    await writeFile(file, res.legacySkipped ? res.text : restoreArraySeed(res.text));
    if (res.legacySkipped) {
      process.stderr.write(
        "warning: a legacy tdb-agemem-dsh block was left in place (tail is not a single entry); remove it by hand\n",
      );
    }
    return;
  }
  if (cmd === "upsert") {
    const text = await readFile(file, "utf8").catch(() => "");
    const body = await readFile(bodyFile, "utf8");
    await writeFile(file, upsertManaged(text, body));
    return;
  }
  process.stderr.write("usage: patch-util.mjs <upsert|strip|has> <patchFile> [blockFile]\n");
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith("patch-util.mjs")) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
}
