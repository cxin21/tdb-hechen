import type { AgememConfig } from '../config.js';
import type { MemoryClient } from '../memory-client.js';
import type { SkillClient } from '../skill-client.js';
import type { LoggerLike, ToolDefinitionShape } from '../types.js';

/**
 * Tool registration seam.
 *
 * Every capability ships its own tools in its own module and self-registers
 * here (`src/tools/recall.ts`, `src/tools/skills.ts`, and later knowledge), so
 * adding a capability never edits `src/index.ts`. `index.ts` only iterates
 * `enabledToolModules()` and calls `tools.register` per definition.
 *
 * The host's registration rules (measured, docs/ops/dsh-plugin-probe-report.md
 * and the task-69 lead-up): `parameters` must be a whole JSON Schema object
 * with `type: 'object'`; an optional property must OMIT `required` entirely
 * (`required: false` makes the host throw UNSUPPORTED_SCHEMA and drop the
 * whole tool); a name is registered once per process.
 */

export interface ToolModuleDeps {
  client: MemoryClient;
  config: AgememConfig;
  log?: LoggerLike;
  /** Absent until the skill surface is wired (and in unit tests). */
  skillClient?: SkillClient;
  /** Current session id; used by tools that act on this session (skill_extract). */
  sessionId?: () => string | undefined;
}

export interface ToolModule {
  /** Module name for logs; also the key for re-registration. */
  name: string;
  /** When false the module's tools are not built at all (no network, no cost). */
  enabled(config: AgememConfig): boolean;
  /** Built lazily, so a disabled module never allocates a schema. */
  build(deps: ToolModuleDeps): ToolDefinitionShape[];
}

const modules: ToolModule[] = [];

export function registerToolModule(module: ToolModule): void {
  const name = typeof module?.name === 'string' ? module.name.trim() : '';
  if (name === '') throw new Error('tool module name must be a non-empty string');
  if (typeof module.enabled !== 'function') throw new Error(`tool module ${name}: enabled must be a function`);
  if (typeof module.build !== 'function') throw new Error(`tool module ${name}: build must be a function`);
  const existing = modules.findIndex((entry) => entry.name === name);
  if (existing >= 0) modules.splice(existing, 1);
  modules.push({ ...module, name });
}

export function toolModules(): ToolModule[] {
  return [...modules];
}

/** Modules whose switch is on for this config, in registration order. */
export function enabledToolModules(config: AgememConfig): ToolModule[] {
  return modules.filter((module) => {
    try {
      return module.enabled(config) === true;
    } catch {
      return false;
    }
  });
}

/** Test hook: forget every registration (the barrel's imports do not re-run). */
export function resetToolModulesForTests(): void {
  modules.length = 0;
}
