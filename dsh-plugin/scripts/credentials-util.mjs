#!/usr/bin/env node
/**
 * Minimal editor for the dsh credentials store's `refs:` map
 * (~/.dsh/.credentials.yaml).
 *
 * Why this exists: the core's server key must not live in a profile patch file.
 * A patch entry is copied around, printed by --dump-config and read by anyone
 * who greps a profile; the host already owns a secret store, and the plugin
 * resolves `server.apiKeyRef` through it (`credentials.resolve(ref)`) with
 * `env[ref]` as the fallback. So deploy.sh stores the value here and writes only
 * the ref NAME into the patch — the 64-hex key never appears in a profile again.
 *
 * The edit is line-wise inside the `refs:` block only: `records:` is a nested
 * flow mapping and must stay byte-identical, and so must every other key.
 *
 * CLI (value is read from stdin, never from argv, so it cannot leak into a
 * process list or shell history):
 *   node credentials-util.mjs has    <file> <ref>   # exit 0 when ref has a value
 *   node credentials-util.mjs set    <file> <ref>
 *   node credentials-util.mjs remove <file> <ref>
 */

const REF_LINE = (ref) => new RegExp("^  " + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":[ \\t]*(.*)$");

/** Render a value as a YAML scalar that survives a round trip through this file. */
export function yamlValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_\-./+=:]+$/.test(text) ? text : JSON.stringify(text);
}

function lines(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

function refsRange(all) {
  const start = all.findIndex((line) => /^refs:[ \t]*$/.test(line));
  if (start === -1) return { start: -1, end: -1 };
  let end = all.length;
  for (let index = start + 1; index < all.length; index += 1) {
    const line = all[index];
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** True when `ref` exists in the refs block with a non-empty value. */
export function hasRef(text, ref) {
  const all = lines(text);
  const { start, end } = refsRange(all);
  if (start === -1) return false;
  const matcher = REF_LINE(ref);
  for (let index = start + 1; index < end; index += 1) {
    const match = matcher.exec(all[index]);
    if (!match) continue;
    const value = match[1].trim();
    // `ref: ""` is a valid line but an unusable secret.
    if (value !== "" && value !== '""' && value !== "''") return true;
  }
  return false;
}

/**
 * Read one ref's value, or undefined when it is absent/empty.
 *
 * Used by scripts/agemem-identity.mjs to pick up the user key from the store
 * without ever echoing it: the value goes straight into the memory client, and
 * only its LENGTH is ever printed.
 */
export function getRef(text, ref) {
  const all = lines(text);
  const { start, end } = refsRange(all);
  if (start === -1) return undefined;
  const matcher = REF_LINE(ref);
  for (let index = start + 1; index < end; index += 1) {
    const match = matcher.exec(all[index]);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw === "" || raw === '""' || raw === "''") return undefined;
    // yamlValue() quotes anything that is not a bare scalar, so undo that.
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return String(JSON.parse(raw));
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    return raw;
  }
  return undefined;
}

/** Insert or replace one ref, leaving every other line untouched. */
export function setRef(text, ref, value) {
  const all = lines(text);
  ensureTrailing(all);
  const { start, end } = refsRange(all);
  const rendered = "  " + ref + ": " + yamlValue(value);
  if (start === -1) {
    // No refs block yet: keep the document valid and append one.
    if (all.length === 1 && all[0] === "" ) all.length = 0;
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    all.push("refs:", rendered, "");
    return all.join("\n");
  }
  const matcher = REF_LINE(ref);
  for (let index = start + 1; index < end; index += 1) {
    if (matcher.test(all[index])) {
      all[index] = rendered;
      return all.join("\n");
    }
  }
  // Append inside the block (before the next top-level key, if any).
  all.splice(end === all.length ? end - (all[end - 1] === "" ? 1 : 0) : end, 0, rendered);
  return all.join("\n");
}

/** Drop one ref. @returns {{text: string, removed: boolean}} */
export function removeRef(text, ref) {
  const all = lines(text);
  const { start, end } = refsRange(all);
  if (start === -1) return { text: all.join("\n"), removed: false };
  const matcher = REF_LINE(ref);
  for (let index = start + 1; index < end; index += 1) {
    if (matcher.test(all[index])) {
      all.splice(index, 1);
      return { text: all.join("\n"), removed: true };
    }
  }
  return { text: all.join("\n"), removed: false };
}

/** Never log a secret: show length and the last 4 characters only. */
export function maskValue(value) {
  const text = String(value);
  if (text === "") return "<empty>";
  if (text.length <= 4) return "<" + text.length + " chars>";
  return "<" + text.length + " chars …" + text.slice(-4) + ">";
}

function ensureTrailing(all) {
  if (all.length === 0 || all[all.length - 1] !== "") all.push("");
}

async function main(argv) {
  const [command, file, ref] = argv;
  // No ".bak" next to the store: that would leave a second plaintext copy of
  // every secret in ~/.dsh. deploy.sh backs the file up into .deploy/<stamp>/.
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  if (!command || !file || !ref) {
    console.error("usage: credentials-util.mjs <has|set|remove> <file> <ref>");
    return 2;
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "version: 1\nrefs:\n";
  if (command === "has") return hasRef(text, ref) ? 0 : 1;
  if (command === "set") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (value === "") {
      console.error("refusing to store an empty value");
      return 2;
    }
    const existed = existsSync(file);
    writeFileSync(file, setRef(text, ref, value), "utf8");
    console.log("stored " + ref + " = " + maskValue(value) + " in " + file + (existed ? "" : " (created)"));
    return 0;
  }
  if (command === "remove") {
    const result = removeRef(text, ref);
    if (result.removed) writeFileSync(file, result.text, "utf8");
    console.log(result.removed ? "removed " + ref : ref + " was not present");
    return 0;
  }
  console.error("unknown command: " + command);
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith("credentials-util.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
      process.exitCode = 1;
    },
  );
}
