import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combineLoggers,
  createDebugLog,
  createFileSink,
  DEBUG_LOG_MAX_BYTES,
  resolveDebugLogPath,
  type DebugLogSink,
} from '../src/debug-log.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agemem-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** In-memory sink: lets the rotation and failure paths be driven without a disk. */
function memorySink(options?: { failOnAppend?: boolean }): DebugLogSink & { text(): string } {
  let buffer = '';
  let rotated = 0;
  return {
    size: () => Buffer.byteLength(buffer, 'utf8'),
    append(text: string) {
      if (options?.failOnAppend) throw new Error('ENOSPC: no space left on device');
      buffer += text;
    },
    rotate() {
      rotated += 1;
      buffer = '';
    },
    text: () => buffer,
    rotations: () => rotated,
  } as DebugLogSink & { text(): string };
}

const fixedClock = () => new Date('2026-11-01T00:00:00.000Z');

describe('debug log path', () => {
  it('prefers an explicit path and expands a leading tilde', () => {
    expect(resolveDebugLogPath('D:/logs/a.log', { DSH_HOME: 'D:/other' })).toBe('D:/logs/a.log');
    expect(resolveDebugLogPath('  D:/logs/a.log  ', {})).toBe('D:/logs/a.log');
    expect(resolveDebugLogPath('~/a.log', {})).toBe(join(homedir(), 'a.log'));
  });

  it('falls back to DSH_HOME/agemem/agemem.log, then to ~/.dsh', () => {
    expect(resolveDebugLogPath('', { DSH_HOME: 'D:/dsh-home' })).toBe(join('D:/dsh-home', 'agemem', 'agemem.log'));
    expect(resolveDebugLogPath(undefined, { DSH_HOME: '  ' })).toBe(join(homedir(), '.dsh', 'agemem', 'agemem.log'));
    expect(resolveDebugLogPath(undefined, {})).toBe(join(homedir(), '.dsh', 'agemem', 'agemem.log'));
  });
});

describe('debug log records', () => {
  it('writes one line per record, timestamp first, newlines escaped', () => {
    const sink = memorySink();
    const log = createDebugLog({ filePath: 'x.log', sink, now: fixedClock });
    log.logger.debug('hello', 42);
    log.logger.info('multi' + String.fromCharCode(10) + 'line');
    log.logger.warn('boom');
    const lines = sink.text().split(String.fromCharCode(10)).filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-11-01T00:00:00.000Z [debug] hello 42');
    // A stack trace must not become one record per frame.
    expect(lines[1]).toBe('2026-11-01T00:00:00.000Z [info] multi \\n line');
    expect(lines[2]).toBe('2026-11-01T00:00:00.000Z [warn] boom');
    expect(log.written()).toBe(Buffer.byteLength(sink.text(), 'utf8'));
    expect(log.failed()).toBe(false);
  });

  it('flattens errors, objects and unserializable values without throwing', () => {
    const sink = memorySink();
    const log = createDebugLog({ filePath: 'x.log', sink, now: fixedClock });
    const error = new Error('bad');
    log.logger.warn('failed', error);
    log.logger.debug('payload', { a: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.logger.debug('cycle', circular);
    const text = sink.text();
    expect(text).toContain('bad');
    expect(text).toContain('{"a":1}');
    expect(text).toContain('[unserializable [object Object]]');
    expect(log.failed()).toBe(false);
  });

  it('rotates once per crossing and keeps the file bounded', () => {
    const sink = memorySink();
    const log = createDebugLog({ filePath: 'x.log', sink, now: fixedClock, maxBytes: 120 });
    for (let i = 0; i < 20; i += 1) log.logger.debug('line ' + i);
    expect(log.rotations()).toBeGreaterThan(0);
    // Whatever is left is a fresh file, never an unbounded append.
    expect(Buffer.byteLength(sink.text(), 'utf8')).toBeLessThan(200);
  });

  it('treats a zero or invalid maxBytes as the documented 5 MB default', () => {
    const sink = memorySink();
    const log = createDebugLog({ filePath: 'x.log', sink, now: fixedClock, maxBytes: 0 });
    for (let i = 0; i < 5; i += 1) log.logger.debug('x'.repeat(1000));
    expect(log.rotations()).toBe(0);
    expect(DEBUG_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('goes silent after a write failure instead of breaking the caller', () => {
    const sink = memorySink({ failOnAppend: true });
    const log = createDebugLog({ filePath: 'x.log', sink, now: fixedClock });
    expect(() => log.logger.warn('first')).not.toThrow();
    expect(log.failed()).toBe(true);
    expect(() => log.logger.warn('second')).not.toThrow();
  });

  it('writes real files and rotates to a single .1 generation', () => {
    const dir = tempDir();
    const file = join(dir, 'nested', 'agemem.log');
    const log = createDebugLog({ filePath: file, now: fixedClock, maxBytes: 200 });
    for (let i = 0; i < 10; i += 1) log.logger.debug('line ' + i);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + '.1')).toBe(true);
    expect(readFileSync(file + '.1', 'utf8')).toContain('[debug]');
  });

  it('survives a sink whose size() throws (missing parent directory)', () => {
    const dir = tempDir();
    const file = join(dir, 'deep', 'nest', 'agemem.log');
    const sink: DebugLogSink = {
      size: () => { throw new Error('ENOENT'); },
      append: () => { throw new Error('ENOENT'); },
      rotate: () => {},
    };
    const log = createDebugLog({ filePath: file, sink, now: fixedClock });
    expect(() => log.logger.info('x')).not.toThrow();
    expect(log.failed()).toBe(true);
  });

  it('creates the parent directory through the real sink', () => {
    const dir = tempDir();
    const file = join(dir, 'a', 'b', 'agemem.log');
    const sink = createFileSink(file);
    sink.append('first' + String.fromCharCode(10));
    expect(readFileSync(file, 'utf8')).toBe('first' + String.fromCharCode(10));
    expect(sink.size()).toBe(6);
    // Rotating with no file present must be silently tolerated.
    rmSync(file);
    expect(() => sink.rotate()).not.toThrow();
  });
});

describe('combineLoggers', () => {
  it('keeps the host logger first and mirrors to the file', () => {
    const order: string[] = [];
    const base = {
      debug: (...parts: unknown[]) => order.push('base ' + parts.join(' ')),
      info: () => {},
      warn: () => {},
    };
    const file = {
      debug: (...parts: unknown[]) => order.push('file ' + parts.join(' ')),
      info: () => {},
      warn: () => {},
    };
    combineLoggers(base, file)?.debug?.('x');
    expect(order).toEqual(['base x', 'file x']);
  });

  it('still writes the file line when the host logger throws', () => {
    const file = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const base = {
      debug: () => { throw new Error('host logger broke'); },
      info: () => {},
      warn: () => {},
    };
    expect(() => combineLoggers(base, file)?.debug?.('x')).not.toThrow();
    expect(file.debug).toHaveBeenCalledWith('x');
  });

  it('returns whichever side exists', () => {
    expect(combineLoggers(undefined, undefined)).toBeUndefined();
    const base = { debug: () => {}, info: () => {}, warn: () => {} };
    expect(combineLoggers(base, undefined)).toBe(base);
    // With no host logger the fan still wraps the file logger (same calls, one
    // extra arrow): only the no-file case returns the original object.
    const file = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    combineLoggers(undefined, file)?.debug?.('x');
    expect(file.debug).toHaveBeenCalledWith('x');
  });
});
