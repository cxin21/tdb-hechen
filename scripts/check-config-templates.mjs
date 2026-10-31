#!/usr/bin/env node
// scripts/check-config-templates.mjs
//
// 配置模板 ↔ 源码 双向校验。规格：config/SPEC.md（本脚本是该规格的执行体）。
//
// 断言（FAIL 会让 CI/收尾红）：
//   1. 五份模板文件与五份 keys.json 都存在
//   2. keys.json 结构合法：service/sources/keys[]/ignored[]，每键带 type/default/source/consumed
//   3. 模板 YAML 扁平化后的键集合 === keys.json 的 keys[].path 集合（双向，不含 ignored）
//   4. 每个键的 [src:File:line] 真实命中：该行文本必须包含键名末段
//   5. ignored 每条必须有理由（≥8 字符），且 coverage 算术自洽：sourceKeys === keys + ignored
//   6. 模板里不出现疑似真实密钥（64 位 hex / sk- 前缀 / AKID 前缀）
//
// 报告（WARN，不阻塞）：default= 字面量与源码该行附近 ±5 行对不上（可能是归一化写法差异）

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TEMPLATE_DIR = resolve(ROOT, 'config/templates');

const SERVICES = [
  { id: 'memorycore', label: 'MemoryCore', port: 8420 },
  { id: 'memoryproxy', label: 'MemoryProxy', port: 8096 },
  { id: 'memoryknowledge', label: 'MemoryKnowledge', port: 8421 },
  { id: 'memorypanel', label: 'MemoryPanel', port: 8123 },
  { id: 'dsh-plugin', label: 'dsh-plugin', port: null },
];

const yaml = (() => {
  // 仓库根的 node_modules 里没有 yaml，复用 MemoryCore 的那份（同一版本族）
  for (const base of [ROOT, resolve(ROOT, 'MemoryCore')]) {
    try {
      return createRequire(resolve(base, 'package.json'))('yaml');
    } catch {}
  }
  return null;
})();

const failures = [];
const warns = [];
const fail = (svc, msg) => failures.push(`[${svc}] ${msg}`);
const warn = (svc, msg) => warns.push(`[${svc}] ${msg}`);

const SECRET_PATTERNS = [
  { re: /\b[0-9a-f]{64}\b/i, what: '64 位 hex（疑似网关 key）' },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, what: 'sk- 前缀密钥' },
  { re: /\bAKID[A-Za-z0-9]{12,}\b/, what: '腾讯云 AKID' },
  { re: /\bark-[A-Za-z0-9-]{16,}\b/, what: 'ark 密钥' },
];

function flattenKeys(node, prefix = '', out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => flattenKeys(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      flattenKeys(v, p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function sourceLineOk(srcPath, srcLine, keyPath) {
  const abs = resolve(ROOT, srcPath);
  if (!existsSync(abs)) return { ok: false, why: `源文件不存在：${srcPath}` };
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  if (!Number.isInteger(srcLine) || srcLine < 1 || srcLine > lines.length) {
    return { ok: false, why: `行号越界：${srcPath}:${srcLine}（共 ${lines.length} 行）` };
  }
  const leaf = keyPath.split('.').pop().replace(/\[\d+\]$/, '').replace(/\(\)$/, '').replace(/\[\]$/, '');
  const text = lines[srcLine - 1];
  if (!text.includes(leaf)) {
    return { ok: false, why: `${srcPath}:${srcLine} 未命中键末段 "${leaf}"，实际行：${text.trim().slice(0, 120)}` };
  }
  return { ok: true, text, near: lines.slice(Math.max(0, srcLine - 6), srcLine + 5).join('\n') };
}

function normDefault(v) {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.trim();
  return JSON.stringify(v);
}

let totalKeys = 0;
let totalChecked = 0;
let totalDefaultNotes = 0;

for (const svc of SERVICES) {
  const tplPath = resolve(TEMPLATE_DIR, `${svc.id}.yaml`);
  const keysPath = resolve(TEMPLATE_DIR, `${svc.id}.keys.json`);

  if (!existsSync(tplPath)) { fail(svc.id, `缺模板：config/templates/${svc.id}.yaml`); continue; }
  if (!existsSync(keysPath)) { fail(svc.id, `缺机器清单：config/templates/${svc.id}.keys.json`); continue; }

  const tplRaw = readFileSync(tplPath, 'utf8');
  for (const { re, what } of SECRET_PATTERNS) {
    const m = tplRaw.match(re);
    if (m) fail(svc.id, `模板含疑似真实密钥（${what}）：${m[0].slice(0, 12)}…`);
  }

  let keysJson;
  try {
    keysJson = JSON.parse(readFileSync(keysPath, 'utf8'));
  } catch (e) {
    fail(svc.id, `keys.json 不是合法 JSON：${e.message}`);
    continue;
  }

  if (keysJson.service !== svc.id) fail(svc.id, `keys.json.service 应为 "${svc.id}"，实为 "${keysJson.service}"`);
  if (!Array.isArray(keysJson.sources) || keysJson.sources.length === 0) fail(svc.id, 'keys.json.sources 为空');
  if (!Array.isArray(keysJson.keys)) { fail(svc.id, 'keys.json.keys 不是数组'); continue; }
  if (!Array.isArray(keysJson.ignored)) fail(svc.id, 'keys.json.ignored 不是数组（无忽略项就写 []）');

  // 3. 模板 ↔ keys.json 双向键集合
  let parsed;
  try {
    parsed = yaml ? yaml.parse(tplRaw) : null;
  } catch (e) {
    fail(svc.id, `模板不是合法 YAML：${e.message}`);
    continue;
  }
  if (!yaml) fail(svc.id, '找不到 yaml 解析器（MemoryCore/node_modules/yaml），无法校验模板结构');
  // 数组下标归一：模板里 instances[0].id 与 keys.json 的 instances[].id 视为同一键
  const normPath = (p) => p.replace(/\[\d+\]/g, '[]');
  const tplKeys = parsed ? [...new Set(flattenKeys(parsed).map(normPath))] : [];
  const jsonKeys = keysJson.keys.map((k) => normPath(k.path));
  const jsonSet = new Set(jsonKeys);
  const tplSet = new Set(tplKeys);

  for (const k of jsonKeys) if (!tplSet.has(k)) fail(svc.id, `keys.json 里有、模板里没有（模板漏写）：${k}`);
  for (const k of tplKeys) if (!jsonSet.has(k)) fail(svc.id, `模板里有、keys.json 没登记：${k}`);
  if (new Set(jsonKeys).size !== jsonKeys.length) {
    const seen = new Set(); const dup = [];
    for (const k of jsonKeys) { if (seen.has(k)) dup.push(k); seen.add(k); }
    fail(svc.id, `keys.json 有重复 path：${dup.slice(0, 5).join(', ')}`);
  }

  // 4/5. 逐键断言
  for (const k of keysJson.keys) {
    totalKeys += 1;
    if (!k.path || typeof k.path !== 'string') { fail(svc.id, '存在无 path 的键'); continue; }
    if (!k.type) fail(svc.id, `${k.path} 缺 type`);
    if (!k.source || !/^[^:]+:\d+$/.test(k.source)) { fail(svc.id, `${k.path} 的 source 不是 File:line 形式："${k.source}"`); continue; }
    if (typeof k.consumed !== 'boolean') fail(svc.id, `${k.path} 的 consumed 必须是布尔`);
    const [srcPath, srcLineRaw] = k.source.split(/:(?=\d+$)/);
    const r = sourceLineOk(srcPath, Number(srcLineRaw), k.path);
    if (!r.ok) { fail(svc.id, `${k.path} — ${r.why}`); continue; }
    totalChecked += 1;
    // 显式声明的「无缺省」与「空串缺省」不参与字面量核对：
    //   required: true 或 default: "required" → 源码调不出缺省值（必填项），靠 type + 注释交代
    //   default: ""                          → 空串即缺省，字面量在源码里可能写成 `?? ''` 或 helper 返回值，逐字找必然落空
    // keys.json 里写 "\"\"" 这种「带引号的字面量」时按内层比较（模板注释里为了可读性常这么写）
    const dv0 = typeof k.default === 'string' && /^".*"$/.test(k.default) ? k.default.slice(1, -1) : k.default;
    if (dv0 === 'undefined') {
      fail(svc.id, `${k.path} 的 default 写成 "undefined"：没有缺省就删掉 default 并写 required: true，undefined 不是缺省值`);
      continue;
    }
    // 两种等价写法都认：default: "unset"（MemoryCore/dsh-plugin 的存量写法）与 required: true
    const declaredNoDefault = k.required === true || dv0 === 'required' || dv0 === 'unset';
    const declaredEmpty = dv0 === '';
    if (declaredNoDefault || declaredEmpty) {
      totalDefaultNotes += 1;
    } else {
      // default 字面量核对：容忍引号/下划线/千分位/大小写差异，容忍常量名折算（带 defaultNote）
      const squash = (s) => String(s).replace(/["'`]/g, '').replace(/[_\s,]/g, '').toLowerCase();
      const cands = new Set([squash(k.default)]);
      if (typeof k.default === 'string') cands.add(squash(JSON.stringify(k.default)));
      cands.delete('');
      const nearSquashed = squash(r.near);
      const hit = [...cands].some((c) => nearSquashed.includes(c));
      if (!hit && !k.defaultNote) {
        warn(svc.id, `${k.path} 的 default=${k.default} 在 ${k.source} 附近 ±5 行未找到字面量，且无 defaultNote 说明（请人工确认是归一化写法还是真漂移）`);
      } else if (!hit && k.defaultNote) {
        totalDefaultNotes += 1;
      }
    }
  }

  for (const ig of keysJson.ignored ?? []) {
    if (!ig.path) fail(svc.id, 'ignored 条目缺 path');
    if (typeof ig.reason !== 'string' || ig.reason.trim().length < 8) {
      fail(svc.id, `ignored "${ig.path}" 缺理由（≥8 字符），"不知道" 不是理由`);
    }
  }

  // keys 与 ignored 不相交（孤儿键留在 keys 里，不进 ignored）
  const ignSet = new Set((keysJson.ignored ?? []).map((i) => i.path));
  for (const p of ignSet) {
    if (jsonSet.has(p)) fail(svc.id, `"${p}" 同时出现在 keys 与 ignored（孤儿键应留在 keys 并标 orphan:true）`);
  }
  for (const k of keysJson.keys) {
    if (k.consumed === false && !(k.orphan === true || (typeof k.reason === 'string' && k.reason.trim().length >= 8))) {
      fail(svc.id, `${k.path} 标了 consumed:false，但缺 orphan:true 与 reason（孤立键必须可追责）`);
    }
  }

  const cov = keysJson.coverage;
  if (!cov || typeof cov.sourceKeys !== 'number') {
    fail(svc.id, 'keys.json 缺 coverage.sourceKeys（源码解析键总数）');
  } else {
    const sum = keysJson.keys.length + (keysJson.ignored?.length ?? 0);
    if (cov.sourceKeys !== sum) {
      fail(svc.id, `coverage 算术不自洽：sourceKeys=${cov.sourceKeys} 但 keys(${keysJson.keys.length}) + ignored(${keysJson.ignored?.length ?? 0}) = ${sum}`);
    }
    // 三个分项不是必须，但写了就必须对（否则等于自证材料造假）
    const tplCount = cov.templatedKeys ?? cov.templateKeys;
    if (tplCount === undefined) warn(svc.id, 'coverage 缺 templatedKeys（模板键数），补上才能自证 sourceKeys 的拆分');
    else if (tplCount !== keysJson.keys.length) fail(svc.id, `coverage.templatedKeys=${tplCount} 与实际 keys(${keysJson.keys.length}) 不符`);
    if (cov.ignoredKeys === undefined) warn(svc.id, 'coverage 缺 ignoredKeys');
    else if (cov.ignoredKeys !== (keysJson.ignored?.length ?? 0)) fail(svc.id, `coverage.ignoredKeys=${cov.ignoredKeys} 与实际 ignored(${keysJson.ignored?.length ?? 0}) 不符`);
    if (typeof cov.note !== 'string' || cov.note.trim().length < 8) warn(svc.id, 'coverage 缺 note（一句话说明哪些键被算进/排除）');
  }

  // 6. 模板自身可搬运性：list<T>/map<K,V> 的键必须是真数组/真对象
  //    （写成 JSON 字符串 `"[\"a\",\"b\"]"` 时，core 的 strArray 只判 Array.isArray ⇒ 静默回落缺省，
  //     用户照抄一份「看起来配了」的模板却完全不生效——这是最难查的一类假配置）
  if (parsed) {
    const typeOf = new Map(keysJson.keys.map((k) => [normPath(k.path), String(k.type ?? '')]));
    const walk = (node, prefix) => {
      if (node === null || typeof node !== 'object') {
        if (typeof node === 'string' && /^\s*[\[{]/.test(node)) {
          fail(svc.id, `${prefix} 的值是字符串 "${node.slice(0, 40)}…"（疑似把 JSON 写进了 YAML 标量：真数组/真对象才会被加载器读到）`);
        }
        return;
      }
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${prefix}[]`)); return; }
      for (const [k, v] of Object.entries(node)) {
        const p2 = prefix ? `${prefix}.${k}` : k;
        const t = typeOf.get(normPath(p2)) ?? '';
        if ((t.startsWith('list<') || t.startsWith('map<')) && v !== null && typeof v !== 'object') {
          fail(svc.id, `${p2} 的 type=${t} 但模板里写成了 ${typeof v}，加载器会判为非数组/非对象而静默回落缺省`);
        }
        walk(v, p2);
      }
    };
    walk(parsed, '');
  }

  const mark = failures.some((f) => f.startsWith(`[${svc.id}]`)) ? 'FAIL' : 'OK  ';
  console.log(`${mark} ${svc.label.padEnd(16)} 键 ${String(keysJson.keys.length).padStart(4)} | ignored ${String(keysJson.ignored?.length ?? 0).padStart(3)} | 行号命中 ${keysJson.keys.length}`);
}

// ── env.ps1（非 YAML 模板，单独一套断言） ──────────────────────────────────
{
  const id = 'env';
  const tplPath = resolve(TEMPLATE_DIR, 'env.ps1');
  const keysPath = resolve(TEMPLATE_DIR, 'env.keys.json');
  if (!existsSync(tplPath) || !existsSync(keysPath)) {
    fail(id, '缺 config/templates/env.ps1 或 env.keys.json');
  } else {
    const tplRaw = readFileSync(tplPath, 'utf8');
    for (const { re, what } of SECRET_PATTERNS) {
      const m = tplRaw.match(re);
      if (m) fail(id, `模板含疑似真实密钥（${what}）：${m[0].slice(0, 12)}…`);
    }
    let kj;
    try {
      kj = JSON.parse(readFileSync(keysPath, 'utf8'));
    } catch (e) {
      fail(id, `env.keys.json 不是合法 JSON：${e.message}`);
      kj = null;
    }
    if (kj) {
      if (kj.service !== 'env') fail(id, `env.keys.json.service 应为 "env"，实为 "${kj.service}"`);
      const keys = Array.isArray(kj.keys) ? kj.keys : [];
      let hits = 0;
      for (const k of keys) {
        totalKeys += 1;
        if (!k.name) { fail(id, '存在无 name 的变量'); continue; }
        if (!tplRaw.includes('$env:' + k.name)) fail(id, `变量 ${k.name} 未出现在模板里`);
        if (!k.consumer || !/^[^:]+:\d+$/.test(k.consumer)) { fail(id, `${k.name} 的 consumer 不是 File:line 形式："${k.consumer}"`); continue; }
        if (!k.purpose || String(k.purpose).trim().length < 6) fail(id, `${k.name} 缺 purpose（≥6 字符）`);
        const [sp, sl] = k.consumer.split(/:(?=\d+$)/);
        const r = sourceLineOk(sp, Number(sl), k.name);
        if (!r.ok) { fail(id, `${k.name} — ${r.why}`); continue; }
        hits += 1;
        totalChecked += 1;
      }
      const cov = kj.coverage;
      const ignored = Array.isArray(kj.ignored) ? kj.ignored : [];
      if (!cov || typeof cov.sourceKeys !== 'number') fail(id, 'env.keys.json 缺 coverage.sourceKeys');
      else if (cov.sourceKeys !== keys.length + ignored.length) {
        fail(id, `coverage 算术不自洽：sourceKeys=${cov.sourceKeys} 但 keys(${keys.length}) + ignored(${ignored.length}) = ${keys.length + ignored.length}`);
      }
      const mark = failures.some((f) => f.startsWith('[env]')) ? 'FAIL' : 'OK  ';
      console.log(`${mark} ${'env.ps1'.padEnd(16)} 变量 ${String(keys.length).padStart(4)} | ignored ${String(ignored.length).padStart(3)} | 消费点命中 ${hits}`);
    }
  }
}

console.log('');
if (warns.length) {
  console.log(`WARN ${warns.length} 条：`);
  for (const w of warns) console.log('  ' + w);
  console.log('');
}
if (failures.length) {
  console.log(`FAIL ${failures.length} 条：`);
  for (const f of failures) console.log('  ' + f);
  console.log(`\n结论：FAIL（${totalChecked}/${totalKeys} 个键通过行号命中校验）`);
  process.exit(1);
}
console.log(`结论：PASS（${SERVICES.length} 份模板 / ${totalKeys} 个键全部通过行号命中校验）`);
