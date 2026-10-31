/**
 * File mirror for the plugin log.
 *
 * Why this exists: the desktop host (the one the user actually runs) has no
 * stderr we can read, so every debug() line the plugin emitted while diagnosing
 * the writeback went nowhere — a whole afternoon of "the plugin is silent" was
 * really "the plugin is talking to a terminal nobody can open". With
 * `debug: true` the same lines also go to a file (default
 * `$DSH_HOME/agemem/agemem.log`), which is the only observable channel a GUI
 * install has.
 *
 * Rules:
 * - opt-in via config.debug; when debug is off this module is never constructed
 *   (no file is created, no directory is created).
 * - one line per record, ISO timestamp first, extra args JSON-flattened and
 *   newlines escaped, so grep/less stay usable.
 * - 5 MB per file, then rotate to one generation named `<path>.1` — this is a
 *   debugging aid, not an audit log.
 * - FAIL-OPEN: any filesystem error flips `failed`, stops further writes and is
 *   reported once through the host logger. A full disk must never take down the
 *   turn path.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LoggerLike } from './types.js';

export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Longest single line we keep: a stack trace is the one thing worth clipping. */
const MAX_LINE_CHARS = 4000;

export type LogLevel = 'debug' | 'info' | 'warn';

export interface DebugLogSink {
  /** Current size of the log file in bytes (0 when it does not exist yet). */
  size(): number;
  /** Append one complete, already formatted line (with its trailing newline). */
  append(text: string): void;
  /** Move the current file aside so the next append starts from zero bytes. */
  rotate(): void;
}

export interface DebugLog {
  /** Absolute path of the active file (also the prefix of the rotated one). */
  readonly path: string;
  readonly logger: Required<Pick<LoggerLike, 'debug' | 'info' | 'warn'>>;
  /** True once a write failed and the mirror went silent. */
  failed(): boolean;
  /** Bytes accepted by the sink so far (diagnostics/tests). */
  written(): number;
  /** How many rotations happened (0 or 1 in practice). */
  rotations(): number;
}

function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return join(homedir(), target.slice(2));
  return target;
}

/**
 * Resolve the log path. An explicit config value wins verbatim; otherwise
 * DSH_HOME/agemem/agemem.log, where DSH_HOME itself defaults to ~/.dsh (the
 * same default the host CLI uses). Kept pure so tests never touch the disk.
 */
export function resolveDebugLogPath(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit !== '') return expandHome(explicit);
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'agemem', 'agemem.log');
}

/** Real filesystem sink; every call is guarded so a read-only DSH_HOME cannot throw. */
export function createFileSink(filePath: string): DebugLogSink {
  return {
    size() {
      try {
        return statSync(filePath).size;
      } catch {
        return 0;
      }
    },
    append(text: string) {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, text, 'utf8');
    },
    rotate() {
      try {
        renameSync(filePath, filePath + '.1');
      } catch {
        // No previous file (or a locked one): appending anyway beats dropping the line.
      }
    },
  };
}

function formatPart(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? (value.name + ': ' + value.message);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    // Circular structure: the type name is still better than nothing.
    return '[unserializable ' + Object.prototype.toString.call(value) + ']';
  }
}

export interface DebugLogOptions {
  filePath: string;
  maxBytes?: number;
  /** Test seam; defaults to the real file sink. */
  sink?: DebugLogSink;
  /** Test seam; defaults to `new Date()`. */
  now?: () => Date;
}

export function createDebugLog(options: DebugLogOptions): DebugLog {
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DEBUG_LOG_MAX_BYTES;
  const sink = options.sink ?? createFileSink(options.filePath);
  const clock = options.now ?? (() => new Date());
  let isFailed = false;
  let bytesWritten = 0;
  let rotationCount = 0;

  const write = (level: LogLevel, parts: unknown[]): void => {
    if (isFailed) return;
    const message = parts.map(formatPart).join(' ');
    const stamp = clock().toISOString();
    // One record = one line: an embedded newline (stack traces, multi-line tool
    // output) would break grep and inflate the byte accounting.
    let line = stamp + ' [' + level + '] ' + message.replace(/\r\n|\r|\n/g, ' \\n ');
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + ' …[line truncated]';
    const record = line + '\n';
    try {
      const current = sink.size();
      if (current > 0 && current + Buffer.byteLength(record, 'utf8') > maxBytes) {
        sink.rotate();
        rotationCount += 1;
      }
      sink.append(record);
      bytesWritten += Buffer.byteLength(record, 'utf8');
    } catch {
      // Full disk, permission denied, vanished directory: go quiet, never throw.
      isFailed = true;
    }
  };

  return {
    path: options.filePath,
    logger: {
      debug: (...parts: unknown[]) => write('debug', parts),
      info: (...parts: unknown[]) => write('info', parts),
      warn: (...parts: unknown[]) => write('warn', parts),
    },
    failed: () => isFailed,
    written: () => bytesWritten,
    rotations: () => rotationCount,
  };
}

/**
 * Fan one log call out to the host logger and the file mirror. The host logger
 * stays first on purpose: if the file sink is broken, stderr still has the line.
 */
export function combineLoggers(
  base: LoggerLike | undefined,
  file: LoggerLike | undefined,
): LoggerLike | undefined {
  if (file === undefined) return base;
  const fan = (level: LogLevel) => (...parts: unknown[]): void => {
    try {
      base?.[level]?.(...parts);
    } catch {
      // A host logger that throws must not swallow the file line.
    }
    file[level]?.(...parts);
  };
  return { debug: fan('debug'), info: fan('info'), warn: fan('warn') };
}