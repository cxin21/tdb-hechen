/**
 * Should THIS host start and supervise the service stack at all?
 *
 * The supervisor exists for one deployment shape: DSH, core, knowledge and the
 * panel all on the same machine (the dev workstation). The plugin also supports
 * the opposite shape — `server.baseUrl` pointing at a core on another machine —
 * and in that shape spawning a **local** stack is not merely useless, it is
 * actively wrong:
 *
 *   1. it starts three node processes the user never asked for, holding ports
 *      that the remote deployment may want to bind later;
 *   2. the plugin would then talk past them to the remote core, so the local
 *      stack looks alive to `tasklist` but receives no traffic — a split-brain
 *      that is invisible until someone reads both machines' logs;
 *   3. `stopOnDispose` would kill the local stack on host exit while the remote
 *      one keeps serving, so the machine state depends on who started what.
 *
 * The rule is stated once, here: **the plugin manages a service stack only when
 * the core it talks to is on this host.** Remote core ⇒ nothing to manage; the
 * other machine's owner starts its own stack (systemd/Windows service/manual
 * script — a DSH plugin on the client cannot do it).
 *
 * `services.include` narrows it further for the mixed case (e.g. a workstation
 * that runs core locally but the knowledge service lives on a wiki box).
 */
import type { ServiceName } from './service-table.js';

export type StackScopeReason = 'ok' | 'disabled-by-config' | 'remote-core' | 'no-services';

export interface StackScope {
  /** True ⇒ this host spawns and supervises services. */
  managed: boolean;
  reason: StackScopeReason;
  /** Host part of the configured core baseUrl ('' when unparsable). */
  coreHost: string;
  /** Which services this host would manage (empty unless `managed`). */
  include: readonly ServiceName[];
  /** One line for the ready log / settings page; never contains a secret. */
  detail: string;
}

/**
 * Loopback as seen from this process: anything that reaches the same machine.
 * `0.0.0.0` is included on purpose — Windows happily connects to it, and a patch
 * written by hand says that far more often than it means "remote".
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  // 127.0.0.0/8 is loopback by definition (127.0.0.1 the common case).
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Host of a baseUrl without pulling in a URL parser's failure modes. */
export function hostOfBaseUrl(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim();
  if (raw === '') return '';
  try {
    return new URL(raw.includes('://') ? raw : 'http://' + raw).hostname;
  } catch {
    return '';
  }
}

export interface ResolveStackScopeInput {
  enabled: boolean;
  /** The core address the plugin will actually call (server.baseUrl). */
  coreBaseUrl: string;
  /** `services.include`; empty ⇒ all three. */
  include?: readonly string[];
  known?: readonly ServiceName[];
}

export function resolveStackScope(input: ResolveStackScopeInput): StackScope {
  const known = input.known ?? (['tdai-core', 'tdai-knowledge', 'tdai-panel'] as const);
  const coreHost = hostOfBaseUrl(input.coreBaseUrl);
  const wanted = (input.include ?? [])
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const include = (wanted.length === 0 ? known : wanted.filter((name) => (known as readonly string[]).includes(name))) as readonly ServiceName[];

  if (!input.enabled) {
    return {
      managed: false,
      reason: 'disabled-by-config',
      coreHost,
      include: [],
      detail: 'services.enabled is off; this host leaves the stack alone',
    };
  }
  if (!isLoopbackHost(coreHost)) {
    return {
      managed: false,
      reason: 'remote-core',
      coreHost,
      include: [],
      detail:
        'core lives on another host ('
        + (coreHost === '' ? 'unparsable baseUrl' : coreHost)
        + '); a local stack would get no traffic and only hold ports — start it on that machine',
    };
  }
  if (include.length === 0) {
    // Name the offenders: a typo or a retired service ('tdai-proxy') is the
    // usual cause, and "selects nothing" alone would send the user guessing.
    const unknown = wanted.filter((name) => !(known as readonly string[]).includes(name));
    return {
      managed: false,
      reason: 'no-services',
      coreHost,
      include: [],
      detail:
        'services.include selects nothing this plugin knows how to start (unknown: '
        + unknown.join(', ')
        + ')',
    };
  }
  return {
    managed: true,
    reason: 'ok',
    coreHost,
    include,
    detail: 'managing ' + include.join(', ') + ' on this host (core ' + (coreHost || 'loopback') + ')',
  };
}