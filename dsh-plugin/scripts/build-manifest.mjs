#!/usr/bin/env node
// Content manifest of the files that actually ship in the tarball.
//
// deploy.sh used to compare a SINGLE file (`dist/index.js`) between the repo and
// the installed profile package. That shipped a stale build on 2026-11-01 14:07:
// only `src/config-schema.ts` and `client/client.js` had changed, `dist/index.js`
// was byte-identical, the check said "fresh", pnpm kept the previous tarball in
// node_modules, and the profile went on running the old schema (with the identity
// triple still in the settings form) while the repo looked correct.
//
// So hash the whole shipped set instead: every `files[]` entry from package.json,
// expanded to files, sorted by relative path, one line `<path>\0<sha256>` each,
// then sha256 over the joined lines. Same input -> same hash on both sides.
//
// Usage: node scripts/build-manifest.mjs <package-root>
// Prints one line: `hash=<64 hex> files=<n>` and exits 0; exits 2 on bad input.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hash the packed file set of one package directory.
 *
 * @param {string} root package directory (must contain package.json with `files[]`)
 * @returns {{hash: string, count: number, paths: string[]}}
 * @throws {Error} when package.json is unreadable or lists no `files[]`
 */
export function buildManifest(root) {
  const dir = resolve(root);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`build-manifest: cannot read ${join(dir, "package.json")}: ${error.message}`);
  }
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  if (entries.length === 0) {
    throw new Error(`build-manifest: ${join(dir, "package.json")} lists no files[]`);
  }

  const found = [];
  const collect = (abs) => {
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      // A packed entry that is absent on this side must show up as a different
      // hash, not as a crash: the caller is comparing two checkouts.
      return;
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(abs).sort()) collect(join(abs, name));
      return;
    }
    if (stats.isFile()) found.push(abs);
  };
  for (const entry of entries) collect(join(dir, entry));

  const paths = found
    .map((file) => {
      const rel = relative(dir, file).split(sep).join("/");
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      return { rel, line: `${rel}\u0000${digest}` };
    })
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256")
    .update(paths.map((entry) => entry.line).join("\n"))
    .digest("hex");
  return { hash, count: paths.length, paths: paths.map((entry) => entry.rel) };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const { hash, count } = buildManifest(process.argv[2] ?? ".");
    process.stdout.write(`hash=${hash} files=${count}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
