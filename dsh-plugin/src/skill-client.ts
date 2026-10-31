import type { LoggerLike } from './types.js';

/**
 * Client for the core's skill surface (`/v3/skill/*`).
 *
 * Why this exists: MemoryCore ships a "skill tools" injector that hands the
 * model ten tools, but every write tool in it is broken — the request schemas
 * (MemoryCore/src/gateway/skill-schemas.ts:101/:108/:117/:182/:189) require an
 * `expected_version`, and `skill-tools-injector.ts:108-144` never sends one, so
 * create/update/patch/delete/files-* answer HTTP 200 + business code 40001 and
 * `allowLlmWrite` is decorative. The model cannot be asked to read a version
 * first and pass it back — that is plumbing, not reasoning — so every write here
 * is a READ-MODIFY-WRITE: fetch the current version, send it, and on a stale
 * version (40901) re-read and retry exactly once.
 *
 * The transport is injected (`call`), which is MemoryClient's `v3()` seam, so
 * this module keeps the identity headers, timeout and envelope unwrapping in one
 * place and stays unit-testable without a host or a core.
 */

/** Result of one v3 envelope call (subset of MemoryClient's shape). */
export interface SkillCallResult<T> {
  ok: boolean;
  status?: number;
  reason?: string;
  data?: T;
  code?: number;
  message?: string;
}

export type SkillCaller = <T>(
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<SkillCallResult<T>>;

export interface SkillClientDeps {
  call: SkillCaller;
  /** Default per-call budget, from `skill.timeoutMs`. */
  timeoutMs: number;
  log?: LoggerLike;
}

/** Normalized outcome: `error` is always the core's own words when it had any. */
export interface SkillOutcome<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Envelope business code (40001/40401/40901/42201/4291/50301…). */
  code?: number;
  /** HTTP status, when the failure was transport-level. */
  status?: number;
}

/** One head of a skill, as the core serializes it (skill-handlers.ts:toSummary). */
export interface SkillRecord {
  skill_id?: string;
  name?: string;
  description?: string;
  version?: number;
  is_head?: boolean;
  status?: string;
  owner_user_id?: string;
  owner_agent_id?: string;
  team_id?: string;
  task_id?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  content_hash?: string;
  content?: string;
  manifest?: unknown;
  [key: string]: unknown;
}

export interface SkillSearchItem extends SkillRecord {
  score?: number;
  snippet?: string;
}

export interface SkillListingHit {
  skill_id?: string;
  version?: number;
  name?: string;
}

export interface SkillListing {
  /** The rendered `<available_skills>…</available_skills>` block, verbatim. */
  listing: string;
  /** Fixed-size name index the core sends beside the rendered block. */
  hits: SkillListingHit[];
  truncated: boolean;
}

export interface SkillFileRead {
  path: string;
  content: string;
  encoding: string;
  size_bytes?: number;
  mime_type?: string;
  version?: number;
}

export interface SkillFileWrite {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export const SKILL_ROUTES = {
  create: '/v3/skill/create',
  update: '/v3/skill/update',
  patch: '/v3/skill/patch',
  delete: '/v3/skill/delete',
  get: '/v3/skill/get',
  getByName: '/v3/skill/get-by-name',
  list: '/v3/skill/list',
  search: '/v3/skill/search',
  versions: '/v3/skill/versions',
  filesWrite: '/v3/skill/files/write',
  filesRemove: '/v3/skill/files/remove',
  filesRead: '/v3/skill/files/read',
  export: '/v3/skill/export',
  listing: '/v3/skill/listing',
  extract: '/v3/skill/extract',
  conversationAdd: '/v3/skill/conversation/add',
  forceArchive: '/v3/skill/conversation/force-archive',
} as const;

/** SKILL_VERSION_STALE: the version we sent is no longer the head. */
const STALE_VERSION_CODE = 40901;

export class SkillClient {
  constructor(private readonly deps: SkillClientDeps) {}

  private get timeoutMs(): number {
    const value = this.deps.timeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 2500;
  }

  /** One call, normalized. Never throws. */
  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<SkillOutcome<T>> {
    try {
      const result = await this.deps.call<T>(path, body, { timeoutMs: timeoutMs ?? this.timeoutMs });
      if (result.ok) return { ok: true, data: result.data };
      return {
        ok: false,
        code: result.code,
        status: result.status,
        // Prefer the core's message: it carries the rule that was broken.
        error: result.message ?? result.reason ?? 'skill request failed',
      };
    } catch (error) {
      this.deps.log?.debug?.(`agemem: ${path} threw`, error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** `/v3/skill/listing`: the model-ready `<available_skills>` block. */
  async listing(charBudget?: number): Promise<SkillOutcome<SkillListing>> {
    const body: Record<string, unknown> = {};
    if (typeof charBudget === 'number' && Number.isFinite(charBudget) && charBudget >= 0) {
      body.char_budget = Math.min(64000, Math.floor(charBudget));
    }
    const res = await this.post<{ listing?: unknown; hits?: unknown; truncated?: unknown }>(SKILL_ROUTES.listing, body);
    if (!res.ok) return { ok: false, code: res.code, status: res.status, error: res.error };
    const data = res.data ?? {};
    const hits = Array.isArray(data.hits)
      ? (data.hits as SkillListingHit[]).filter((hit) => hit !== null && typeof hit === 'object')
      : [];
    return {
      ok: true,
      data: {
        listing: typeof data.listing === 'string' ? data.listing : '',
        hits,
        truncated: data.truncated === true,
      },
    };
  }

  /** `/v3/skill/search`: team-scoped retrieval over skill heads. */
  async search(query: string, topK?: number): Promise<SkillOutcome<SkillSearchItem[]>> {
    const trimmed = query.trim();
    if (trimmed === '') return { ok: false, error: 'empty query' };
    const body: Record<string, unknown> = { query: trimmed };
    if (typeof topK === 'number' && Number.isFinite(topK)) body.top_k = Math.min(50, Math.max(1, Math.floor(topK)));
    const res = await this.post<{ items?: unknown }>(SKILL_ROUTES.search, body);
    if (!res.ok) return { ok: false, code: res.code, status: res.status, error: res.error };
    const items = Array.isArray(res.data?.items) ? (res.data.items as SkillSearchItem[]) : [];
    return { ok: true, data: items.filter((item) => item !== null && typeof item === 'object') };
  }

  /** `/v3/skill/get` by id. `include` decides whether the body comes along. */
  async get(
    skillId: string,
    options: { includeContent?: boolean; includeManifest?: boolean; version?: number } = {},
  ): Promise<SkillOutcome<SkillRecord>> {
    if (skillId.trim() === '') return { ok: false, error: 'empty skill_id' };
    const body: Record<string, unknown> = { skill_id: skillId };
    if (options.includeContent !== undefined) body.include_content = options.includeContent;
    if (options.includeManifest !== undefined) body.include_manifest = options.includeManifest;
    if (typeof options.version === 'number' && Number.isFinite(options.version)) body.version = Math.floor(options.version);
    return this.post<SkillRecord>(SKILL_ROUTES.get, body);
  }

  /**
   * `/v3/skill/get-by-name`. The three-axis ids must be in the BODY: this
   * schema has no header merge, so an isolated (headers-only) call answers 40001.
   * MemoryClient.v3() echoes the isolation triple into every body by default,
   * which is exactly what this route needs.
   */
  async getByName(
    name: string,
    options: { includeContent?: boolean; includeManifest?: boolean; version?: number } = {},
  ): Promise<SkillOutcome<SkillRecord>> {
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, error: 'empty skill name' };
    const body: Record<string, unknown> = { skill_name: trimmed };
    if (options.includeContent !== undefined) body.include_content = options.includeContent;
    if (options.includeManifest !== undefined) body.include_manifest = options.includeManifest;
    if (typeof options.version === 'number' && Number.isFinite(options.version)) body.version = Math.floor(options.version);
    return this.post<SkillRecord>(SKILL_ROUTES.getByName, body);
  }

  /** `/v3/skill/files/read`: one file out of a skill version. */
  async filesRead(
    skillId: string,
    path: string,
    options: { encoding?: 'utf-8' | 'base64'; version?: number } = {},
  ): Promise<SkillOutcome<SkillFileRead>> {
    if (skillId.trim() === '') return { ok: false, error: 'empty skill_id' };
    if (path.trim() === '') return { ok: false, error: 'empty path' };
    const body: Record<string, unknown> = { skill_id: skillId, path };
    if (options.encoding !== undefined) body.encoding = options.encoding;
    if (typeof options.version === 'number' && Number.isFinite(options.version)) body.version = Math.floor(options.version);
    const res = await this.post<Record<string, unknown>>(SKILL_ROUTES.filesRead, body);
    if (!res.ok) return { ok: false, code: res.code, status: res.status, error: res.error };
    const data = res.data ?? {};
    return {
      ok: true,
      data: {
        path: typeof data.path === 'string' ? data.path : path,
        content: typeof data.content === 'string' ? data.content : '',
        encoding: typeof data.encoding === 'string' ? data.encoding : (options.encoding ?? 'utf-8'),
        size_bytes: typeof data.size_bytes === 'number' ? data.size_bytes : undefined,
        mime_type: typeof data.mime_type === 'string' ? data.mime_type : undefined,
        version: typeof data.version === 'number' ? data.version : undefined,
      },
    };
  }

  // ── writes (read-modify-write) ───────────────────────────────────────

  /** `/v3/skill/create`: no version to read first; the core mints v1. */
  async create(input: {
    name: string;
    content: string;
    resources?: Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64'; mime_type?: string; is_executable?: boolean }>;
    metadata?: Record<string, unknown>;
  }): Promise<SkillOutcome<SkillRecord>> {
    const name = input.name.trim();
    if (name === '') return { ok: false, error: 'empty skill name' };
    if (typeof input.content !== 'string' || input.content === '') return { ok: false, error: 'empty skill content' };
    if (name.length > 64) return { ok: false, error: 'skill name longer than 64 characters' };
    const body: Record<string, unknown> = { name, content: input.content };
    if (Array.isArray(input.resources) && input.resources.length > 0) body.resources = input.resources.slice(0, 100);
    if (input.metadata !== undefined) body.metadata = input.metadata;
    return this.post<SkillRecord>(SKILL_ROUTES.create, body);
  }

  /** Replace a skill's body. Version comes from a fresh read (see header). */
  async update(skillId: string, content: string): Promise<SkillOutcome<SkillRecord>> {
    if (typeof content !== 'string' || content === '') return { ok: false, error: 'empty skill content' };
    return this.writeWithVersion<SkillRecord>(SKILL_ROUTES.update, skillId, (version) => ({ skill_id: skillId, expected_version: version, content }));
  }

  /** Replace one literal span inside a skill's body. */
  async patch(
    skillId: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<SkillOutcome<SkillRecord>> {
    if (typeof oldString !== 'string' || oldString === '') return { ok: false, error: 'empty old_string' };
    return this.writeWithVersion<SkillRecord>(SKILL_ROUTES.patch, skillId, (version) => ({
      skill_id: skillId,
      expected_version: version,
      old_string: oldString,
      new_string: typeof newString === 'string' ? newString : '',
      ...(replaceAll ? { replace_all: true } : {}),
    }));
  }

  /** Delete a skill (archived, not shredded — the core keeps the version trail). */
  async delete(skillId: string): Promise<SkillOutcome<SkillRecord>> {
    return this.writeWithVersion<SkillRecord>(SKILL_ROUTES.delete, skillId, (version) => ({ skill_id: skillId, expected_version: version }));
  }

  /** Attach/replace files inside a skill version. */
  async filesWrite(skillId: string, files: SkillFileWrite[]): Promise<SkillOutcome<SkillRecord>> {
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) return { ok: false, error: 'empty files list' };
    if (list.length > 100) return { ok: false, error: 'more than 100 files in one call' };
    return this.writeWithVersion<SkillRecord>(SKILL_ROUTES.filesWrite, skillId, (version) => ({
      skill_id: skillId,
      expected_version: version,
      files: list,
    }));
  }

  /** Remove files from a skill version. */
  async filesRemove(skillId: string, paths: string[]): Promise<SkillOutcome<SkillRecord>> {
    const list = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path.trim() !== '') : [];
    if (list.length === 0) return { ok: false, error: 'empty paths list' };
    if (list.length > 100) return { ok: false, error: 'more than 100 paths in one call' };
    return this.writeWithVersion<SkillRecord>(SKILL_ROUTES.filesRemove, skillId, (version) => ({
      skill_id: skillId,
      expected_version: version,
      paths: list,
    }));
  }

  /**
   * Force-archive this session's skill buffer (the core's `/extract` sibling).
   *
   * Chosen over `/v3/skill/extract` because extract demands the message array
   * (1..500) and this plugin does not keep a server-side conversation buffer to
   * replay — the buffer lives in the core, keyed by session_id, which is exactly
   * what force-archive consumes. Returns 50301 when the core has no buffer
   * wired; that text is surfaced to the model verbatim.
   */
  async forceArchive(sessionId: string, reason?: string): Promise<SkillOutcome<Record<string, unknown>>> {
    const sid = sessionId.trim();
    if (sid === '') return { ok: false, error: 'no active session id' };
    const body: Record<string, unknown> = { session_id: sid };
    if (typeof reason === 'string' && reason.trim() !== '') body.reason = reason.trim().slice(0, 500);
    const res = await this.post<Record<string, unknown>>(SKILL_ROUTES.forceArchive, body);
    if (!res.ok) return { ok: false, code: res.code, status: res.status, error: res.error };
    return { ok: true, data: res.data ?? {} };
  }

  // ── version plumbing ─────────────────────────────────────────────────

  /** Read the head version a write must quote. */
  private async versionOf(skillId: string): Promise<SkillOutcome<number>> {
    const res = await this.get(skillId, { includeContent: false, includeManifest: false });
    if (!res.ok) return { ok: false, code: res.code, status: res.status, error: res.error };
    const version = Number(res.data?.version);
    if (!Number.isFinite(version) || version <= 0) {
      return { ok: false, error: 'core returned no usable version for ' + skillId };
    }
    return { ok: true, data: Math.floor(version) };
  }

  /**
   * Read the version, apply the write, and retry ONCE after re-reading when the
   * core reports SKILL_VERSION_STALE (40901). Two writers racing is normal in a
   * team; a third attempt would just be a loop, so the second failure is
   * returned as-is and the model sees the core's own message.
   */
  private async writeWithVersion<T>(
    path: string,
    skillId: string,
    build: (version: number) => Record<string, unknown>,
  ): Promise<SkillOutcome<T>> {
    const trimmed = typeof skillId === 'string' ? skillId.trim() : '';
    if (trimmed === '') return { ok: false, error: 'empty skill_id' };
    const first = await this.versionOf(trimmed);
    if (!first.ok) return { ok: false, code: first.code, status: first.status, error: first.error };
    const attempt = await this.post<T>(path, build(first.data as number));
    if (attempt.ok || attempt.code !== STALE_VERSION_CODE) return attempt;
    this.deps.log?.debug?.('agemem: skill write hit a stale version; re-reading once', { path: SKILL_ROUTES.get });
    const second = await this.versionOf(trimmed);
    if (!second.ok) return attempt;
    return this.post<T>(path, build(second.data as number));
  }
}
