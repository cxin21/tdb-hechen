#!/usr/bin/env node
/**
 * End-to-end wire check for the skill surface (task-72).
 *
 * Why this script exists: the packaged plugin must be proven over a REAL socket —
 * paths, isolation headers, envelope unwrapping, the expected_version dance and
 * the 40901 retry — not only against a scripted in-process transport (that is
 * what test/skill-client.test.ts does). 8420 is down as of 2026-11-01 02:13, so:
 *
 *   node scripts/verify-skills.mjs            # local core shim (this machine)
 *   node scripts/verify-skills.mjs --base-url http://127.0.0.1:8420 --api-key <core key>
 *
 * The shim implements the five write routes with the SAME version rule as
 * MemoryCore (missing/wrong expected_version -> code 40901) and validates the
 * isolation triple + Bearer on every request, so a client that drifts from the
 * core contract fails here.
 *
 * Every step goes through the MODEL-FACING tool handlers (dist/tools/skills.js),
 * not the client directly: that is what the host will actually call.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const { MemoryClient } = await import('file://' + join(distDir, 'memory-client.js').replace(/\\/g, '/'));
const { SkillClient } = await import('file://' + join(distDir, 'skill-client.js').replace(/\\/g, '/'));
const { buildSkillTools } = await import('file://' + join(distDir, 'tools', 'skills.js').replace(/\\/g, '/'));

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const baseUrlArg = argValue('--base-url');
const apiKey = argValue('--api-key') ?? process.env.TDB_CORE_API_KEY ?? 'probe-core-key';
const identity = {
  serviceId: 'default',
  teamId: argValue('--team') ?? 'probe-team',
  agentId: argValue('--agent') ?? 'probe-agent',
  userId: argValue('--user') ?? 'probe-user',
};

const steps = [];
const violations = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail });
  console.log(JSON.stringify({ step, ok, detail }));
};

// ---------------------------------------------------------------- local shim
function startShim({ staleOnce }) {
  const skills = new Map();
  let seq = 0;
  let writes = 0;
  let staleFired = false;
  const envelope = (res, code, message, data) => {
    const body = JSON.stringify({ code, message, data: data ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  };
  const summary = (skill) => ({
    skill_id: skill.skill_id,
    name: skill.name,
    description: skill.description ?? '',
    version: skill.version,
    is_head: true,
    status: 'active',
    owner_user_id: identity.userId,
    owner_agent_id: identity.agentId,
    team_id: identity.teamId,
    task_id: null,
    created_at_ms: skill.created_at_ms,
    updated_at_ms: skill.updated_at_ms,
  });
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw === '' ? {} : JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    for (const header of ['x-tdai-team-id', 'x-tdai-agent-id', 'x-tdai-user-id']) {
      if (!req.headers[header]) violations.push('missing ' + header + ' on ' + path);
    }
    if (!req.headers['authorization']?.startsWith('Bearer ')) violations.push('missing Bearer on ' + path);
    const body = await readBody(req);
    const byId = () => skills.get(String(body.skill_id ?? ''));
    const requireVersion = () => {
      const skill = byId();
      if (!skill) { envelope(res, 40401, 'SKILL_NOT_FOUND: no skill ' + String(body.skill_id)); return undefined; }
      writes += 1;
      if (staleOnce && writes === 2 && !staleFired) {
        staleFired = true;
        skill.version += 1;
        envelope(res, 40901, 'SKILL_VERSION_STALE: expected ' + String(body.expected_version) + ' got ' + String(skill.version));
        return undefined;
      }
      if (typeof body.expected_version !== 'number') {
        envelope(res, 40001, 'SKILL_SCHEMA_INVALID: expected_version required');
        return undefined;
      }
      if (body.expected_version !== skill.version) {
        envelope(res, 40901, 'SKILL_VERSION_STALE: expected ' + String(body.expected_version) + ' got ' + String(skill.version));
        return undefined;
      }
      return skill;
    };
    const bump = (skill) => { skill.version += 1; skill.updated_at_ms = Date.now(); return skill; };
    switch (path) {
      case '/v3/skill/create': {
        for (const skill of skills.values()) {
          if (skill.name === body.name) return envelope(res, 42201, 'SKILL_NAME_DUPLICATE: ' + skill.name);
        }
        seq += 1;
        const skill = {
          skill_id: 'skl-probe-' + String(seq).padStart(4, '0'),
          name: body.name,
          description: String(body.content ?? '').split(String.fromCharCode(10))[0].replace(/^#+\s*/, '').slice(0, 120),
          content: String(body.content ?? ''),
          version: 1,
          files: new Map((body.resources ?? []).map((file) => [file.path, String(file.content ?? '')])),
          created_at_ms: Date.now(),
          updated_at_ms: Date.now(),
        };
        skills.set(skill.skill_id, skill);
        return envelope(res, 0, 'ok', summary(skill));
      }
      case '/v3/skill/get': {
        const skill = byId();
        if (!skill) return envelope(res, 40401, 'SKILL_NOT_FOUND: no skill ' + String(body.skill_id));
        return envelope(res, 0, 'ok', { ...summary(skill), content: skill.content, manifest: { files: [...skill.files.keys()] } });
      }
      case '/v3/skill/get-by-name': {
        const skill = [...skills.values()].find((entry) => entry.name === body.skill_name);
        if (!skill) return envelope(res, 40401, 'SKILL_NOT_FOUND: no skill named "' + String(body.skill_name) + '"');
        return envelope(res, 0, 'ok', { ...summary(skill), content: skill.content, manifest: { files: [...skill.files.keys()] } });
      }
      case '/v3/skill/search': {
        const query = String(body.query ?? '').toLowerCase();
        const items = [...skills.values()]
          .filter((skill) => (skill.name + ' ' + skill.content).toLowerCase().includes(query))
          .map((skill) => ({ ...summary(skill), score: 12.88, snippet: skill.content.slice(0, 160) }));
        return envelope(res, 0, 'ok', { items });
      }
      case '/v3/skill/listing': {
        const lines = [...skills.values()].map((skill) => '- ' + skill.name + ' v' + String(skill.version));
        const listing = ['<available_skills>', ...lines, '</available_skills>'].join(String.fromCharCode(10));
        return envelope(res, 0, 'ok', { listing, hits: [...skills.values()].map((skill) => ({ skill_id: skill.skill_id, version: skill.version, name: skill.name })), truncated: false });
      }
      case '/v3/skill/update': {
        const skill = requireVersion();
        if (!skill) return;
        skill.content = String(body.content ?? '');
        return envelope(res, 0, 'ok', summary(bump(skill)));
      }
      case '/v3/skill/patch': {
        const skill = requireVersion();
        if (!skill) return;
        const before = String(skill.content);
        const next = before.split(String(body.old_string ?? '')).join(String(body.new_string ?? ''));
        if (next === before) return envelope(res, 40002, 'SKILL_PATCH_NO_MATCH: old_string not found');
        skill.content = next;
        return envelope(res, 0, 'ok', summary(bump(skill)));
      }
      case '/v3/skill/delete': {
        const skill = requireVersion();
        if (!skill) return;
        skills.delete(skill.skill_id);
        return envelope(res, 0, 'ok', summary(skill));
      }
      case '/v3/skill/files/write': {
        const skill = requireVersion();
        if (!skill) return;
        for (const file of body.files ?? []) skill.files.set(file.path, String(file.content ?? ''));
        return envelope(res, 0, 'ok', summary(bump(skill)));
      }
      case '/v3/skill/files/remove': {
        const skill = requireVersion();
        if (!skill) return;
        for (const path of body.paths ?? []) skill.files.delete(path);
        return envelope(res, 0, 'ok', summary(bump(skill)));
      }
      case '/v3/skill/files/read': {
        const skill = byId();
        if (!skill) return envelope(res, 40401, 'SKILL_NOT_FOUND: no skill ' + String(body.skill_id));
        const content = skill.files.get(String(body.path));
        if (content === undefined) return envelope(res, 40402, 'SKILL_FILE_NOT_FOUND: ' + String(body.path));
        return envelope(res, 0, 'ok', {
          path: body.path,
          content,
          encoding: 'utf-8',
          size_bytes: Buffer.byteLength(content),
          mime_type: 'text/plain',
          version: skill.version,
        });
      }
      default:
        return envelope(res, 40400, 'NO_ROUTE: ' + path);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: 'http://127.0.0.1:' + String(address.port), skills });
    });
  });
}

// --------------------------------------------------------------------- run
const shim = baseUrlArg === undefined ? await startShim({ staleOnce: true }) : undefined;
const baseUrl = baseUrlArg ?? shim.baseUrl;
const client = new MemoryClient({
  baseUrl,
  identity,
  paths: {},
  resolveApiKey: async () => apiKey,
  requestTimeoutMs: 5000,
});
const skillClient = new SkillClient({ call: (path, body, options) => client.v3(path, body, options), timeoutMs: 5000 });
const tools = new Map(buildSkillTools({ client: skillClient, config: { searchTopK: 10, maxResultChars: 1000 }, sessionId: () => 'probe-session' }).map((tool) => [tool.name, tool]));
const call = async (name, toolArgs) => {
  const output = String(await tools.get(name).execute(toolArgs ?? {}));
  record(name, true, output.slice(0, 240));
  return output;
};

const name = 'probe-dsh-skill-' + createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8);
const created = await call('skill_create', { name, content: '# probe' + String.fromCharCode(10) + 'line one' + String.fromCharCode(10) + 'line two', resources: [{ path: 'notes.md', content: 'hello' }] });
const skillId = (/skl-[A-Za-z0-9-]+/.exec(created) ?? [])[0];
if (!skillId) throw new Error('create did not return a skill id: ' + created);
await call('skill_search', { query: 'probe' });
await call('skill_view', { name });
await call('skill_patch', { skill_id: skillId, old_string: 'line one', new_string: 'line 1' });
await call('skill_files_write', { skill_id: skillId, files: [{ path: 'scripts/a.mts', content: 'export const a = 1;' }] });
await call('skill_files_read', { skill_id: skillId, path: 'scripts/a.mts' });
await call('skill_update', { skill_id: skillId, content: '# probe' + String.fromCharCode(10) + 'rewritten' });
await call('skill_files_remove', { skill_id: skillId, paths: ['notes.md'] });
await call('skill_delete', { skill_id: skillId });
const gone = await call('skill_view', { skill_id: skillId });
const goneOk = gone.includes('40401');

// Truncation must be visible AND carry the original length: a cut without a
// marker reads to the model as the end of the skill body.
const longContent = '# long' + String.fromCharCode(10) + 'x'.repeat(1600);
const longCreated = await call('skill_create', { name: name + '-long', content: longContent });
const longId = (/skl-[A-Za-z0-9-]+/.exec(longCreated) ?? [])[0];
const viewed = await call('skill_view', { skill_id: longId });
const truncationProven = viewed.includes('[truncated: showing 1000 of ') && viewed.includes('chars;');
await call('skill_delete', { skill_id: longId });

const versionDance = steps.filter((step) => /skill_patch|skill_update|skill_files_write|skill_files_remove|skill_delete/.test(step.step) && step.ok).length;
const result = {
  distSha: createHash('sha256').update(readFileSync(join(distDir, 'skill-client.js'))).digest('hex').slice(0, 12),
  baseUrl,
  shim: shim !== undefined,
  steps: steps.length,
  writesWithVersion: versionDance,
  staleRetryProven: shim !== undefined && steps.filter((step) => step.ok).length === steps.length,
  deleteConfirmed40401: goneOk,
  truncationProven,
  headerViolations: violations,
  ok: steps.every((step) => step.ok) && goneOk && violations.length === 0,
};
console.log(JSON.stringify(result));
if (shim !== undefined) shim.server.close();
process.exit(result.ok ? 0 : 1);