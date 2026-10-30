/**
 * #167 人工核对抽样：固定 seed 分层抽 30 条带 attribute 的三元组，附原 turn 文本与同轮其它事实。
 *
 * 用法：
 *   node --import tsx scripts/audit/r167-attribute-sample.mjs --cache .eval-data/bench/facts-cache-v4 \
 *     --dataset ../.eval-data/longmemeval_oracle.json --n 30 --out .eval-data/bench/r167-attribute-sample.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFactAttribute, attributeCardinalityOf } from '../../src/core/record/fact-attribute.ts';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = path.resolve(repo, String(arg('cache', path.join(repo, '.eval-data', 'bench', 'facts-cache-v4'))));
const datasetPath = path.resolve(repo, String(arg('dataset', path.join(repo, '..', '.eval-data', 'longmemeval_oracle.json'))));
const n = Number(arg('n', 30));
const seed = Number(arg('seed', 20261030));
const outPath = path.resolve(repo, String(arg('out', path.join(repo, '.eval-data', 'bench', 'r167-attribute-sample.md'))));

const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const byId = new Map(dataset.map((c) => [c.question_id, c]));
const factsDir = path.join(cacheDir, 'facts');
const files = fs.readdirSync(factsDir).filter((f) => f.endsWith('.json')).sort();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);

const pool = [];
for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(factsDir, f), 'utf8'));
  for (const [turnId, turn] of Object.entries(doc.byTurn ?? {})) {
    const triples = turn.triples ?? [];
    for (const t of triples) {
      const attribute = normalizeFactAttribute(t.attribute);
      if (!attribute) continue;
      pool.push({ caseId: doc.caseId ?? f.replace(/\.json$/, ''), turnId, attribute, triple: t, triples });
    }
  }
}

const byAttr = new Map();
for (const x of pool) {
  const arr = byAttr.get(x.attribute) ?? [];
  arr.push(x);
  byAttr.set(x.attribute, arr);
}
for (const arr of byAttr.values()) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
const picked = [];
const order = [...byAttr.keys()].sort();
for (let round = 0; picked.length < n; round++) {
  let added = false;
  for (const a of order) {
    const arr = byAttr.get(a);
    if (round < arr.length && picked.length < n) {
      picked.push(arr[round]);
      added = true;
    }
  }
  if (!added) break;
}

function turnText(caseId, turnId) {
  const c = byId.get(caseId);
  const m = /-s(\d+)-t(\d+)$/.exec(turnId);
  if (!c || !m) return '(turn text not found)';
  const s = c.haystack_sessions[Number(m[1]) - 1];
  const t = s?.[Number(m[2]) - 1];
  return t ? '[' + t.role + '] ' + t.content : '(turn text not found)';
}

const lines = [];
lines.push('# #167 attribute 人工核对抽样', '');
lines.push('cache: ' + path.relative(repo, cacheDir), 'seed: ' + seed + ' / n: ' + picked.length, '');
picked.forEach((p, i) => {
  lines.push('## ' + (i + 1) + '. ' + p.attribute + '（' + attributeCardinalityOf(p.attribute) + '）— ' + p.caseId + ' / ' + p.turnId, '');
  lines.push('**原 turn 文本**', '');
  lines.push('```text', turnText(p.caseId, p.turnId), '```', '');
  lines.push('**该轮全部事实**', '');
  for (const t of p.triples) {
    const a = normalizeFactAttribute(t.attribute);
    const mark = t === p.triple ? ' ←' : '';
    lines.push('- subject=' + t.subject + ' | predicate=' + t.predicate + ' | value=' + t.value + ' | attribute=' + (a ?? '(none)') + ' | cardinality=' + (t.cardinality ?? '(none)') + mark);
  }
  lines.push('');
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log('pool=' + pool.length + ' picked=' + picked.length + ' attributes=' + byAttr.size + ' -> ' + path.relative(repo, outPath));
console.log('attributes: ' + [...byAttr.entries()].map(([a, arr]) => a + ':' + arr.length).join(' '));
