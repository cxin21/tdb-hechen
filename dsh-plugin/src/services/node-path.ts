/**
 * Which `node` runs the services?
 *
 * The plugin lives inside the DSH host, so `process.execPath` is the **Electron
 * app**, not node: spawning it would open a second GUI instead of a service.
 * The old PowerShell table ran plain `node` off PATH, so that is the primary
 * answer here too:
 *
 *   1. `services.nodePath` (operator override, e.g. a pinned nvm4w install)
 *   2. `TDB_NODE_PATH` (same thing without editing the patch)
 *   3. the first `node`/`node.exe` on PATH
 *   4. `process.execPath` **with ELECTRON_RUN_AS_NODE=1** — the documented way to
 *      make an Electron binary behave like plain node, used only when PATH has
 *      no node at all (bundled runtimes).
 *
 * Step 4 is the one that must never be silent: `electronRunAsNode` tells the
 * supervisor to inject the env var, and the caller logs which source won.
 */
import { existsSync } from 'node:fs';

export type NodePathSource = 'config' | 'env' | 'path' | 'host';

export interface NodePathResolution {
  /** Absolute path handed to `spawn()`. */
  path: string;
  /** True ⇒ the child needs ELECTRON_RUN_AS_NODE=1 to behave as node. */
  electronRunAsNode: boolean;
  /** Where the answer came from, for the one-line install log. */
  source: NodePathSource;
}

export interface ResolveNodePathOptions {
  /** `services.nodePath`; '' means "not configured". */
  configured?: string;
  /** Ambient environment (defaults to process.env). */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Defaults to process.execPath (the Electron app inside the host). */
  execPath?: string;
  /** Test seam: does this path exist? */
  isFile?: (path: string) => boolean;
}

/** PATH separator of the TARGET platform, not of the host running the tests. */
function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Join with the TARGET platform's own separator. `node:path.join` follows the
 * host, which would build a Windows-looking candidate while resolving a POSIX
 * PATH — and then find nothing.
 */
function joinFor(platform: NodeJS.Platform, dir: string, name: string): string {
  const separator = platform === 'win32' ? String.fromCharCode(92) : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed + separator + name;
}

export function resolveNodePath(options: ResolveNodePathOptions = {}): NodePathResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const isFile = options.isFile ?? ((path: string) => existsSync(path));

  const configured = (options.configured ?? '').trim();
  if (configured !== '') return { path: configured, electronRunAsNode: false, source: 'config' };

  const fromEnv = (env.TDB_NODE_PATH ?? '').trim();
  if (fromEnv !== '') return { path: fromEnv, electronRunAsNode: false, source: 'env' };

  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(pathSeparator(platform))
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '');
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = joinFor(platform, dir, name);
      if (isFile(candidate)) return { path: candidate, electronRunAsNode: false, source: 'path' };
    }
  }

  // Last resort: the host binary as a node. Correct but easy to misread in a
  // process list, hence the flag + the install log line.
  return { path: execPath, electronRunAsNode: true, source: 'host' };
}