#!/usr/bin/env node
/**
 * dsh 插件 v3 活体冒烟（零依赖，Node >= 22，global fetch）。
 *
 * 用途：把「插件依赖的四个 v3 端点」在真机上跑一遍并断言，作为部署到宿主前的
 * 环境自检。只写一次性的 session_id（smoke-<ts>）并在结束时删除，不碰任何既有会话。
 *
 * 为什么是这四个端点：spec 原写的 /v3/dsh/{handshake,context,turn/end} 在仓库里
 * 根本不存在（见 docs/specs/2026-10-31-dsh-native-memory-plugin-spec.md 头部
 * 「实测更正」节），插件实际能依靠的是已有 v3 数据面端点：
 *   POST /v3/core/read         persona（L3）正文
 *   POST /v3/scenario/ls       L2 场景索引
 *   POST /v3/atomic/search     L1 召回（冷/热各一次，量真实耗时）
 *   POST /v3/conversation/add  L0 回写（+ /v3/conversation/delete 清理）
 *
 * 配置（环境变量）：
 *   AGEMEM_CORE_URL    默认 http://127.0.0.1:8420
 *   AGEMEM_API_KEY     默认从 MemoryCore/tdai-gateway.yaml 的 server.apiKey 读；读不到直接报错
 *   AGEMEM_SERVICE_ID  默认 default（请求头 x-tdai-service-id）
 *   AGEMEM_TEAM_ID / AGEMEM_AGENT_ID / AGEMEM_USER_ID  必填（真实身份不落仓库）
 *
 * 退出码：0 = 五步全过；1 = 任一步失败（打印 status + 响应体）。
 * 用法：node dsh-plugin/scripts/smoke-v3.mjs  （或 cd dsh-plugin && npm run smoke:v3）
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const CORE_URL = (process.env.AGEMEM_CORE_URL ?? 'http://127.0.0.1:8420').replace(/\/+$/, '');
const SERVICE_ID = process.env.AGEMEM_SERVICE_ID ?? 'default';
/** 真实身份不写进仓库：缺省空会让 v3 请求串号，所以这里直接要求显式提供。 */
function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    throw new Error(`${name} 未设置：请设置真实的 team / agent / user id 后再跑 smoke。`);
  }
  return value;
}

const TEAM_ID = requireEnv('AGEMEM_TEAM_ID');
const AGENT_ID = requireEnv('AGEMEM_AGENT_ID');
const USER_ID = requireEnv('AGEMEM_USER_ID');
const REQUEST_TIMEOUT_MS = Number(process.env.AGEMEM_SMOKE_TIMEOUT_MS ?? 60000);

/** 从 gateway yaml 的 server 段取 apiKey（yaml 里还有 llm/embedding 两处 apiKey，别抓错）。 */
function readApiKeyFromGatewayYaml() {
  const yamlPath = join(repoRoot, 'MemoryCore', 'tdai-gateway.yaml');
  let text;
  try {
    text = readFileSync(yamlPath, 'utf8');
  } catch (error) {
    throw new Error(
      'AGEMEM_API_KEY 未设置，且读不到 ' + yamlPath + '（' + error.message + '）。' +
        '请设置 AGEMEM_API_KEY=<MemoryCore/tdai-gateway.yaml 的 server.apiKey>。',
    );
  }
  const lines = text.split(/\r?\n/);
  let inServer = false;
  for (const line of lines) {
    if (/^server:\s*$/.test(line)) {
      inServer = true;
      continue;
    }
    if (inServer && /^\S/.test(line)) break; // 下一段顶层键，server 段结束
    if (!inServer) continue;
    const match = /^\s+apiKey:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/g, '').trim();
    if (!value || value.startsWith('${')) continue; // 占位符（env 通道已弃用）
    return value;
  }
  throw new Error('AGEMEM_API_KEY 未设置，且 ' + yamlPath + ' 的 server 段里没有可用的 apiKey。');
}

function resolveApiKey() {
  const fromEnv = (process.env.AGEMEM_API_KEY ?? '').trim();
  return fromEnv !== '' ? fromEnv : readApiKeyFromGatewayYaml();
}

const IDENTITY = { team_id: TEAM_ID, agent_id: AGENT_ID, user_id: USER_ID };
const summary = {};

function log(line = '') {
  process.stdout.write(line + '\n');
}

function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/, 1)[0] ?? '';
  return line.length > 72 ? line.slice(0, 72) + '…' : line;
}

function snippet(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

async function post(path, body, apiKey) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(CORE_URL + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
        'x-tdai-service-id': SERVICE_ID,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log('FAIL  POST ' + path + ' — 连不上 ' + CORE_URL + '：' + error.message);
    log('      核心没起来？先确认 ' + CORE_URL + '/health 可访问。');
    process.exit(1);
  }
  const ms = Math.round(performance.now() - started);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, ms, text, json };
}

function fail(step, path, result, detail) {
  log('FAIL  ' + step + ' POST ' + path + ' — ' + detail);
  log('      status=' + result.status + ' 耗时=' + result.ms + 'ms');
  log('      响应体: ' + result.text.slice(0, 2000));
  process.exit(1);
}

/** 断言 HTTP 200 + 信封 code===0；返回 data。 */
function expectOk(step, path, result) {
  if (result.status !== 200) fail(step, path, result, '期望 HTTP 200');
  if (!result.json || typeof result.json !== 'object') fail(step, path, result, '响应不是 JSON 对象');
  if (result.json.code !== 0) {
    fail(step, path, result, '信封 code=' + JSON.stringify(result.json.code) + '（非 0）message=' + JSON.stringify(result.json.message));
  }
  return result.json.data;
}

function stepLine(index, total, label, result, detail) {
  log(
    '[' + index + '/' + total + '] ' +
      label.padEnd(30) +
      String(result.status).padEnd(5) +
      (result.ms + 'ms').padEnd(9) +
      (detail ?? ''),
  );
}

const STEPS = 5;
const apiKey = resolveApiKey();

log('agemem v3 smoke — core=' + CORE_URL + '  service=' + SERVICE_ID);
log('identity: team=' + TEAM_ID + ' agent=' + AGENT_ID + ' user=' + USER_ID);
log('');

// ---- 1/5 core/read：L3 persona 正文 ----
{
  const result = await post('/v3/core/read', { ...IDENTITY }, apiKey);
  const data = expectOk('1/5', '/v3/core/read', result);
  if (typeof data.content !== 'string') fail('1/5', '/v3/core/read', result, 'data.content 不是字符串');
  summary.coreReadChars = data.content.length;
  summary.coreReadFirstLine = firstLine(data.content);
  stepLine(1, STEPS, 'POST /v3/core/read', result, 'code=0 content=' + data.content.length + ' chars  首行=' + JSON.stringify(firstLine(data.content)));
}

// ---- 2/5 scenario/ls：L2 场景索引 ----
{
  const result = await post('/v3/scenario/ls', { ...IDENTITY }, apiKey);
  const data = expectOk('2/5', '/v3/scenario/ls', result);
  const entries = data.entries;
  if (!Array.isArray(entries)) fail('2/5', '/v3/scenario/ls', result, 'data.entries 不是数组');
  const withPath = entries.filter((entry) => entry && typeof entry.path === 'string');
  summary.scenarioEntries = entries.length;
  summary.scenarioSamplePaths = withPath.slice(0, 2).map((entry) => entry.path);
  stepLine(2, STEPS, 'POST /v3/scenario/ls', result, 'code=0 entries=' + entries.length + '  样例=' + JSON.stringify(summary.scenarioSamplePaths));
}

// ---- 3/5 atomic/search：L1 召回，冷/热各一次 ----
{
  const body = { ...IDENTITY, query: '项目 目标 偏好 约定', limit: 5 };
  const cold = await post('/v3/atomic/search', body, apiKey);
  const coldData = expectOk('3/5', '/v3/atomic/search', cold);
  if (!Array.isArray(coldData.items)) fail('3/5', '/v3/atomic/search', cold, 'data.items 不是数组');
  stepLine(3, STEPS, 'POST /v3/atomic/search (冷)', cold, 'code=0 hits=' + coldData.items.length);

  const warm = await post('/v3/atomic/search', body, apiKey);
  const warmData = expectOk('3/5', '/v3/atomic/search', warm);
  if (!Array.isArray(warmData.items)) fail('3/5', '/v3/atomic/search', warm, 'data.items 不是数组');

  const preview = warmData.items.slice(0, 2).map((item) => ({
    type: item?.type ?? null,
    score: typeof item?.score === 'number' ? Number(item.score.toFixed(4)) : null,
    content: snippet(item?.content, 60),
  }));
  summary.searchHits = coldData.items.length;
  summary.searchColdMs = cold.ms;
  summary.searchWarmMs = warm.ms;
  summary.searchPreview = preview;
  stepLine(3, STEPS, 'POST /v3/atomic/search (热)', warm, 'code=0 hits=' + warmData.items.length + '  冷/热=' + cold.ms + '/' + warm.ms + 'ms');
  for (const [index, item] of preview.entries()) {
    log('      hit' + (index + 1) + ': type=' + item.type + ' score=' + item.score + ' content=' + JSON.stringify(item.content));
  }
}

// ---- 4/5 conversation/add：L0 回写（一次性 session） ----
const smokeSessionId = 'smoke-' + Date.now().toString(36);
let accepted = 0;
{
  const now = Date.now();
  const result = await post('/v3/conversation/add', {
    ...IDENTITY,
    session_id: smokeSessionId,
    messages: [
      {
        role: 'user',
        content: '[smoke-v3] 这是一条冒烟测试消息，用于验证 /v3/conversation/add 写路；可选删除。',
        timestamp: new Date(now).toISOString(),
      },
      {
        role: 'assistant',
        content: '[smoke-v3] 写入已确认。',
        timestamp: new Date(now + 1000).toISOString(),
      },
    ],
  }, apiKey);
  const data = expectOk('4/5', '/v3/conversation/add', result);
  if (!Array.isArray(data.accepted_ids) || data.accepted_ids.length === 0) {
    fail('4/5', '/v3/conversation/add', result, 'data.accepted_ids 不是非空数组');
  }
  accepted = data.accepted_ids.length;
  summary.acceptedIds = accepted;
  stepLine(4, STEPS, 'POST /v3/conversation/add', result, 'code=0 accepted_ids=' + accepted + ' session=' + smokeSessionId);
}

// ---- 5/5 conversation/delete：清理上面那条 ----
{
  const result = await post('/v3/conversation/delete', { ...IDENTITY, session_ids: [smokeSessionId] }, apiKey);
  const data = expectOk('5/5', '/v3/conversation/delete', result);
  summary.deletedCount = data.deleted_count ?? null;
  summary.smokeSessionId = smokeSessionId;
  stepLine(5, STEPS, 'POST /v3/conversation/delete', result, 'code=0 deleted_count=' + summary.deletedCount + ' session=' + smokeSessionId);
}

log('');
log('SMOKE OK ' + STEPS + '/' + STEPS + '  core=' + CORE_URL + '  chars=' + summary.coreReadChars + '  entries=' + summary.scenarioEntries + '  hits=' + summary.searchHits + '  cold/warm=' + summary.searchColdMs + '/' + summary.searchWarmMs + 'ms');
log('summary=' + JSON.stringify(summary));
process.exit(0);
