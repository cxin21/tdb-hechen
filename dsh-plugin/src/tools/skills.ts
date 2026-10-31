import { registerToolModule } from './registry.js';
import type { SkillClient, SkillFileWrite, SkillRecord, SkillSearchItem } from '../skill-client.js';
import type { LoggerLike, ToolDefinitionShape } from '../types.js';

/**
 * The skill surface as model tools: ten of them, four read + six write.
 *
 * Background: MemoryCore already ships these ten tools through
 * `skill-tools-injector.ts`, but its six write tools never send
 * `expected_version` (schema: skill-schemas.ts:101/:108/:117/:182/:189), so
 * every write answers HTTP 200 + code 40001 and `allowLlmWrite` is decorative.
 * The plugin re-implements the surface against its own client, where the write
 * path does the read-modify-write itself (skill-client.ts) — the model must not
 * be asked to remember a version number, that is plumbing, not reasoning.
 *
 * Host registration rules that shaped every schema below (measured):
 *   - `parameters` is a whole JSON Schema with `type: 'object'`;
 *   - an optional property MUST omit `required` entirely; `required: false`
 *     makes the host throw UNSUPPORTED_SCHEMA and silently drop the tool.
 */

const TRUNCATION_HINT = 'call skill_files_read (or re-view a narrower section) for the rest';

/**
 * Hard cap for one result; the core's largest head measured 30318 chars.
 * The marker carries BOTH numbers (shown / original): a model that only sees
 * 'truncated' cannot tell whether it missed one line or half the procedure,
 * and the operator reading the log wants the real size.
 */
function truncateForTool(text: string, maxChars: number, hint = TRUNCATION_HINT): string {
  const limit = Math.max(1000, Math.floor(maxChars));
  const total = text.length;
  if (total <= limit) return text;
  const marker = '\n\n[truncated: showing ' + limit + ' of ' + total + ' chars; ' + hint + ']';
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/** One-line skill identity the model can quote back (id + name + version). */
function describe(record: SkillRecord): string {
  const name = typeof record.name === 'string' ? record.name : '(unnamed)';
  const id = typeof record.skill_id === 'string' ? record.skill_id : '(no id)';
  const version = record.version === undefined ? '' : ' v' + String(record.version);
  return name + ' [' + id + version + ']';
}

function searchLine(item: SkillSearchItem, index: number): string {
  const score = typeof item.score === 'number' ? ' score=' + item.score.toFixed(2) : '';
  const snippet = typeof item.snippet === 'string' && item.snippet.trim() !== ''
    ? item.snippet.replace(/\s+/g, ' ').trim().slice(0, 160)
    : (typeof item.description === 'string' ? item.description.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  const line = String(index + 1) + '. ' + describe(item) + score;
  return snippet === '' ? line : line + '\n   ' + snippet;
}

/** Uniform failure text: the core's own words, tagged with its business code. */
function failure(what: string, error: string | undefined, code?: number): string {
  const detail = error === undefined || error === '' ? 'no detail from the core' : error;
  return what + ' failed' + (code === undefined ? '' : ' (code ' + String(code) + ')') + ': ' + detail;
}

function textTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: Record<string, unknown>) => Promise<string>,
): ToolDefinitionShape {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        return await execute(args ?? {});
      } catch (error) {
        return name + ' failed: ' + (error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export interface SkillToolsDeps {
  client: SkillClient;
  config: { searchTopK: number; maxResultChars: number };
  log?: LoggerLike;
  sessionId?: () => string | undefined;
}

export function buildSkillTools(deps: SkillToolsDeps): ToolDefinitionShape[] {
  const client = deps.client;
  const maxChars = deps.config.maxResultChars;

  const readTools: ToolDefinitionShape[] = [
    textTool(
      'skill_search',
      'Search the team\'s skill library (reusable procedures, checklists, code snippets). '
      + 'Use it before improvising a multi-step procedure that someone may already have written down.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the procedure should do (natural language or keywords).' },
          top_k: { type: 'number', description: 'How many skills to return (default ' + String(deps.config.searchTopK) + ', max 50).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async (args) => {
        const query = str(args, 'query');
        if (query === '') return 'skill_search failed: empty query';
        const result = await client.search(query, num(args, 'top_k') ?? deps.config.searchTopK);
        if (!result.ok) return failure('skill_search', result.error, result.code);
        const items = result.data ?? [];
        if (items.length === 0) return 'no skills matched "' + query + '"';
        return items.map(searchLine).join('\n');
      },
    ),
    textTool(
      'skill_view',
      'Read one skill: its full body plus manifest. Pass the skill_id (or the exact name) from skill_search.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          name: { type: 'string', description: 'Exact skill name, when the id is not known.' },
          version: { type: 'number', description: 'Specific version to read (default: the head).' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const skillId = str(args, 'skill_id');
        const name = str(args, 'name');
        if (skillId === '' && name === '') return 'skill_view failed: give either skill_id or name';
        const version = num(args, 'version');
        const result = skillId !== ''
          ? await client.get(skillId, { includeContent: true, includeManifest: true, version })
          : await client.getByName(name, { includeContent: true, includeManifest: true, version });
        if (!result.ok) return failure('skill_view', result.error, result.code);
        const record = result.data ?? {};
        const content = typeof record.content === 'string' ? record.content : '';
        const head = describe(record)
          + (record.description ? '\n' + String(record.description) : '')
          + '\n\n';
        return truncateForTool(head + content, maxChars);
      },
    ),
    textTool(
      'skill_files_read',
      'Read one file attached to a skill (scripts, templates, fixtures). Use it after skill_view when the body references a file.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          path: { type: 'string', description: 'File path inside the skill.' },
          encoding: { type: 'string', description: 'utf-8 (default) or base64.' },
          version: { type: 'number', description: 'Specific version (default: the head).' },
        },
        required: ['skill_id', 'path'],
        additionalProperties: false,
      },
      async (args) => {
        const encoding = str(args, 'encoding') === 'base64' ? 'base64' as const : 'utf-8' as const;
        const result = await client.filesRead(str(args, 'skill_id'), str(args, 'path'), {
          encoding,
          version: num(args, 'version'),
        });
        if (!result.ok) return failure('skill_files_read', result.error, result.code);
        const file = result.data;
        if (file === undefined) return 'skill_files_read failed: empty response';
        const header = file.path + (file.size_bytes === undefined ? '' : ' (' + String(file.size_bytes) + ' bytes)');
        return truncateForTool(header + '\n\n' + file.content, maxChars);
      },
    ),
    textTool(
      'skill_extract',
      'Archive this session\'s skill buffer now, so the core extracts new skills from the conversation without waiting for the size/time threshold.',
      {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the archive is requested (kept in the archive metadata).' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const sessionId = deps.sessionId?.() ?? '';
        if (sessionId === '') return 'skill_extract failed: no active session';
        const result = await client.forceArchive(sessionId, str(args, 'reason'));
        if (!result.ok) return failure('skill_extract', result.error, result.code);
        const status = typeof result.data?.status === 'string' ? result.data.status : 'archived';
        const taskId = result.data?.task_id === undefined ? '' : ' task_id=' + String(result.data.task_id);
        return 'skill extract: ' + status + taskId;
      },
    ),
  ];

  const writeTools: ToolDefinitionShape[] = [
    textTool(
      'skill_create',
      'Create a new team skill (a reusable procedure others can find by search). '
      + 'The body is markdown; put prerequisites, steps and pitfalls in it.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short unique name (<= 64 chars), e.g. "ncc-po-line-numbers".' },
          content: { type: 'string', description: 'The full markdown body of the skill.' },
          description: { type: 'string', description: 'One sentence on when to use this skill.' },
          resources: {
            type: 'array',
            description: 'Files to attach while creating (max 100). Later edits go through skill_files_write.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path inside the skill.' },
                content: { type: 'string', description: 'File content.' },
                encoding: { type: 'string', description: 'utf-8 (default) or base64.' },
                mime_type: { type: 'string', description: 'Optional MIME type.' },
                is_executable: { type: 'boolean', description: 'Mark the file executable.' },
              },
              required: ['path', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
      async (args) => {
        const description = str(args, 'description');
        const resources = (Array.isArray(args.resources) ? args.resources : [])
          .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
          .map((entry) => ({
            path: typeof entry.path === 'string' ? entry.path : '',
            content: typeof entry.content === 'string' ? entry.content : '',
            ...(entry.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
            ...(typeof entry.mime_type === 'string' ? { mime_type: entry.mime_type } : {}),
            ...(entry.is_executable === true ? { is_executable: true } : {}),
          }))
          .filter((entry) => entry.path !== '');
        const result = await client.create({
          name: str(args, 'name'),
          content: str(args, 'content'),
          ...(description === '' ? {} : { metadata: { description } }),
          ...(resources.length === 0 ? {} : { resources }),
        });
        if (!result.ok) return failure('skill_create', result.error, result.code);
        return 'created ' + describe(result.data ?? {}) + ' (version 1)';
      },
    ),
    textTool(
      'skill_update',
      'Replace the whole body of an existing skill. Use skill_view first: update overwrites, it does not merge.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          content: { type: 'string', description: 'The new full markdown body.' },
        },
        required: ['skill_id', 'content'],
        additionalProperties: false,
      },
      async (args) => {
        const result = await client.update(str(args, 'skill_id'), String(args.content ?? ''));
        if (!result.ok) return failure('skill_update', result.error, result.code);
        return 'updated ' + describe(result.data ?? {});
      },
    ),
    textTool(
      'skill_patch',
      'Replace one exact span inside a skill body. Prefer this over skill_update for small fixes: it keeps the rest of the body byte-identical.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          old_string: { type: 'string', description: 'Exact text to replace (must appear in the body).' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default: only a unique match).' },
        },
        required: ['skill_id', 'old_string', 'new_string'],
        additionalProperties: false,
      },
      async (args) => {
        const result = await client.patch(
          str(args, 'skill_id'),
          str(args, 'old_string'),
          typeof args.new_string === 'string' ? args.new_string : '',
          args.replace_all === true,
        );
        if (!result.ok) return failure('skill_patch', result.error, result.code);
        return 'patched ' + describe(result.data ?? {});
      },
    ),
    textTool(
      'skill_delete',
      'Delete (archive) a skill. Irreversible from the model side: the versions stay on disk, but search stops returning it.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
        },
        required: ['skill_id'],
        additionalProperties: false,
      },
      async (args) => {
        const result = await client.delete(str(args, 'skill_id'));
        if (!result.ok) return failure('skill_delete', result.error, result.code);
        return 'deleted ' + describe(result.data ?? {});
      },
    ),
    textTool(
      'skill_files_write',
      'Attach or replace files inside a skill (scripts, templates, fixtures). Paths are relative to the skill root.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          files: {
            type: 'array',
            description: 'Files to write (max 100).',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path inside the skill.' },
                content: { type: 'string', description: 'File content.' },
                encoding: { type: 'string', description: 'utf-8 (default) or base64.' },
                mime_type: { type: 'string', description: 'Optional MIME type.' },
                is_executable: { type: 'boolean', description: 'Mark the file executable.' },
              },
              required: ['path', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['skill_id', 'files'],
        additionalProperties: false,
      },
      async (args) => {
        const raw = Array.isArray(args.files) ? args.files : [];
        const files: SkillFileWrite[] = raw
          .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
          .map((entry) => ({
            path: typeof entry.path === 'string' ? entry.path : '',
            content: typeof entry.content === 'string' ? entry.content : '',
            ...(entry.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
            ...(typeof entry.mime_type === 'string' ? { mime_type: entry.mime_type } : {}),
            ...(entry.is_executable === true ? { is_executable: true } : {}),
          }))
          .filter((entry) => entry.path !== '');
        const result = await client.filesWrite(str(args, 'skill_id'), files);
        if (!result.ok) return failure('skill_files_write', result.error, result.code);
        return 'wrote ' + String(files.length) + ' file(s) into ' + describe(result.data ?? {});
      },
    ),
    textTool(
      'skill_files_remove',
      'Remove files from a skill. Use skill_view / skill_files_read first to confirm the exact paths.',
      {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id from skill_search.' },
          paths: {
            type: 'array',
            description: 'Relative paths to remove (max 100).',
            items: { type: 'string' },
          },
        },
        required: ['skill_id', 'paths'],
        additionalProperties: false,
      },
      async (args) => {
        const paths = (Array.isArray(args.paths) ? args.paths : []).filter((path): path is string => typeof path === 'string');
        const result = await client.filesRemove(str(args, 'skill_id'), paths);
        if (!result.ok) return failure('skill_files_remove', result.error, result.code);
        return 'removed ' + String(paths.length) + ' file(s) from ' + describe(result.data ?? {});
      },
    ),
  ];

  return [...readTools, ...writeTools];
}

/**
 * Module registration. Read tools always ship when the surface is on; the six
 * write tools need `skill.allowLlmWrite` — creating and deleting shared team
 * skills is a destructive capability, so it is opt-in and visible in Settings.
 */
registerToolModule({
  name: 'skills',
  enabled: (config) => config.skill.enabled,
  build: (deps) => {
    if (deps.skillClient === undefined) return [];
    const tools = buildSkillTools({
      client: deps.skillClient,
      config: { searchTopK: deps.config.skill.searchTopK, maxResultChars: deps.config.skill.maxResultChars },
      log: deps.log,
      sessionId: deps.sessionId,
    });
    const allowWrite = deps.config.skill.allowLlmWrite === true;
    return tools.filter((tool) => allowWrite || !WRITE_TOOL_NAMES.has(tool.name));
  },
});

/** The six tools that mutate shared state. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'skill_create',
  'skill_update',
  'skill_patch',
  'skill_delete',
  'skill_files_write',
  'skill_files_remove',
]);
