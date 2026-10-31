/**
 * Test stand-in for the host-provided `@deepseek-ai/schemastery`.
 *
 * `config-schema.host.ts` imports the real library because the host reads a
 * Schemastery schema off the plugin module namespace. That package ships with
 * the DSH profile, not with this repo, so unit tests that import
 * `src/index.ts` would fail to resolve it (and the plugin must not gain a
 * hard dependency on it). `vitest.config.ts` aliases the specifier here.
 *
 * The stub records the declaration chain so tests can assert shape/policy
 * without the real library; `config-schema.test.ts` keeps its own inline fake
 * for the same reason and additionally exercises the real library when a
 * profile install is present.
 */
import type { SchemaNode } from '../../src/config-schema.js';

export interface StubNode extends SchemaNode {
  readonly kind: 'object' | 'leaf';
  readonly path: string;
  readonly dict?: Record<string, StubNode>;
  readonly defaultValue?: unknown;
  readonly volatileFlag: boolean;
  readonly roleName?: string;
  readonly descriptionText?: string;
}

function makeNode(init: Partial<StubNode> & { kind: 'object' | 'leaf'; path: string }): StubNode {
  const node: StubNode = {
    kind: init.kind,
    path: init.path,
    dict: init.dict,
    defaultValue: init.defaultValue,
    volatileFlag: init.volatileFlag ?? false,
    roleName: init.roleName,
    descriptionText: init.descriptionText,
    default(value: unknown) {
      return makeNode({ ...node, defaultValue: value });
    },
    volatile() {
      return makeNode({ ...node, volatileFlag: true });
    },
    role(role: string) {
      return makeNode({ ...node, roleName: role });
    },
    description(text: string) {
      return makeNode({ ...node, descriptionText: text });
    },
  };
  return node;
}

const z = {
  any(): SchemaNode {
    return makeNode({ kind: 'leaf', path: '' });
  },
  object(dict: Record<string, SchemaNode>): SchemaNode {
    return makeNode({ kind: 'object', path: '', dict: dict as Record<string, StubNode> });
  },
};

export default z;
