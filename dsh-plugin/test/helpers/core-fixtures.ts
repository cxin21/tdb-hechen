/**
 * Fixtures shaped like the live MemoryCore v3 responses (captured against
 * http://127.0.0.1:8420 — see docs/ops/dsh-plugin-probe-report.md). Tests use
 * these instead of invented shapes so a contract drift breaks the build.
 */

export const PERSONA =
  '# User Narrative Profile\n\n## 身份\n- 用户偏好简洁回答。\n\n## 工作方式\n- 喜欢先给结论，再给证据。';

export const SCENARIO_ENTRIES = [
  { path: 'scenes/deploy.md', summary: '部署流程' },
  { path: 'scenes/review.md', summary: '评审偏好' },
];

export const ATOMIC_ITEMS = [
  {
    id: 'mem-1',
    type: 'work_fact',
    content: '偏好 pnpm workspace，不喜欢 npm install。',
    score: 0.82,
    background: '',
    version: 2,
    created_at: '2026-10-20T08:00:00Z',
    updated_at: '2026-10-21T08:00:00Z',
    metadata: {},
    priority: 1,
  },
];

export interface RecordedCall {
  url: string;
  path: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

/**
 * Real /v3/recall block (captured 2026-11-01 against the live core): the
 * soul identity/feeling wrappers plus a <relevant-memories> section whose first
 * ~300 chars duplicate the answer-guidance section instead of carrying memory.
 */
export const RECALL_BLOCK = [
  '<soul-identity>你是用户的记忆助手。</soul-identity>',
  '<soul-feeling>保持简洁。</soul-feeling>',
  '<relevant-memories>',
  '【币值判定规则】',
  '【建议类问题口径】',
  '- [L1][work_fact] 偏好 pnpm workspace，不喜欢 npm install。（热度 3，更新 2026-10-21）',
  '- [L1][work_fact] 结论先行，证据随后。（热度 2，更新 2026-10-20）',
  '</relevant-memories>',
].join(String.fromCharCode(10));

export interface CoreFixtureOptions {
  persona?: string;
  scenarios?: Array<{ path?: string; summary?: string }>;
  items?: Array<Record<string, unknown>>;
  /**
   * Return a failure for a path instead of the canned success envelope. The
   * recorded call is passed too, so a test can emulate server-side contract
   * checks (e.g. "422 unless the isolation headers are present").
   */
  fail?: (path: string, call: RecordedCall) => Response | undefined;
  /** /v3/recall payload; defaults to RECALL_BLOCK. */
  recallBlock?: string;
}

export function envelope(data: unknown, code = 0, message = 'ok'): Response {
  return new Response(JSON.stringify({ code, message, request_id: 'req-fixture', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function coreFixture(options: CoreFixtureOptions = {}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      url,
      path,
      method: String(init.method ?? 'GET'),
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const failure = options.fail?.(path, calls[calls.length - 1]);
    if (failure) return failure;
    if (path.endsWith('/v3/core/read')) {
      return envelope({
        content: options.persona ?? PERSONA,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-31T00:00:00Z',
      });
    }
    if (path.endsWith('/v3/recall')) {
      // DS-RECALL-MERGE-001: merged block; meta mirrors the live response.
      return envelope({
        block: options.recallBlock ?? RECALL_BLOCK,
        meta: { conclusionCount: 1, experienceCount: 1, sessionReused: false, layered: 'L1', soulVersion: 1, perfMs: 170 },
      });
    }
    if (path.endsWith('/v3/scenario/ls')) {
      return envelope({ entries: options.scenarios ?? SCENARIO_ENTRIES });
    }
    if (path.endsWith('/v3/atomic/search')) {
      return envelope({ items: options.items ?? ATOMIC_ITEMS });
    }
    if (path.endsWith('/v3/skill/conversation/add')) {
      // L2 buffer: 'ok' until the threshold archives the buffer.
      return envelope({ status: 'ok' });
    }
    if (path.endsWith('/v3/conversation/add')) {
      return envelope({ accepted_ids: ['msg-1'], accepted_versions: [1], total_count: 2 });
    }
    if (path.endsWith('/v3/conversation/delete')) {
      return envelope({ deleted: 1 });
    }
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export function callsTo(calls: RecordedCall[], suffix: string): RecordedCall[] {
  return calls.filter((call) => call.path.endsWith(suffix));
}

export function textOfBodies(calls: RecordedCall[], suffix: string): any[] {
  return callsTo(calls, suffix).map((call) => call.body);
}
