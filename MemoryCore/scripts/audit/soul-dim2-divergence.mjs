// T7 dim2：换用户/换 agent 双测试分化率（方案 §二.2，docs/superpowers/plans/2026-09-26-task7-soul-authenticity-plan.md）
// 判定：同 user 跨 agent 两桶灵魂段差异 ≥1 条；跨 team 跨 user 桶 self_identity 段零重叠。
// 纯只读：3 次 POST /v3/recall（注入面探针，无写入）；key 从进程 env 或 /proc/<MainPID>/environ 取。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const snap = { ts: new Date().toISOString(), dim2: {}, notes: [] };

function coreKey() {
  if (process.env.TDAI_GATEWAY_API_KEY) return process.env.TDAI_GATEWAY_API_KEY;
  const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'tdai-core'], { encoding: 'utf8' }).trim();
  const env = execFileSync('cat', ['/proc/' + pid + '/environ'], { encoding: 'utf8' });
  const row = env.split('\0').find((x) => x.startsWith('TDAI_GATEWAY_API_KEY='));
  return row ? row.slice('TDAI_GATEWAY_API_KEY='.length) : '';
}

async function recall(key, teamId, userId, agentId) {
  const out = execFileSync('curl', ['-sfSk', '-m', '20', '-X', 'POST', 'http://127.0.0.1:8420/v3/recall',
    '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + key,
    '-H', 'x-tdai-service-id: default',
    '-H', 'x-tdai-team-id: ' + teamId, '-H', 'x-tdai-user-id: ' + userId, '-H', 'x-tdai-agent-id: ' + agentId,
    '-d', JSON.stringify({ query: '灵魂注入分化双测试快照', topK: 5 })], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out);
  return String(j.data?.block ?? j.data?.raw ?? '');
}

// 灵魂段行规范化集合：去空行/去段标题装饰行/统一空白，保留身份/价值锚/品格/感受内容行
function soulLines(block) {
  return String(block).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[#=\-*—─|]+$/.test(l))
    .map((l) => l.replace(/\s+/g, ' '));
}

try {
  const key = coreKey();
  if (!key) throw new Error('no TDAI_GATEWAY_API_KEY (root needed)');
  // A/B = agent 维（同 user usr-kfym3ajzme）；A/C = user 维（跨 team 跨 user）
  const A = await recall(key, 'team-kcjjqzkxks', 'usr-kfym3ajzme', 'agt-kfynybx0ly');
  const B = await recall(key, 'team-kcjjqzkxks', 'usr-kfym3ajzme', 'agt-l5ugn6urg4');
  const C = await recall(key, 'team-2j92u63hre', 'usr-2t8126nehp', 'agt-2t81sh9zdz');
  const [a, b, c] = [A, B, C].map(soulLines);
  const setA = new Set(a), setB = new Set(b), setC = new Set(c);
  const onlyA = a.filter((l) => !setB.has(l));
  const onlyB = b.filter((l) => !setA.has(l));
  const overlapAC = a.filter((l) => setC.has(l));

  // self_identity 段抽取：身份段标记行到下一空行的内容（宽口径：含「我是/我在/我是谁」首行段）
  const idSeg = (blk) => {
    const lines = String(blk).split('\n');
    const out = []; let inSeg = false;
    for (const l of lines) {
      if (/身份|我是谁|self_identity/i.test(l) && l.length < 30) { inSeg = true; continue; }
      if (inSeg) { if (!l.trim()) break; out.push(l.trim()); }
    }
    return out;
  };
  const idOverlapAC = idSeg(A).filter((l) => idSeg(C).includes(l));

  snap.dim2 = {
    buckets: {
      A: { team: 'team-kcjjqzkxks', user: 'usr-kfym3ajzme', agent: 'agt-kfynybx0ly', lines: a.length },
      B: { team: 'team-kcjjqzkxks', user: 'usr-kfym3ajzme', agent: 'agt-l5ugn6urg4', lines: b.length },
      C: { team: 'team-2j92u63hre', user: 'usr-2t8126nehp', agent: 'agt-2t81sh9zdz', lines: c.length },
    },
    agentDivergence: { onlyA: onlyA.length, onlyB: onlyB.length, identical: a.length === b.length && onlyA.length === 0, samplesOnlyA: onlyA.slice(0, 3), samplesOnlyB: onlyB.slice(0, 3) },
    userDivergence: { overlapLinesAC: overlapAC.length, idSegOverlapAC: idOverlapAC.length, selfIdentityIsolated: idOverlapAC.length === 0 },
    pass: onlyA.length + onlyB.length >= 1 && idOverlapAC.length === 0,
  };
  fs.writeFileSync('/tmp/t7_dim2_blockA.txt', A);
  fs.writeFileSync('/tmp/t7_dim2_blockB.txt', B);
  fs.writeFileSync('/tmp/t7_dim2_blockC.txt', C);
} catch (e) {
  const err = e;
  snap.notes.push('dim2 ERR: ' + String(err.message || err).slice(0, 160) + (err.stderr ? ' stderr=' + String(err.stderr).slice(0, 120) : ''));
}
console.log(JSON.stringify(snap, null, 1));
fs.writeFileSync('/tmp/t7_dim2_snapshot.json', JSON.stringify(snap, null, 1));
