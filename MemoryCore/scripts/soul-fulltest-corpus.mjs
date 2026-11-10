#!/usr/bin/env node
/**
 * 灵魂层全量测试语料合并与统计门。
 * 缺省 dry-run：只读 .scratch/soul-fulltest/corpus-part-*.json，打印统计，不写库。
 * 统计对不上 docs/specs/2026-11-08-soul-fulltest-plan.md §2 就 exit 1。
 * --write 才把合并结果写到 scripts/fixtures/soul-fulltest-corpus.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PART_DIR = path.join(ROOT, ".scratch", "soul-fulltest");
const OUT = path.join(HERE, "fixtures", "soul-fulltest-corpus.json");
const write = process.argv.includes("--write");

const BLAME = /不对|错了|漏了|没做到/u;
const REPAIR = /补上了|已按|已改|改完/u;
const PROMISE = /我答应过自己/u;
const BROKEN = /没守住/u;
const PUSHBACK = /根因|实测|真机|截图|验证过|我查到|返回正常|上游|缓存|不是我|并非|早就|上一轮|先前/u;

function loadParts() {
  if (!fs.existsSync(PART_DIR)) return [];
  return fs.readdirSync(PART_DIR)
    .filter((n) => /^corpus-part-.*\.json$/.test(n))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(PART_DIR, n), "utf8")));
}

function dayOf(iso, origin) {
  return Math.floor((Date.parse(iso) - origin) / 86400000);
}

const parts = loadParts();
const persons = [];
const seenPerson = new Set();
const sessions = [];
const seenSess = new Set();
for (const p of parts) {
  for (const person of p.persons ?? []) {
    if (person.key && seenPerson.has(person.key)) continue;
    if (person.key) seenPerson.add(person.key);
    persons.push(person);
  }
  for (const s of p.sessions ?? []) {
    if (seenSess.has(s.sessionKey)) {
      console.error("DUP sessionKey " + s.sessionKey);
      process.exit(1);
    }
    seenSess.add(s.sessionKey);
    sessions.push(s);
  }
}
const core = [];
const pads = [];
for (const s of sessions) {
  if (String(s.sessionKey).startsWith("ft-pad-") || String(s.sessionKey).startsWith("ft-fill-")) pads.push(s);
  else core.push(s);
}
pads.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
core.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
const kept = [...core];
let keptTurns = core.reduce((n, s) => n + (s.turns?.length ?? 0), 0);
for (const s of pads) {
  if (kept.length >= 24) break;
  kept.push(s);
  keptTurns += s.turns?.length ?? 0;
}
sessions.length = 0;
for (const s of kept) sessions.push(s);
sessions.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
console.error("trim core=" + core.length + " padsKept=" + (kept.length - core.length) + " padsDropped=" + (pads.length - (kept.length - core.length)));

const origin = Date.parse("2026-08-10T00:00:00.000Z");
const end = Date.parse("2026-11-08T00:00:00.000Z");
let turns = 0;
let blame = 0;
let repair = 0;
let promise = 0;
let broken = 0;
let pushback = 0;
const byScene = {};
const days = new Set();
const silenceHits = [];
for (const s of sessions) {
  byScene[s.scene] = (byScene[s.scene] ?? 0) + 1;
  const n = (s.turns ?? []).length;
  turns += n;
  if (n < 6 || n > 14) console.error("TURN-RANGE " + s.sessionKey + " " + n);
  for (const t of s.turns ?? []) {
    const at = Date.parse(t.at);
    if (!(at >= origin && at <= end + 86400000)) console.error("OUT-OF-SPAN " + s.sessionKey + " " + t.at);
    const d = dayOf(t.at, origin);
    days.add(d);
    if ((d >= 30 && d <= 52) || (d >= 74 && d <= 89)) silenceHits.push(s.sessionKey + "@" + t.at);
    if (t.role === "user" && BLAME.test(t.text)) blame += 1;
    if (t.role === "assistant" && REPAIR.test(t.text)) repair += 1;
    if (t.role === "assistant" && PROMISE.test(t.text)) promise += 1;
    if (BROKEN.test(t.text)) broken += 1;
    if (t.role === "assistant" && PUSHBACK.test(t.text)) pushback += 1;
  }
}

const stats = {
  parts: parts.length,
  persons: persons.length,
  sessions: sessions.length,
  turns,
  scenes: byScene,
  blame,
  repair,
  promise,
  broken,
  pushback,
  activeDays: days.size,
  silenceHits: silenceHits.length,
};
console.log(JSON.stringify(stats, null, 2));

const fail = [];
if (persons.length < 8) fail.push("persons " + persons.length + " < 8");
if (sessions.length < 24) fail.push("sessions " + sessions.length + " < 24");
if (sessions.length !== 24) fail.push("sessions " + sessions.length + " != 24");
if (turns < 144) fail.push("turns " + turns + " < 144");
if (turns > 336) fail.push("turns " + turns + " > 336 (24*14)");
if (silenceHits.length > 0) fail.push("silence window hit " + silenceHits.length);
if (blame < 8) fail.push("blame " + blame + " < 8");
if (repair < 4) fail.push("repair " + repair + " < 4");
if (promise < 4) fail.push("promise " + promise + " < 4");
if (fail.length) {
  console.error("STOP " + fail.join("; "));
  process.exit(1);
}
if (!write) {
  console.log("dry-run ok, not written");
  process.exit(0);
}
const doc = {
  tenant: { teamId: "team-2k12lgb650", userId: "usr-2m7b1144d9", agentId: "agt-guc1yiglgs" },
  span: { from: "2026-08-10T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" },
  persons,
  sessions,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log("wrote " + OUT);
