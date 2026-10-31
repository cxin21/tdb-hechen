#!/usr/bin/env node
// Verify that @tdb/agemem-dsh is not merely installed but actually working in the
// profile the user runs. Written for app-managed profiles (e.g. `desktop`), where
// the CLI refuses --dump-config, so the only honest evidence is file-level wiring
// plus what the host actually wrote into its own session archive.
//
// Usage:
//   node scripts/verify-installed.mjs                 # profile: desktop
//   node scripts/verify-installed.mjs --profile web   # another profile
//   node scripts/verify-installed.mjs --hours 24      # widen the session window
//   node scripts/verify-installed.mjs --json          # machine-readable result
//
// Exit code 0 only when every check passes. Checks that cannot pass yet (e.g. no
// session has run since the restart) are reported as PENDING, not PASS.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { hasManaged } from './patch-util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROFILE = argOf('--profile', process.env.DSH_PROFILE || 'desktop');
const HOURS = Number(argOf('--hours', '6'));
const AS_JSON = argv.includes('--json');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const PATCH = join(PROFILE_DIR, 'cordis.patch.yml');
const PKG = '@tdb/agemem-dsh';
const DIST = join(PROFILE_DIR, 'node_modules', PKG, 'dist', 'index.js');

const results = [];
const record = (check, status, detail) => results.push({ check, status, detail });

// ── 1. static wiring ───────────────────────────────────────────────────────────
try {
  const text = readFileSync(PATCH, 'utf8');
  record('patch entry', hasManaged(text) ? 'PASS' : 'FAIL', hasManaged(text) ? 'managed block present in cordis.patch.yml' : 'no managed block — run scripts/deploy.sh');
} catch (err) {
  record('patch entry', 'FAIL', `cannot read ${PATCH}: ${err.message}`);
}

record('dist entry', existsSync(DIST) ? 'PASS' : 'FAIL', existsSync(DIST) ? DIST : `missing ${DIST}`);

try {
  const pkg = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'));
  const dep = (pkg.dependencies || {})[PKG];
  record('package.json dep', dep ? 'PASS' : 'FAIL', dep ? `${PKG}: ${dep}` : `${PKG} not listed`);
} catch (err) {
  record('package.json dep', 'FAIL', `cannot read package.json: ${err.message}`);
}

// ── 2. what the host actually wrote since it loaded the plugin ────────────────
const cutoff = Date.now() - HOURS * 3600 * 1000;
const sessions = [];
const root = join(DSH_HOME, 'sessions');
try {
  for (const bucket of readdirSync(root)) {
    const bucketDir = join(root, bucket);
    let entries = [];
    try { entries = readdirSync(bucketDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const full = join(bucketDir, entry.name, file);
        if (!existsSync(full)) continue;
        const st = statSync(full);
        if (st.mtimeMs >= cutoff) sessions.push({ file: full, mtime: st.mtimeMs, bucket, name: entry.name });
        break;
      }
    }
  }
} catch (err) {
  record('session scan', 'FAIL', `cannot read ${root}: ${err.message}`);
}
sessions.sort((a, b) => b.mtime - a.mtime);


/**
 * Session archives are append-only zstd: EVERY appended event is its own frame,
 * concatenated in one file. zstdDecompressSync decodes only the FIRST frame, so
 * a naive read sees a few hundred bytes and reports "marker not found" for a
 * plugin that is in fact running (this fooled this script once). Walk the frame
 * magic instead and decode each frame separately.
 */
function decodeSessionArchive(file) {
  const buf = readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const frames = [];
  let at = buf.indexOf(MAGIC);
  while (at >= 0) {
    const next = buf.indexOf(MAGIC, at + 4);
    frames.push(buf.subarray(at, next < 0 ? buf.length : next));
    at = next;
  }
  if (frames.length <= 1) return zstdDecompressSync(buf).toString('utf8');
  let text = '';
  for (const frame of frames) {
    try { text += zstdDecompressSync(frame).toString('utf8'); } catch { /* torn tail frame: skip */ }
  }
  return text;
}

const MARKERS = {
  'volatile injection': 'agemem-volatile-',
  'plugin source id': 'plugin:tdb-agemem-dsh',
  'head pack scene index': '- scene_blocks',
};
const hits = Object.fromEntries(Object.keys(MARKERS).map((k) => [k, []]));
let scanned = 0;
for (const session of sessions.slice(0, 8)) {
  let text;
  try {
    text = decodeSessionArchive(session.file);
  } catch (err) {
    record('session read', 'FAIL', `${session.file}: ${err.message}`);
    continue;
  }
  scanned += 1;
  for (const [label, needle] of Object.entries(MARKERS)) {
    if (text.includes(needle)) hits[label].push(session.name);
  }
}

for (const [label, found] of Object.entries(hits)) {
  if (found.length > 0) record(label, 'PASS', `${found.length} session(s), newest ${found[0].slice(0, 8)}`);
  else if (scanned === 0) record(label, 'PENDING', `no session modified in the last ${HOURS}h — restart the host and run one turn, then re-check`);
  else record(label, 'PENDING', `${scanned} recent session(s) scanned, marker not found yet`);
}

// Negative markers: a plugin that loads but never injects/registers looks
// healthy from the file side, so the failure has to be read out of the log text
// the host kept in the session archive. Seen in the wild: an optional tool
// parameter declaring `required: false` made the host drop memory_recall with
// UNSUPPORTED_SCHEMA while every other check passed.
const BAD_MARKERS = {
  'tool registration': 'memory_recall registration failed',
  'schema rejected': 'UNSUPPORTED_SCHEMA',
  'volatile recall fell back': 'recall failed',
};
let badHits = 0;
for (const [label, needle] of Object.entries(BAD_MARKERS)) {
  const where = sessions.slice(0, 8).filter((session) => {
    try {
      return decodeSessionArchive(session.file).includes(needle);
    } catch { return false; }
  });
  if (where.length === 0) record(label, scanned === 0 ? 'PENDING' : 'PASS', scanned === 0 ? 'no recent session to inspect yet' : 'no rejection in the last ' + HOURS + 'h');
  else { badHits += 1; record(label, 'FAIL', where.length + ' session(s) contain "' + needle + '" (newest ' + where[0].name.slice(0, 8) + ')'); }
}

// ── 3. dead letters ──────────────────────────────────────────────────────────
const dead = join(DSH_HOME, 'agemem', 'outbox.dead.jsonl');
if (existsSync(dead)) {
  const lines = readFileSync(dead, 'utf8').split('\n').filter(Boolean);
  const recent = lines.filter((line) => {
    try { const at = JSON.parse(line).at || JSON.parse(line).ts; return at ? Date.parse(at) >= cutoff : false; } catch { return false; }
  });
  record('dead letters', recent.length === 0 ? 'PASS' : 'FAIL', recent.length === 0 ? `${lines.length} historic line(s), none in the last ${HOURS}h` : `${recent.length} new dead letter(s): ${recent[0].slice(0, 200)}`);
} else {
  record('dead letters', 'PASS', 'no outbox.dead.jsonl — nothing was rejected');
}

// ── report ──────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ profile: PROFILE, results }, null, 2));
} else {
  console.log(`profile: ${PROFILE}   window: last ${HOURS}h   sessions scanned: ${scanned}`);
  for (const r of results) console.log(`  [${r.status.padEnd(7)}] ${r.check.padEnd(24)} ${r.detail}`);
  const bad = results.filter((r) => r.status === 'FAIL').length;
  const pending = results.filter((r) => r.status === 'PENDING').length;
  console.log(bad === 0 ? `\nOK${pending ? ` (${pending} pending — run a turn, then re-check)` : ''}` : `\n${bad} FAILED`);
}
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
