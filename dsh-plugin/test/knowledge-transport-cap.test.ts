import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_ALLOWED_SCHEMES,
  defaultKnowledgeRequest,
  describeKnowledgeDiagnostic,
  executeKnowledgeTool,
  fetchKnowledgeSegment,
  isAllowedKnowledgeServiceUrl,
  selectKnowledgeResources,
  type KnowledgeCoreCaller,
  type KnowledgeHttpRequest,
} from '../src/knowledge-segment.js';
import { createSegmentHealth } from '../src/segment-health.js';

const SAFE = {
  knowledge_id: 'wiki-m6c41uvc',
  type: 'wiki',
  service_url: 'http://127.0.0.1:8421/v3/',
  name: 'scm-standards',
  summary: '供应链开发规范知识库。',
  status: 'ready',
};

function unsafe(serviceUrl: string, knowledgeId = 'evil'): Record<string, unknown> {
  return { knowledge_id: knowledgeId, type: 'wiki', service_url: serviceUrl, name: 'evil', summary: '' };
}

function countingFetch(reply: () => Response | Promise<Response>): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return reply();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('task-101 scheme gate (service_url is attacker-influenced data)', () => {
  it('allows only http(s) and refuses everything else outright', () => {
    expect(KNOWLEDGE_ALLOWED_SCHEMES).toEqual(['http:', 'https:']);
    for (const good of ['http://127.0.0.1:8421/v3', 'https://kb.example.com/v3', 'HTTP://x/v3']) {
      expect(isAllowedKnowledgeServiceUrl(good)).toBe(true);
    }
    for (const bad of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'ftp://h/v3', '/relative/v3', '', '   ', 'not a url']) {
      expect(isAllowedKnowledgeServiceUrl(bad)).toBe(false);
    }
  });

  it('drops unsafe rows at the data boundary and keeps a later callable duplicate', () => {
    const rejected: Array<{ knowledgeId: string; serviceUrl: string; reason: string }> = [];
    const picked = selectKnowledgeResources(
      [unsafe('file:///etc/passwd', 'wiki-a'), unsafe('data:text/plain,x', 'wiki-b'), SAFE, { ...SAFE }],
      8,
      (drop) => rejected.push(drop),
    );
    expect(picked.map((resource) => resource.knowledgeId)).toEqual(['wiki-m6c41uvc']);
    expect(rejected).toEqual([
      { knowledgeId: 'wiki-a', serviceUrl: 'file:///etc/passwd', reason: 'bad_scheme' },
      { knowledgeId: 'wiki-b', serviceUrl: 'data:text/plain,x', reason: 'bad_scheme' },
    ]);
  });

  it('reports a list made of unsafe rows as bad_scheme, not a bland empty_list', async () => {
    const call: KnowledgeCoreCaller = async () => ({ ok: true, data: { items: [unsafe('file:///etc/passwd')] } });
    const result = await fetchKnowledgeSegment({ call, identity: { teamId: 'team-2k12lgb650' } });
    expect(result.text).toBe('');
    expect(result.diagnostic.reason).toBe('bad_scheme');
    expect(result.diagnostic.rejected).toBe(1);
    expect(describeKnowledgeDiagnostic(result.diagnostic)).toContain('fail=bad_scheme reject=1');
  });

  it('names partial rejection in a successful block instead of hiding it', async () => {
    const call: KnowledgeCoreCaller = async () => ({ ok: true, data: { items: [unsafe('file:///x'), SAFE] } });
    const result = await fetchKnowledgeSegment({ call, identity: { teamId: 'team-2k12lgb650' }, maxChars: 3000 });
    expect(result.text).toContain('scm-standards');
    expect(result.diagnostic.ok).toBe(true);
    expect(result.diagnostic.rejected).toBe(1);
    expect(describeKnowledgeDiagnostic(result.diagnostic)).toContain('reject=1');
  });

  it('refuses to call a tool on an unsafe service_url with zero requests', async () => {
    const seen: string[] = [];
    const request: KnowledgeHttpRequest = async (url) => {
      seen.push(url);
      return { status: 200, json: { code: 0, data: {} } };
    };
    for (const url of ['file:///etc/passwd', 'data:text/plain,x', 'javascript:alert(1)']) {
      const result = await executeKnowledgeTool({ request, serviceUrl: url, knowledgeId: 'wiki-a', toolName: 'get_info' });
      expect(result.reason).toBe('bad_scheme');
      expect(result.ms).toBe(0);
    }
    expect(seen).toEqual([]);
  });

  it('the default transport never reaches fetch() for an unsafe URL', async () => {
    const stub = countingFetch(() => new Response('{"code":0,"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', stub.impl);
    const result = await executeKnowledgeTool({
      serviceUrl: 'file:///etc/passwd',
      knowledgeId: 'wiki-a',
      toolName: 'get_info',
    });
    expect(result.reason).toBe('bad_scheme');
    expect(stub.calls).toEqual([]);
  });
});

describe('task-101 response cap (the read is bounded, not read-then-measured)', () => {
  it('stops an oversized streaming body at the cap and calls it too_large', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 500) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const stub = countingFetch(() => new Response(stream, { status: 200, headers: new Headers() }));
    vi.stubGlobal('fetch', stub.impl);
    const result = await defaultKnowledgeRequest('http://127.0.0.1:8421/v3/tools/call', { x: 1 }, { timeoutMs: 500, maxBytes: 256 });
    expect(result).toEqual({ status: 0, error: 'too_large' });
    // The point of the cap: we never drained the 500-chunk stream.
    expect(pulled).toBeLessThan(50);
  });

  it('reports too_large as its own reason and counts it against the breaker', async () => {
    const request: KnowledgeHttpRequest = async () => ({ status: 0, error: 'too_large' });
    const health = createSegmentHealth({ name: 'knowledge-tools test', threshold: 2 });
    for (let i = 0; i < 2; i += 1) {
      const step = await executeKnowledgeTool({ request, serviceUrl: 'http://127.0.0.1:8421/v3', knowledgeId: 'k', toolName: 'get_info', health });
      expect(step.reason).toBe('too_large');
    }
    const blocked = await executeKnowledgeTool({ request, serviceUrl: 'http://127.0.0.1:8421/v3', knowledgeId: 'k', toolName: 'get_info', health });
    expect(blocked.reason).toBe('circuit_open');
    expect(blocked.health).toContain('open(too_large');
  });

  it('keeps bad_scheme, http_404 and circuit_open distinguishable on the same call path', async () => {
    const schemaCall = await executeKnowledgeTool({
      request: async () => ({ status: 200, json: { code: 0, data: {} } }),
      serviceUrl: 'file:///etc/passwd',
      knowledgeId: 'k',
      toolName: 'get_info',
    });
    const missing = await executeKnowledgeTool({
      request: async () => ({ status: 404 }),
      serviceUrl: 'http://127.0.0.1:8421/v3',
      knowledgeId: 'k',
      toolName: 'get_info',
    });
    const health = createSegmentHealth({ name: 'knowledge-tools test', threshold: 1 });
    health.recordFailure('http_404');
    const open = await executeKnowledgeTool({
      request: async () => ({ status: 200, json: { code: 0, data: {} } }),
      serviceUrl: 'http://127.0.0.1:8421/v3',
      knowledgeId: 'k',
      toolName: 'get_info',
      health,
    });
    expect([schemaCall.reason, missing.reason, open.reason]).toEqual(['bad_scheme', 'http_404', 'circuit_open']);
  });

  it('wraps the breaker OUTSIDE the capped fetch: after 3 failures fetch is never called again', async () => {
    const stub = countingFetch(() => new Response('{"code":1,"message":"boom"}', { status: 200 }));
    vi.stubGlobal('fetch', stub.impl);
    const health = createSegmentHealth({ name: 'knowledge-tools test', threshold: 3 });
    const deps = {
      serviceUrl: 'http://127.0.0.1:8421/v3',
      knowledgeId: 'wiki-a',
      toolName: 'get_info',
      health,
    };
    for (let i = 0; i < 3; i += 1) {
      const step = await executeKnowledgeTool(deps);
      expect(step.reason).toBe('bad_envelope');
    }
    expect(stub.calls).toHaveLength(3);
    const blocked = await executeKnowledgeTool(deps);
    expect(blocked.reason).toBe('circuit_open');
    expect(stub.calls).toHaveLength(3);
  });

  it('maps a non-JSON 200 to bad_payload and a real 4xx to http_<status>', async () => {
    const notJson = countingFetch(() => new Response('<html>proxy error</html>', { status: 200 }));
    vi.stubGlobal('fetch', notJson.impl);
    const first = await executeKnowledgeTool({ serviceUrl: 'http://127.0.0.1:8421/v3', knowledgeId: 'k', toolName: 'get_info' });
    expect(first.reason).toBe('bad_payload');
    const notFound = countingFetch(() => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', notFound.impl);
    const second = await executeKnowledgeTool({ serviceUrl: 'http://127.0.0.1:8421/v3', knowledgeId: 'k', toolName: 'get_info' });
    expect(second.reason).toBe('http_404');
  });
});
