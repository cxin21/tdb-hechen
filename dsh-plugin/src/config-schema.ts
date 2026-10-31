/**
 * Schemastery `Config` declaration for the host Settings page (档 2).
 *
 * Why this file exists: the host exposes a plugin in Settings → Plugins only when
 * the entry carries a Schemastery `Config` with at least one `.volatile()` field
 * (dsh-settings/lib/index.js: schema(entry) -> entry.fiber.runtime.Config, then
 * volatileForm(schema); no volatile field => the plugin is not listed at all).
 * `src/index.ts` had no Config export, so the plugin was invisible there.
 *
 * Two hard constraints shaped the shape below:
 *
 * 1. Fail-open. `apply()` runs today with an unknown/garbage config and never
 *    throws (`normalizeConfig` clamps every field). A typed Schemastery leaf
 *    (`z.number()`, `z.boolean()`) would make cordis *reject* the entry on a
 *    typo ("expected number but got nope"), i.e. the memory plugin would stop
 *    loading. So every leaf is `z.any()` and validation stays where it is:
 *    `normalizeConfig` (config.ts). The schema declares *shape* and *policy*
 *    (which field the form may write, which value is a secret), not types.
 *
 * 2. Volatile leaves are wrapped by schemastery at resolve time. A leaf marked
 *    `.volatile()` does not resolve to its value: it resolves to a
 *    `cosmokit` Volatile reference ({ get(), [Symbol.for('cosmokit.volatile.write')] }),
 *    see @deepseek-ai/cosmokit/src/volatile.ts:createVolatile. Anything that
 *    reads the config afterwards (normalizeConfig) would therefore see an object
 *    and silently fall back to the default. `unwrapVolatile()` below flattens
 *    those references back to plain values before validation; it is a no-op when
 *    the host hands over plain values.
 *
 * Missing runtime dependency by design: this module never imports
 * `@deepseek-ai/schemastery` (it takes the library as an argument) so that the
 * pure shape logic stays unit-testable without a host install. The single import
 * lives in `config-schema.host.ts`.
 */
import { DEFAULT_CONFIG, normalizeConfig, type NormalizedConfig } from './config.js';

/** Structural subset of the Schemastery API this file relies on. */
export interface SchemaNode {
  default(value: unknown): SchemaNode;
  volatile(): SchemaNode;
  role(role: string): SchemaNode;
  description(text: string): SchemaNode;
}

export interface SchemasteryLike {
  any(): SchemaNode;
  object(dict: Record<string, SchemaNode>): SchemaNode;
}

/** The key symbol cosmokit uses to tag a volatile config reference. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * Fields the Settings form may write. Every path is a leaf on a fixed object
 * path with no volatile ancestor (schemastery rejects the other nesting with
 * "volatile fields require a fixed object path without an enclosing volatile
 * field", see @deepseek-ai/dsh-app-boot/lib/index.js).
 *
 * 15 of the ticket's 16: `server.userKey` is a secret value, so it is declared
 * `.role('secret')` instead of volatile and the form never shows it (secrets
 * travel through `remote.credentials` by reference, see SECRET_PATHS).
 */
export const VOLATILE_PATHS = [
  'enabled',
  'server.baseUrl',
  'server.serviceId',
  'server.teamId',
  'server.agentId',
  'server.userId',
  'server.apiKeyRef',
  'server.userKeyRef',
  'writeback.enabled',
  'writeback.skillFeed',
  'volatile.enabled',
  'volatile.maxChars',
  'volatile.soul.enabled',
  'volatile.soul.maxChars',
  'volatile.soul.includeFeeling',
  'tools.enabled',
  'tools.recall',
  // task-72: the skill surface. Two knobs an operator must be able to flip
  // without a rebuild — the listing (read) and the six destructive write tools
  // (opt-in) — plus the listing's own budget.
  'skill.enabled',
  'skill.allowLlmWrite',
  'skill.headPackChars',
  // task-74/97: the per-turn capability segments. Wiki is OFF by default (the
  // 8420 build has no /v3/wiki/search — see config.ts), so the switch and its
  // ceiling are the two knobs an operator needs; knowledge is ON and gets the
  // same pair.
  'volatile.wiki.enabled',
  'volatile.wiki.maxChars',
  'volatile.knowledge.enabled',
  'volatile.knowledge.maxChars',
  // task-82: the reflection block is an eval-only knob, but it changes what the
  // model is told, so an operator must be able to switch it without a rebuild.
  'debug',
] as const;

/** Values the host must never return in clear text; the form only edits the ref. */
export const SECRET_PATHS = ['server.apiKey', 'server.userKey'] as const;

const DESCRIPTIONS: Record<string, string> = {
  enabled: 'Master switch for the whole memory plugin (head pack, volatile block, writeback, recall tool).',
  'server.baseUrl': 'tdai-gateway base URL, e.g. http://127.0.0.1:8420',
  'server.serviceId': 'Gateway service id used for every /v3 call.',
  'server.teamId': 'Team bound to this session (identity). Leave empty to resolve it from the user key.',
  'server.agentId': 'Agent (context) bound to this session. Leave empty to resolve it together with teamId.',
  'server.userId': 'End-user id for per-user memory. Leave empty to resolve it from the user key.',
  'server.apiKeyRef': 'Credential NAME holding the gateway API key (not the key itself).',
  'server.userKeyRef': 'Credential NAME holding the user key (not the key itself).',
  'writeback.enabled': 'Write finished turns back into memory.',
  'writeback.skillFeed': 'Include skill-feed turns in writeback.',
  'volatile.enabled': 'Inject the per-turn volatile memory block.',
  'volatile.maxChars': 'Hard character cap for the per-turn volatile block (soul and memories together).',
  'volatile.soul.enabled': 'Inject the distilled soul (persona) fragments ahead of the memory entries.',
  'volatile.soul.maxChars': 'Character cap for the soul slice of the volatile block (100-3000).',
  'volatile.soul.includeFeeling': 'Keep the <soul-feeling> mood line next to <soul-identity>.',
  'tools.enabled': 'Register the memory tools (recall/write).',
  'tools.recall': 'Register the read-only recall tool.',
  'skill.enabled': 'Inject the <available_skills> listing into the head pack and register the skill tools.',
  'skill.allowLlmWrite': 'Let the model create, patch and delete shared team skills (six write tools). Off by default.',
  'skill.headPackChars': 'Character budget for the <available_skills> head-pack section (0-64000).',
  'volatile.wiki.enabled': 'Inject a <team-wiki> block into the per-turn volatile block (off until the core answers /v3/wiki/search).',
  'volatile.wiki.maxChars': 'Character ceiling for the <team-wiki> segment (0-2000).',
  'volatile.knowledge.enabled': 'Inject the <knowledge_tools> resource list into the per-turn volatile block.',
  'volatile.knowledge.maxChars': 'Character ceiling for the <knowledge_tools> segment (0-3000).',
  debug: 'Verbose plugin logging (never logs secrets).',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function inSet(paths: readonly string[], path: string): boolean {
  return paths.includes(path);
}

/**
 * Build the Schemastery schema from the plugin's own defaults, so the declared
 * shape can never drift from `DEFAULT_CONFIG` (a new key shows up in the form
 * automatically; a volatile path that stops existing is caught by the tests).
 */
export function buildPluginConfigSchema(
  z: SchemasteryLike,
  defaults: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>,
): SchemaNode {
  const walk = (value: unknown, path: string): SchemaNode => {
    if (isPlainObject(value)) {
      const dict: Record<string, SchemaNode> = {};
      for (const [key, child] of Object.entries(value)) {
        dict[key] = walk(child, path === '' ? key : path + '.' + key);
      }
      return z.object(dict);
    }
    let node = z.any().default(value);
    const description = DESCRIPTIONS[path];
    if (description !== undefined) node = node.description(description);
    if (inSet(SECRET_PATHS, path)) node = node.role('secret');
    if (inSet(VOLATILE_PATHS, path)) node = node.volatile();
    return node;
  };
  return walk(defaults, '');
}

/** Whether a resolved config value is a cosmokit volatile reference. */
export function isVolatileRef(value: unknown): boolean {
  return (
    value !== null
    && typeof value === 'object'
    && VOLATILE_WRITE in (value as Record<PropertyKey, unknown>)
    && typeof (value as { get?: unknown }).get === 'function'
  );
}

/**
 * Replace every volatile reference with its current snapshot (recursively).
 * Plain values pass through untouched, so this is safe for hosts that resolve
 * config without volatile wrapping.
 */
export function unwrapVolatile(value: unknown, depth = 0): unknown {
  if (depth > 32) return undefined;
  if (isVolatileRef(value)) return unwrapVolatile((value as { get(): unknown }).get(), depth + 1);
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = unwrapVolatile(child, depth + 1);
    return out;
  }
  return value;
}

/**
 * The one call `apply()` needs: unwrap volatile references, then run the usual
 * fail-open normalization. Equal to `normalizeConfig(rawConfig)` for plain input.
 */
export function resolvePluginConfig(rawConfig: unknown): NormalizedConfig {
  return normalizeConfig(unwrapVolatile(rawConfig));
}
