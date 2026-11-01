/**
 * The TDB service table (Wave 4: supervision lives in this plugin).
 *
 * This mirrors `D:\TDB\etc\tdb-services.common.ps1` — but the table is now
 * DATA here, not a PowerShell literal, because two readers need it: the
 * launcher (spawn order, cwd, args, port) and the settings page (labels,
 * ports). The plugin used to read status from a supervisor running outside the
 * host; a second copy of the table in a bundle was exactly the drift that
 * retired MemoryProxy's row only on disk while the running supervisor kept
 * respawning it.
 *
 * Everything is a pure function of `repoRoot` so the launcher is testable and
 * the repo can move without a code change.
 */

export interface ServiceSpec {
  /** Stable id; also the state-file key and the settings-page row label. */
  name: string;
  /** Service package directory, relative to the repo root. */
  dir: string;
  /** Node argv after the logtee preload (entry script + node flags). */
  args: readonly string[];
  /** Port its `/health` answers on. */
  port: number;
}

export interface ServiceTableOptions {
  repoRoot: string;
  /** Overrides, keyed by service name: port only (a real deployment may shift). */
  ports?: Record<string, number>;
}

export const SERVICE_NAMES = ['tdai-core', 'tdai-knowledge', 'tdai-panel'] as const;

const BASE_TABLE: ReadonlyArray<Omit<ServiceSpec, 'port'> & { port: number }> = [
  { name: 'tdai-core', dir: 'MemoryCore', args: ['--import', 'tsx', 'src/gateway/server.ts'], port: 8420 },
  { name: 'tdai-knowledge', dir: 'MemoryKnowledge', args: ['--import', 'tsx', 'src/server.ts'], port: 8421 },
  { name: 'tdai-panel', dir: 'MemoryPanel', args: ['--import', 'tsx', 'src/index.ts'], port: 8123 },
];

export function defaultServiceTable(options: ServiceTableOptions): ServiceSpec[] {
  const root = options.repoRoot.replace(/[\\/]+$/, '');
  const ports = options.ports ?? {};
  return BASE_TABLE.map((spec) => ({
    name: spec.name,
    dir: root + '\\' + spec.dir,
    args: [...spec.args],
    // A port of 0 or a negative number is a configuration mistake, not a wish
    // to disable the service: fall back to the built-in port instead of
    // silently probing "nothing".
    port: typeof ports[spec.name] === 'number' && ports[spec.name]! > 0 ? ports[spec.name]! : spec.port,
  }));
}

/** Look up one spec by name; `undefined` means the caller asked for a stranger. */
export function findServiceSpec(specs: readonly ServiceSpec[], name: string): ServiceSpec | undefined {
  return specs.find((spec) => spec.name === name);
}