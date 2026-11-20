#!/usr/bin/env node
/**
 * 身份自愈验收（只读，单条命令，不依赖任何会话上下文）。
 *
 *   node dsh-plugin/scripts/check-identity-heal.mjs
 *   node dsh-plugin/scripts/check-identity-heal.mjs --expect-recovered 1
 *
 * 读的是插件持久化的 session-identity.json，按 source 与 lastHealProbe 聚合：
 *   - recovered           本轮自愈成功条数（期望 >= --expect-recovered，默认只报告）
 *   - candidates are ambiguous  歧义：兜底（R33-11）应当把它吃掉，长期存在即为异常
 *   - transport failure:*  传输层：应当为 0（R33-8/9 修复后）
 *
 * 退出码 0 = 达到期望；1 = 未达到（期望为 0 时恒 0）。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : fallback;
};
const statePath = argOf('state', 'C:/Users/Administrator/.dsh/agemem/session-identity.json');
const expectRecovered = Number(argOf('expect-recovered', '0'));

const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
const rows = Object.entries(parsed.sessions ?? parsed);
const bySource = {};
const probes = {};
const recovered = [];
const triples = new Map();
for (const [sessionId, v] of rows) {
  const source = v.source ?? 'none';
  bySource[source] = (bySource[source] ?? 0) + 1;
  if (typeof v.lastHealProbe === 'string' && v.lastHealProbe !== '') {
    probes[v.lastHealProbe] = (probes[v.lastHealProbe] ?? 0) + 1;
  }
  if (source === 'recovered') {
    recovered.push({ sessionId: sessionId.slice(0, 12), teamId: v.teamId, agentId: v.agentId, at: v.at });
  }
  if (typeof v.teamId === 'string' && v.teamId !== '' && (source === 'picked' || source === 'recovered')) {
    const key = v.teamId + '|' + v.userId + '|' + v.agentId;
    triples.set(key, (triples.get(key) ?? 0) + 1);
  }
}
const transport = Object.entries(probes)
  .filter(([k]) => k.startsWith('transport failure'))
  .reduce((n, [, c]) => n + c, 0);
const verdict = recovered.length >= expectRecovered ? 'PASS' : 'FAIL';
console.log(JSON.stringify({
  statePath,
  total: rows.length,
  bySource,
  lastHealProbe: probes,
  recoveredCount: recovered.length,
  recovered: recovered.slice(0, 10),
  chosenTriples: [...triples.entries()],
  transportFailures: transport,
  expectRecovered,
  verdict,
}, null, 2));
process.exit(verdict === 'PASS' ? 0 : 1);
