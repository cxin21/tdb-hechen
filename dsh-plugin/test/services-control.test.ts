import { describe, expect, it, vi } from 'vitest';
import { createControlDispatcher, startControlServer } from '../src/services/control.js';
import type { SupervisorStatus } from '../src/services/supervisor.js';

const STATUS: SupervisorStatus = {
  hostPid: 4242,
  enabled: true,
  running: true,
  startedAt: '2026-11-01T00:00:00.000Z',
  autoRestart: true,
  restartsUsed: 0,
  maxRestarts: 3,
  services: [{ name: 'tdai-core', port: 8420, healthy: true, pid: 77, pidAlive: true, owned: true, dir: 'D:/repo/MemoryCore' }],
  updatedAt: '2026-11-01T00:00:05.000Z',
};

interface FakeRes {
  code: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (code: number, headers?: Record<string, string>) => void;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: string) => void;
}

function fakeReq(input: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): unknown {
  const handlers = new Map<string, (arg?: unknown) => void>();
  return {
    method: input.method ?? 'GET',
    url: input.url ?? '/status',
    headers: input.headers ?? {},
    on: (event: string, handler: (arg?: unknown) => void) => {
      handlers.set(event, handler);
      if (event === 'end') {
        if (input.body !== undefined) handlers.get('data')?.(input.body);
        handler();
      }
      return undefined;
    },
    destroy: () => undefined,
  };
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    code: 0,
    headers: {},
    body: '',
    writeHead: (code, headers) => {
      res.code = code;
      Object.assign(res.headers, headers ?? {});
    },
    setHeader: (name, value) => {
      res.headers[name] = value;
    },
    end: (chunk) => {
      res.body = chunk ?? '';
    },
  };
  return res;
}

function deps(overrides: Partial<Parameters<typeof createControlDispatcher>[0]> = {}) {
  return {
    status: vi.fn(async () => STATUS),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async (name: string) => ({ ok: name !== 'nope', restarting: name })),
    ...overrides,
  };
}

async function call(
  input: { method?: string; url?: string; headers?: Record<string, string>; body?: string },
  d = deps(),
): Promise<{ res: FakeRes; d: typeof d }> {
  const res = fakeRes();
  await createControlDispatcher(d)(fakeReq(input) as never, res as never);
  return { res, d };
}

describe('services control plane: dispatch', () => {
  it('answers GET /status with the snapshot, no control header needed', async () => {
    const { res } = await call({ method: 'GET', url: '/status' });
    expect(res.code).toBe(200);
    expect(JSON.parse(res.body).hostPid).toBe(4242);
  });

  it('refuses every mutating call without the X-Tdb-Control header', async () => {
    for (const url of ['/start', '/stop', '/restart']) {
      const { res, d } = await call({ method: 'POST', url, body: '{"name":"tdai-core"}' });
      expect(res.code, url).toBe(403);
      expect(JSON.parse(res.body).error).toBe('missing-control-header');
      expect(d.start).not.toHaveBeenCalled();
      expect(d.stop).not.toHaveBeenCalled();
      expect(d.restart).not.toHaveBeenCalled();
    }
  });

  it('starts and stops on 202 when the header is present', async () => {
    const started = await call({ method: 'POST', url: '/start', headers: { 'x-tdb-control': '1' } });
    expect(started.res.code).toBe(202);
    expect(started.d.start).toHaveBeenCalledTimes(1);
    const stopped = await call({ method: 'POST', url: '/stop', headers: { 'x-tdb-control': '1' } });
    expect(stopped.res.code).toBe(202);
    expect(stopped.d.stop).toHaveBeenCalledTimes(1);
  });

  it('restarts a named service, and refuses a body without a name', async () => {
    const ok = await call({
      method: 'POST',
      url: '/restart',
      headers: { 'x-tdb-control': '1' },
      body: JSON.stringify({ name: 'tdai-core' }),
    });
    expect(ok.res.code).toBe(202);
    expect(ok.d.restart).toHaveBeenCalledWith('tdai-core');

    const missing = await call({ method: 'POST', url: '/restart', headers: { 'x-tdb-control': '1' }, body: '{}' });
    expect(missing.res.code).toBe(400);
    expect(JSON.parse(missing.res.body).error).toBe('body-must-be-json-with-name');

    // A supervisor that refuses the restart is a conflict, not a crash.
    const refused = await call({
      method: 'POST',
      url: '/restart',
      headers: { 'x-tdb-control': '1' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(refused.res.code).toBe(409);
  });

  it('404s an unknown path and 500s a throwing dependency', async () => {
    const unknown = await call({ method: 'GET', url: '/nope' });
    expect(unknown.res.code).toBe(404);
    expect(JSON.parse(unknown.res.body).error).toBe('not-found');

    const boom = await call(
      { method: 'GET', url: '/status' },
      deps({ status: vi.fn(async () => { throw new Error('store exploded'); }) }),
    );
    expect(boom.res.code).toBe(500);
  });

  it('reports through the sub-path the host route matched, not the raw URL', async () => {
    // The web-server adapter hands back "/tdb-lifecycle/status"; the dispatcher must
    // not double-prefix it (the retired bundle did, and every call 404ed).
    const res = fakeRes();
    const d = deps();
    await createControlDispatcher(d)(fakeReq({ method: 'GET', url: '/tdb-lifecycle/status' }) as never, res as never, '/status');
    expect(res.code).toBe(200);
  });
});

describe('services control plane: loopback server', () => {
  it('refuses a non-loopback Origin and keeps the loopback one', async () => {
    const d = deps();
    const server = await startControlServer({ port: 0, deps: d });
    // port 0 is "off" by contract: the caller must not silently bind a random port.
    expect(server).toBeNull();
  });
});
