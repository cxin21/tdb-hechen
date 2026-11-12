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
  /**
   * GET /v3/soul/card payload (persona card channel A). Omitted = an empty card,
   * i.e. "this Core has not set a persona layer" — the legacy soul path then
   * stays active, which is the pre-task-11 default every older test relies on.
   */
  card?: { version: number; hash: string; text: string; textHash?: string; chars?: number; dirty?: boolean } | null;
  /** GET /v3/soul/turn payload (per-turn mood + open loops + §6 运行时状态). */
  turn?: { text: string; openLoops?: string[]; state?: Record<string, unknown> } | null;
  /**
   * Per-user session_init params served by /v3/meta/config/user/get.
   * Omitted = empty item list = "not configured" = the plugin asks.
   */
  sessionInit?: Record<string, string>;
}

export function envelope(data: unknown, code = 0, message = 'ok'): Response {
  return new Response(JSON.stringify({ code, message, request_id: 'req-fixture', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function coreFixture(options: CoreFixtureOptions = {}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  /** /v3/soul/event 的幂等状态：dedupe_key → event_id（设备一次性，跨 case 不共享）。 */
  const soulEventIds = new Map<string, string>();
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
    if (path.endsWith('/v3/meta/config/user/get')) {
      const module = typeof body?.module === 'string' ? body.module : '';
      return envelope({
        user_id: body?.user_id,
        module,
        items: Object.entries(options.sessionInit ?? {}).map(([param_name, effective_value]) => ({
          module,
          param_name,
          param_key: module === '' ? param_name : `${module}.${param_name}`,
          description: '',
          effective_value,
        })),
      });
    }
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
    if (path.endsWith('/v3/soul/card')) {
      const card = options.card ?? null;
      return envelope(
        card === null
          ? { version: 0, hash: '', text: '', chars: 0, dirty: false }
          : {
            version: card.version,
            hash: card.hash,
            ...(card.textHash === undefined ? {} : { textHash: card.textHash }),
            text: card.text,
            chars: card.chars ?? card.text.length,
            dirty: card.dirty === true,
          },
      );
    }
    if (path.endsWith('/v3/soul/turn')) {
      return envelope(options.turn ?? { text: '', openLoops: [] });
    }
    if (path.endsWith('/v3/soul/gate')) {
      // P7 输出侧（soul-gate-endpoint.ts:294-314）：shadow 期 decision 恒 allow；
      // logged.inserted 对应 soul_gate_log 的一次新插行（Core 是 INSERT OR IGNORE，
      // 同一 digest 重放时为 false）。stage 原样回显，便于断言 body 确实带了它。
      const stage = typeof body?.stage === 'string' ? body.stage : 'output';
      return envelope({
        stage,
        decision: 'allow',
        shadow: true,
        wouldDecision: 'allow',
        matched: [],
        hits: [],
        conflict: false,
        digest: 'd'.repeat(64),
        logged: { inserted: true },
        dilemmaId: null,
      });
    }
    if (path.endsWith('/v3/scenario/ls')) {
      return envelope({ entries: options.scenarios ?? SCENARIO_ENTRIES });
    }
    if (path.endsWith('/v3/atomic/search')) {
      return envelope({ items: options.items ?? ATOMIC_ITEMS });
    }
    if (path.endsWith('/v3/soul/event')) {
      // P1-B W3: POST /v3/soul/event 按 dedupe_key 幂等 —— Core 先查后插，UNIQUE
      // 冲突也按 duplicate 应答。fixture 记住「键 → event_id」，第二次起
      // duplicate=true 且回同一个 id，测试才能断言「重投不新增一行」。
      const key = typeof body?.dedupe_key === 'string' ? body.dedupe_key : '';
      const known = soulEventIds.get(key);
      if (known !== undefined) return envelope({ event_id: known, duplicate: true });
      const eventId = 'evt-' + String(soulEventIds.size + 1);
      soulEventIds.set(key, eventId);
      return envelope({ event_id: eventId, duplicate: false });
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
