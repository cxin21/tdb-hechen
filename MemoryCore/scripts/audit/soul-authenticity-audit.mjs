// T7 首轮基线快照 v2（execFileSync 无 shell，引号免疫）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const snap = { ts: new Date().toISOString(), dim1: {}, dim3: {}, notes: [] };

// --- dim1: /v3/recall 注入块溯源 ---
try {
  const body = JSON.stringify({ query: '灵魂注入快照', topK: 5 });
  const out = execFileSync('curl', ['-sfk', '-m', '20', '-X', 'POST', 'http://127.0.0.1:8420/v3/recall',
    '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + process.env.TDAI_GATEWAY_API_KEY,
    '-H', 'x-tdai-service-id: default', '-H', 'x-tdai-team-id: team-kcjjqzkxks',
    '-H', 'x-tdai-user-id: usr-kfym3ajzme', '-H', 'x-tdai-agent-id: agt-kfynybx0ly', '-d', body], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out);
  const raw = j.data?.raw ?? j.raw ?? '';
  snap.soulVersion = j.data?.soulVersion ?? j.soulVersion ?? null;
  const lines = String(raw).split('\n').filter(l => l.trim());
  fs.writeFileSync('/tmp/t7_snapshot_injection.txt', String(raw));
  snap.dim1.injectionLines = lines.length;
  const labels = lines.map(l => { const m = l.match(/^-\s*\[(.+?)\]/) || l.match(/[·]\s*w\d\.\d+\)?[：:]\s*(.{2,30})/); return m ? (m[1] || m[2] || '').trim() : null; }).filter(Boolean).slice(0, 12);
  snap.dim1.anchorCandidates = labels.length;
  let hit = 0; const miss = [];
  for (const lab of labels) {
    const safe = lab.replace(/[%_'"]/g, '');
    const py = `import sqlite3,json;c=sqlite3.connect('file:/data/tdai-memory/vectors.db?mode=ro',uri=True);print(json.dumps(c.execute("SELECT label FROM core_values WHERE label LIKE ? LIMIT 1", ('%' + ${JSON.stringify(safe)} + '%',)).fetchall()))`;
    const r = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    if (JSON.parse(r).length) hit++; else miss.push(lab);
  }
  snap.dim1.sampled = labels.length; snap.dim1.hits = hit;
  snap.dim1.ratio = labels.length ? +(hit / labels.length).toFixed(3) : null;
  snap.dim1.missSamples = miss.slice(0, 5);
} catch (e) { snap.notes.push('dim1 ERR: ' + String(e).slice(0, 100)); }

// --- dim3: py 文件直跑 ---
try {
  snap.dim3 = JSON.parse(execFileSync('python3', ['/tmp/_t7_dim3.py'], { encoding: 'utf8' }).trim());
} catch (e) { snap.notes.push('dim3 ERR: ' + String(e).slice(0, 100)); }

console.log(JSON.stringify(snap, null, 1));
fs.writeFileSync('/tmp/t7_baseline_snapshot.json', JSON.stringify(snap, null, 1));
