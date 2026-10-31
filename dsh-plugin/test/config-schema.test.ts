import { describe as describeGroup, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  SECRET_PATHS,
  VOLATILE_PATHS,
  buildPluginConfigSchema,
  isVolatileRef,
  resolvePluginConfig,
  unwrapVolatile,
} from '../src/config-schema.js';

/** Minimal Schemastery stand-in: records the declaration instead of resolving it. */
interface StubNode {
  type: 'object' | 'any';
  dict?: Record<string, StubNode>;
  meta: { default?: unknown; volatile?: boolean; role?: string; description?: string };
  default(value: unknown): StubNode;
  volatile(): StubNode;
  role(role: string): StubNode;
  description(text: string): StubNode;
}

function createStubZ(): { any(): StubNode; object(dict: Record<string, StubNode>): StubNode } {
  const make = (type: 'object' | 'any'): StubNode => {
    const node = {
      type,
      meta: {},
      default(value: unknown) {
        node.meta.default = value;
        return node;
      },
      volatile() {
        node.meta.volatile = true;
        return node;
      },
      role(role: string) {
        node.meta.role = role;
        return node;
      },
      description(text: string) {
        node.meta.description = text;
        return node;
      },
    } as StubNode;
    return node;
  };
  return {
    any: () => make('any'),
    object: (dict) => {
      const node = make('object');
      node.dict = dict;
      return node;
    },
  };
}

function flatten(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [path];
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return [path];
  return keys.flatMap((key) => flatten((value as Record<string, unknown>)[key], path === '' ? key : path + '.' + key));
}

function walk(node: StubNode, path = ''): { path: string; node: StubNode }[] {
  if (node.type !== 'object' || node.dict === undefined) return [{ path, node }];
  return Object.entries(node.dict).flatMap(([key, child]) => walk(child, path === '' ? key : path + '.' + key));
}

const schema = buildPluginConfigSchema(createStubZ()) as unknown as StubNode;
const leaves = walk(schema);

describeGroup('Config schema shape', () => {
  it('declares exactly the DEFAULT_CONFIG leaves (no drift in either direction)', () => {
    const declared = leaves.map((row) => row.path).sort();
    const actual = flatten(DEFAULT_CONFIG).sort();
    expect(declared).toEqual(actual);
  });

  it('gives every leaf the current default value', () => {
    const byPath = new Map(leaves.map((row) => [row.path, row.node]));
    for (const path of flatten(DEFAULT_CONFIG)) {
      const expected = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], DEFAULT_CONFIG);
      expect(byPath.get(path)?.meta.default, path).toEqual(expected);
    }
  });

  it('exposes the agreed volatile paths and marks no other field volatile', () => {
    const volatile = leaves.filter((row) => row.node.meta.volatile === true).map((row) => row.path).sort();
    expect(volatile).toEqual([...VOLATILE_PATHS].sort());
    // 15 -> 18: the soul slice (volatile.soul.enabled / maxChars / includeFeeling)
    // joined the form when the persona fragments became injectable (task-61).
    // 18 -> 21: the skill surface (skill.enabled / allowLlmWrite / headPackChars)
    // joined when the skill listing and its ten tools shipped (task-72).
    // 21 -> 25: the wiki/knowledge segments' enable+ceiling pairs.
    expect(volatile).toHaveLength(25);
  });

  it('keeps the two secrets out of the form: role=secret and NOT volatile', () => {
    const byPath = new Map(leaves.map((row) => [row.path, row.node]));
    for (const path of SECRET_PATHS) {
      const node = byPath.get(path);
      expect(node, path).toBeDefined();
      expect(node?.meta.role, path).toBe('secret');
      expect(node?.meta.volatile, path).toBeUndefined();
    }
    const secrets = leaves.filter((row) => row.node.meta.role === 'secret').map((row) => row.path).sort();
    expect(secrets).toEqual([...SECRET_PATHS].sort());
  });

  it('never nests a volatile field inside another volatile field (host constraint)', () => {
    // schemastery: "volatile fields require a fixed object path without an enclosing volatile field"
    for (const row of leaves) {
      const ancestors = row.path.split('.').slice(0, -1);
      for (let index = 1; index <= ancestors.length; index += 1) {
        const prefix = ancestors.slice(0, index).join('.');
        const ancestor = leaves.find((candidate) => candidate.path === prefix);
        expect(ancestor?.node.meta.volatile, prefix + ' -> ' + row.path).toBeUndefined();
      }
    }
  });

  it('describes every volatile field so a generic renderer has a label', () => {
    for (const path of VOLATILE_PATHS) {
      const row = leaves.find((candidate) => candidate.path === path);
      expect(typeof row?.node.meta.description, path).toBe('string');
      expect((row?.node.meta.description ?? '').length, path).toBeGreaterThan(10);
    }
  });
});

/** A cosmokit volatile reference, as schemastery produces for a volatile leaf. */
function volatileRef<T>(initial: T): { get(): T; [key: symbol]: unknown } {
  let current = initial;
  return {
    get: () => current,
    [Symbol.for('cosmokit.volatile.write')]: (next: T) => {
      current = next;
    },
  };
}

describeGroup('volatile unwrapping', () => {
  it('recognises a cosmokit volatile reference and rejects plain values', () => {
    expect(isVolatileRef(volatileRef('x'))).toBe(true);
    expect(isVolatileRef({ get: () => 'x' })).toBe(false);
    expect(isVolatileRef('x')).toBe(false);
    expect(isVolatileRef(null)).toBe(false);
  });

  it('flattens references nested in the config object', () => {
    const raw = {
      enabled: volatileRef(true),
      server: { teamId: volatileRef('team-42'), baseUrl: volatileRef('http://x:1'), requestTimeoutMs: 1234 },
    };
    const unwrapped = unwrapVolatile(raw) as Record<string, any>;
    expect(unwrapped.enabled).toBe(true);
    expect(unwrapped.server.teamId).toBe('team-42');
    expect(unwrapped.server.baseUrl).toBe('http://x:1');
    expect(unwrapped.server.requestTimeoutMs).toBe(1234);
  });

  it('resolvePluginConfig applies the values the form wrote instead of falling back to defaults', () => {
    // Regression guard: without unwrapping, a Volatile object is not a string, so
    // normalizeConfig silently replaced every edited field with DEFAULT_CONFIG.
    const raw = {
      enabled: volatileRef(false),
      server: {
        baseUrl: volatileRef('http://10.0.0.9:8420'),
        serviceId: volatileRef('custom-svc'),
        teamId: volatileRef('team-form'),
        agentId: volatileRef('agent-form'),
        userId: volatileRef('user-form'),
        apiKeyRef: volatileRef('MY_KEY_REF'),
        userKeyRef: volatileRef('MY_USER_KEY_REF'),
      },
      writeback: { enabled: volatileRef(false), skillFeed: volatileRef(false) },
      volatile: { enabled: volatileRef(false), maxChars: volatileRef(777) },
      tools: { enabled: volatileRef(false), recall: volatileRef(false) },
      debug: volatileRef(true),
    };
    const { config } = resolvePluginConfig(raw);
    expect(config.enabled).toBe(false);
    expect(config.server.baseUrl).toBe('http://10.0.0.9:8420');
    expect(config.server.serviceId).toBe('custom-svc');
    expect(config.server.teamId).toBe('team-form');
    expect(config.server.agentId).toBe('agent-form');
    expect(config.server.userId).toBe('user-form');
    expect(config.server.apiKeyRef).toBe('MY_KEY_REF');
    expect(config.server.userKeyRef).toBe('MY_USER_KEY_REF');
    expect(config.writeback.enabled).toBe(false);
    expect(config.writeback.skillFeed).toBe(false);
    expect(config.volatile.enabled).toBe(false);
    expect(config.volatile.maxChars).toBe(777);
    expect(config.tools.enabled).toBe(false);
    expect(config.tools.recall).toBe(false);
    expect(config.debug).toBe(true);
  });

  it('is a no-op for a plain (non-volatile) host', () => {
    const raw = { server: { teamId: 'plain-team' }, debug: false };
    const { config } = resolvePluginConfig(raw);
    expect(config.server.teamId).toBe('plain-team');
    expect(config.debug).toBe(false);
    expect(config.server.baseUrl).toBe(DEFAULT_CONFIG.server.baseUrl);
  });
});

/**
 * Optional integration check against the real library, when this machine has a
 * host install. Skipped elsewhere on purpose: the package is a host peer and is
 * not installed in the repository.
 */
const SCHEMASTER_PATH = process.env.DSH_SCHEMASTER_PATH
  ?? 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery';
const realAvailable = existsSync(SCHEMASTER_PATH);

describeGroup.skipIf(!realAvailable)('real schemastery integration', () => {
  it('accepts the declaration, wraps volatile leaves and unwraps them back', async () => {
    const require = createRequire(import.meta.url);
    const z = require(SCHEMASTER_PATH);
    const realSchema = buildPluginConfigSchema(z) as unknown as (data: unknown) => unknown;
    const resolved = realSchema({
      enabled: false,
      server: { teamId: 'team-real', apiKey: 'sk-secret' },
    }) as Record<string, any>;
    expect(isVolatileRef(resolved.enabled)).toBe(true);
    expect(isVolatileRef(resolved.server.teamId)).toBe(true);
    const { config } = resolvePluginConfig(resolved);
    expect(config.enabled).toBe(false);
    expect(config.server.teamId).toBe('team-real');
    expect(config.server.apiKey).toBe('sk-secret');
  });

  it('stays fail-open: a wrong-typed field does not throw (that is why leaves are z.any())', async () => {
    const require = createRequire(import.meta.url);
    const z = require(SCHEMASTER_PATH);
    const realSchema = buildPluginConfigSchema(z) as unknown as (data: unknown) => unknown;
    const { config } = resolvePluginConfig(
      realSchema({ enabled: 'yes', volatile: { maxChars: 'nope' }, debug: 0 }),
    );
    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(config.volatile.maxChars).toBe(DEFAULT_CONFIG.volatile.maxChars);
  });
});
