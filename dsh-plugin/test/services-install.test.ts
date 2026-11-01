import { describe, expect, it, vi } from 'vitest';
import { installServices, CONTROL_ROUTE_PREFIX } from '../src/services/install.js';
import { DEFAULT_CONFIG, type ServicesConfig } from '../src/config.js';
import type { AgememContext } from '../src/types.js';
import type { ServiceSupervisor } from '../src/services/supervisor.js';
import type { ControlServer } from '../src/services/control.js';

/** A loopback core: the case where this host does manage the stack. */
const LOOPBACK_CORE = 'http://127.0.0.1:8420';

function servicesConfig(overrides: Partial<ServicesConfig> = {}): ServicesConfig {
  return { ...DEFAULT_CONFIG.services, enabled: true, ...overrides };
}

function fakeCtx(options: { withInject?: boolean; withRegister?: boolean } = {}): {
  ctx: AgememContext;
  routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }>;
  effects: Array<() => void>;
} {
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
  const effects: Array<() => void> = [];
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    ...(options.withInject === false
      ? {}
      : {
          inject: (_deps: unknown, callback: (sub: unknown) => void) => {
            callback({
              // ctx.effect runs the factory immediately and keeps its disposer.
              effect: (factory: () => void | (() => void)) => {
                const disposer = factory();
                if (typeof disposer === 'function') effects.push(disposer);
              },
              ...(options.withRegister === false
                ? {}
                : {
                    webServer: {
                      register: (route: { path: string; handler: (req: unknown, res: unknown) => void }) => {
                        routes.push(route);
                        return () => undefined;
                      },
                    },
                  }),
            });
            return undefined;
          },
        }),
  } as unknown as AgememContext;
  return { ctx, routes, effects };
}

function fakeSupervisor(): ServiceSupervisor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: async () => {
      calls.push('start');
    },
    stop: async (reason?: string) => {
      calls.push('stop:' + String(reason));
    },
    restartOne: async (name: string) => ({ ok: true, restarting: name }),
    status: async () => ({
      hostPid: process.pid,
      enabled: true,
      running: true,
      startedAt: null,
      autoRestart: true,
      restartsUsed: 0,
      maxRestarts: 3,
      services: [],
      updatedAt: '2026-11-01T00:00:00.000Z',
    }),
    reapOrphans: async () => [],
    detach: async (reason?: string) => {
      calls.push('detach:' + String(reason));
    },
    whenIdle: async () => undefined,
    dispose: async () => {
      calls.push('dispose');
    },
  } as unknown as ServiceSupervisor & { calls: string[] };
}

describe('services install: wiring', () => {
  it('spawns nothing and opens no port when the feature is off, but still answers why', () => {
    const { ctx } = fakeCtx();
    const createSupervisor = vi.fn();
    const startControl = vi.fn();
    const result = installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig({ enabled: false }),
      ctx,
      disposers: [],
      createSupervisor: createSupervisor as never,
      startControl: startControl as never,
    });
    // Not undefined anymore: the settings page needs a reason, not a 404.
    expect(result.managed).toBe(false);
    expect(result.reason).toBe('disabled-by-config');
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(startControl).not.toHaveBeenCalled();
  });

  it('builds the supervisor from config and hands the state path to it', () => {
    const { ctx } = fakeCtx();
    const supervisor = fakeSupervisor();
    const createSupervisor = vi.fn(() => supervisor);
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig({ repoRoot: 'D:/repo/', runDir: 'D:/repo/data/run' }),
      ctx,
      disposers: [],
      createSupervisor: createSupervisor as never,
      startControl: (() => Promise.resolve(null)) as never,
    });
    const options = createSupervisor.mock.calls[0]![0] as {
      specs: Array<{ name: string; dir: string }>;
      statePath: string;
      nodePath: string;
      healthTimeoutMs: number;
    };
    expect(options.specs.map((spec) => spec.name)).toEqual(['tdai-core', 'tdai-knowledge', 'tdai-panel']);
    expect(options.specs[0]!.dir.split(/[\\/]/).join('/')).toBe('D:/repo/MemoryCore');
    // The state file is deliberately NOT the retired bundle's name: two owners
    // reading one state file is how a stack gets killed twice.
    expect(options.statePath.replaceAll('\\', '/')).toBe('D:/repo/data/run/tdb-services.state.json');
    expect(options.nodePath).not.toBe('');
    expect(options.healthTimeoutMs).toBe(DEFAULT_CONFIG.services.healthTimeoutMs);
  });

  it('honours an explicit statePath and control port', () => {
    const { ctx } = fakeCtx();
    const createSupervisor = vi.fn(() => fakeSupervisor());
    const startControl = vi.fn(() => Promise.resolve(null));
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig({ statePath: 'D:/state.json', controlPort: 9999 }),
      ctx,
      disposers: [],
      createSupervisor: createSupervisor as never,
      startControl: startControl as never,
    });
    expect((createSupervisor.mock.calls[0]![0] as { statePath: string }).statePath.split(/[\/]/).join('/')).toBe('D:/state.json');
    expect((startControl.mock.calls[0]![0] as { port: number }).port).toBe(9999);
  });

  it('registers the four same-origin routes under the retired prefix', () => {
    const { ctx, routes, effects } = fakeCtx();
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig(),
      ctx,
      disposers: [],
      createSupervisor: (() => fakeSupervisor()) as never,
      startControl: (() => Promise.resolve(null)) as never,
    });
    expect(routes.map((route) => route.path)).toEqual([
      CONTROL_ROUTE_PREFIX + '/status',
      CONTROL_ROUTE_PREFIX + '/start',
      CONTROL_ROUTE_PREFIX + '/stop',
      CONTROL_ROUTE_PREFIX + '/restart',
    ]);
    // Registered through ctx.effect: the routes must disappear with the fiber.
    expect(effects).toHaveLength(4);
  });

  it('still installs when the host has no webServer or no inject at all', () => {
    for (const options of [{ withRegister: false }, { withInject: false }]) {
      const { ctx } = fakeCtx(options);
      const result = installServices({
      coreBaseUrl: LOOPBACK_CORE,
        config: servicesConfig(),
        ctx,
        disposers: [],
        createSupervisor: (() => fakeSupervisor()) as never,
        startControl: (() => Promise.resolve(null)) as never,
      });
      // The loopback control server is the fallback, so the install must survive.
      expect(result?.enabled).toBe(true);
    }
  });

  it('starts the stack fail-open: a supervisor that throws does not reject the install', () => {
    const { ctx } = fakeCtx();
    const supervisor = fakeSupervisor();
    (supervisor as unknown as { start: () => Promise<void> }).start = async () => {
      throw new Error('stack did not come up');
    };
    const warnings: string[] = [];
    const result = installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig(),
      ctx,
      log: { warn: (message: string) => warnings.push(message) },
      disposers: [],
      createSupervisor: (() => supervisor) as never,
      startControl: (() => Promise.resolve(null)) as never,
    });
    expect(result).toBeDefined();
    return Promise.resolve().then(() => {
      expect(warnings.join('\n')).toContain('stack failed to start');
    });
  });

  it('stops on dispose by default, and only detaches when stopOnDispose is off', async () => {
    const stopCase = (() => {
      const { ctx } = fakeCtx();
      const supervisor = fakeSupervisor();
      const disposers: Array<() => void> = [];
      installServices({
      coreBaseUrl: LOOPBACK_CORE,
        config: servicesConfig(),
        ctx,
        disposers,
        createSupervisor: (() => supervisor) as never,
        startControl: (() => Promise.resolve({ port: 1, close: async () => undefined })) as never,
      });
      return { supervisor, disposers };
    })();
    for (const dispose of stopCase.disposers) dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopCase.supervisor.calls.some((call) => call.startsWith('stop:'))).toBe(true);

    const detachCase = (() => {
      const { ctx } = fakeCtx();
      const supervisor = fakeSupervisor();
      const disposers: Array<() => void> = [];
      installServices({
      coreBaseUrl: LOOPBACK_CORE,
        config: servicesConfig({ stopOnDispose: false }),
        ctx,
        disposers,
        createSupervisor: (() => supervisor) as never,
        startControl: (() => Promise.resolve({ port: 1, close: async () => undefined }) as unknown as Promise<ControlServer>) as never,
      });
      return { supervisor, disposers };
    })();
    for (const dispose of detachCase.disposers) dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(detachCase.supervisor.calls.some((call) => call.startsWith('detach:'))).toBe(true);
  });

  it('closes the control server on dispose, and survives one that never bound', async () => {
    const { ctx } = fakeCtx();
    const close = vi.fn(async () => undefined);
    const disposers: Array<() => void> = [];
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig(),
      ctx,
      disposers,
      createSupervisor: (() => fakeSupervisor()) as never,
      startControl: (() => Promise.resolve({ port: 8444, close })) as never,
    });
    for (const dispose of disposers) dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);

    const { ctx: ctx2 } = fakeCtx();
    const disposers2: Array<() => void> = [];
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig(),
      ctx: ctx2,
      disposers: disposers2,
      createSupervisor: (() => fakeSupervisor()) as never,
      startControl: (() => Promise.resolve(null)) as never,
    });
    expect(() => {
      for (const dispose of disposers2) dispose();
    }).not.toThrow();
  });

  it('spawns nothing at all when the configured core is on another machine', () => {
    const { ctx, routes } = fakeCtx();
    const createSupervisor = vi.fn();
    const startControl = vi.fn();
    const warnings: string[] = [];
    const result = installServices({
      coreBaseUrl: 'http://10.16.235.171:8420',
      config: servicesConfig(),
      ctx,
      log: { warn: (message: string) => warnings.push(message) },
      disposers: [],
      createSupervisor: createSupervisor as never,
      startControl: startControl as never,
    });
    // The whole point: a remote core means somebody else owns the stack.
    expect(result.managed).toBe(false);
    expect(result.reason).toBe('remote-core');
    expect(result.specs).toEqual([]);
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(startControl).not.toHaveBeenCalled();
    expect(warnings.join(String.fromCharCode(10))).toContain('10.16.235.171');
    // The page still gets an answer, with the reason instead of a 404.
    expect(routes.map((route) => route.path)).toEqual([
      CONTROL_ROUTE_PREFIX + '/status',
      CONTROL_ROUTE_PREFIX + '/start',
      CONTROL_ROUTE_PREFIX + '/stop',
      CONTROL_ROUTE_PREFIX + '/restart',
    ]);
  });

  it('manages only the services listed in include (core here, wiki elsewhere)', () => {
    const { ctx } = fakeCtx();
    const createSupervisor = vi.fn(() => fakeSupervisor());
    installServices({
      coreBaseUrl: LOOPBACK_CORE,
      config: servicesConfig({ include: 'tdai-core,tdai-panel' }),
      ctx,
      disposers: [],
      createSupervisor: createSupervisor as never,
      startControl: (() => Promise.resolve(null)) as never,
    });
    const options = createSupervisor.mock.calls[0]![0] as { specs: Array<{ name: string }> };
    expect(options.specs.map((spec) => spec.name)).toEqual(['tdai-core', 'tdai-panel']);
  });
});