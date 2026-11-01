/**
 * Health gate for the supervised services.
 *
 * Two readers: the launcher waits for a freshly spawned service to answer
 * `GET /health` before moving to the next one (a knowledge service started
 * before core is ready comes up half wired), and the status snapshot probes
 * every port on demand.
 *
 * The probe is deliberately `fetch` + an AbortSignal timeout rather than a raw
 * socket: `/health` answers JSON on 200 and the services return 503 while their
 * stores warm up, so "TCP accepted" is not "usable". Both the fetch
 * implementation, the clock and the sleep are injected — the tests must not
 * spend a real 90 seconds proving a budget.
 */

export interface ProbeOptions {
  /** Injected in tests; the real launcher uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

export async function probeHealth(port: number, options: ProbeOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let signal: AbortSignal | undefined;
  try {
    // AbortSignal.timeout is available on every Node the host supports; keep a
    // guard so an older runtime degrades to "no timeout" instead of throwing
    // before the first request.
    signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  } catch {
    signal = undefined;
  }
  try {
    const response = await fetchImpl('http://127.0.0.1:' + port + '/health', {
      method: 'GET',
      signal,
    });
    // Drain: an unread body keeps the socket (and the agent) alive.
    try {
      await response.arrayBuffer();
    } catch {
      // A body we cannot read does not change the verdict.
    }
    return response.status === 200;
  } catch {
    return false;
  }
}

export interface WaitHealthyOptions extends ProbeOptions {
  /** Total budget in milliseconds. */
  budgetMs: number;
  /** Delay between attempts. */
  intervalMs?: number;
  /** Attempt function; defaults to probeHealth(port). */
  probe?: () => Promise<boolean>;
  /** Injected clock + sleep so a budget test costs nothing. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitHealthyResult {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
}

const DEFAULT_INTERVAL_MS = 1000;

export async function waitHealthy(
  port: number,
  options: WaitHealthyOptions,
): Promise<WaitHealthyResult> {
  const probe = options.probe ?? (() => probeHealth(port, options));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const budgetMs = options.budgetMs > 0 ? options.budgetMs : 0;
  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (await probe()) return { ok: true, attempts, elapsedMs: now() - startedAt };
    if (now() - startedAt + intervalMs > budgetMs) break;
    await sleep(intervalMs);
  }
  return { ok: false, attempts, elapsedMs: now() - startedAt };
}