/**
 * Pure fs helper for wiki git-source: recursively filter a cloned repo dir by
 * relative-POSIX-path regex and incrementally copy the matching files into a
 * sourcesDir (the location the existing ingest reads) — diffing to only copy
 * changed files and prune stale ones.
 *
 * Matching semantics (spec §4):
 *   - target is each file's relative POSIX path (e.g. `docs/xx.md`)
 *   - `exclude` wins first → skip
 *   - if `include` is set and matches → keep; if `include` is unset → language
 *     fallback (default `/\\.(md|txt|markdown)$/i`) decides.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export interface FilterOpts {
  include?: string | null;
  exclude?: string | null;
  languageFallback?: RegExp;
}

export interface FilterResult {
  /** relative paths of files that were newly written or whose content changed this run */
  copied: string[];
  /** relative paths of files removed from sourcesDir because their source disappeared or no longer matches */
  removed: string[];
  /** count of entries skipped (excluded / non-matching / traversal-invalid) */
  skipped: number;
}

const DEFAULT_FALLBACK = /\.(md|txt|markdown)$/i;

/** A relative path that could escape sourcesDir (empty / absolute / contains a ".." segment). */
function isUnsafeRel(rel: string): boolean {
  return !rel || rel.startsWith("/") || rel.split("/").some((seg) => seg === "..");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function filterAndCopyMatched(
  cloneDir: string,
  sourcesDir: string,
  opts: FilterOpts = {},
): FilterResult {
  const includeRe = opts.include ? new RegExp(opts.include) : null;
  const excludeRe = opts.exclude ? new RegExp(opts.exclude) : null;
  const fb = opts.languageFallback ?? DEFAULT_FALLBACK;
  const result: FilterResult = { copied: [], removed: [], skipped: 0 };

  const shouldKeep = (rel: string): boolean => {
    if (excludeRe && excludeRe.test(rel)) return false;
    return includeRe ? includeRe.test(rel) : fb.test(rel);
  };

  // rels that should currently exist under sourcesDir (this run's matching source set)
  const want = new Set<string>();

  const walk = (cur: string): void => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = toPosix(relative(cloneDir, p));
      if (isUnsafeRel(rel)) {
        result.skipped++;
        continue;
      }
      if (!shouldKeep(rel)) {
        result.skipped++;
        continue;
      }
      want.add(rel);
      const dest = join(sourcesDir, rel);
      const payload = readFileSync(p);
      if (existsSync(dest) && readFileSync(dest).equals(payload)) continue; // unchanged
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, payload);
      result.copied.push(rel);
    }
  };
  walk(cloneDir);

  // Incremental prune: remove files in sourcesDir no longer part of the matching set
  // (source deleted upstream, or include/exclude changed so they no longer match).
  const prune = (cur: string): void => {
    if (!existsSync(cur)) return;
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) {
        prune(p);
        continue;
      }
      const rel = toPosix(relative(sourcesDir, p));
      if (isUnsafeRel(rel)) continue;
      if (!want.has(rel)) {
        rmSync(p, { force: true });
        result.removed.push(rel);
      }
    }
  };
  prune(sourcesDir);

  return result;
}