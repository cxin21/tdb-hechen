import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandEnvValue, parseEnvText, readEnvFile } from '../src/services/env-file.js';

describe('service env file (KEY=VALUE for the supervised stack)', () => {
  it('parses keys, ignores comments and blank lines, strips quotes', () => {
    const parsed = parseEnvText(
      [
        '# service secrets, one per line',
        '',
        'TDAI_GATEWAY_APIKEY=abc123',
        '  export MEMORY_LOG_LEVEL = debug  ',
        'QUOTED="value with spaces"',
        "SINGLE='single quoted'",
      ].join('\n'),
    );
    expect(parsed.values).toEqual({
      TDAI_GATEWAY_APIKEY: 'abc123',
      MEMORY_LOG_LEVEL: 'debug',
      QUOTED: 'value with spaces',
      SINGLE: 'single quoted',
    });
    expect(parsed.warnings).toEqual([]);
  });

  it('expands ${NAME} from values defined ABOVE it, then from the ambient environment', () => {
    const parsed = parseEnvText(
      ['ARK_BASE=https://ark.example/v1', 'LLM_BASE=${ARK_BASE}', 'LLM_KEY=${FROM_HOST}'].join('\n'),
      { FROM_HOST: 'host-secret' },
    );
    expect(parsed.values.LLM_BASE).toBe('https://ark.example/v1');
    // The host environment is the second source: an install that exports its
    // secrets instead of writing a file must work the same way.
    expect(parsed.values.LLM_KEY).toBe('host-secret');
  });

  it('reports an unknown reference by NAME only and expands it to empty', () => {
    const parsed = parseEnvText('LLM_KEY=${MISSING_ONE}');
    expect(parsed.values.LLM_KEY).toBe('');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('MISSING_ONE');
    // The value that used it must never appear in a warning (red line: no secrets).
    expect(parsed.warnings[0]).not.toContain('LLM_KEY=');
  });

  it('treats $$ as a literal dollar, so a password with $ survives', () => {
    const parsed = parseEnvText('DB_PASSWORD=pa$$word');
    expect(parsed.values.DB_PASSWORD).toBe('pa$word');
    // An unescaped $name in a value stays untouched: only ${NAME} is a reference,
    // because real keys contain bare dollar signs.
    expect(parseEnvText('K=a$b').values.K).toBe('a$b');
  });

  it('warns about malformed lines without dropping the rest of the file', () => {
    const parsed = parseEnvText(['GOOD=1', 'not a pair', '1BAD=x', 'ALSO_GOOD=2'].join('\n'));
    expect(parsed.values).toEqual({ GOOD: '1', ALSO_GOOD: '2' });
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain('line 2');
    expect(parsed.warnings[1]).toContain('line 3');
  });

  it('expandEnvValue prefers the file over the ambient environment', () => {
    const { value, missing } = expandEnvValue('${X}', { X: 'from-file' }, { X: 'from-host' });
    expect(value).toBe('from-file');
    expect(missing).toEqual([]);
  });

  it('readEnvFile returns null for a missing file and the parse for a present one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agemem-env-'));
    try {
      const missing = await readEnvFile(join(dir, 'nope.env'));
      expect(missing).toBeNull();
      const path = join(dir, 'services.env');
      await writeFile(path, 'A=1\nB=${A}2\n', 'utf8');
      const parsed = await readEnvFile(path);
      expect(parsed?.values).toEqual({ A: '1', B: '12' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readEnvFile rethrows anything that is not a missing file', async () => {
    const boom = vi.fn(async () => {
      const error = new Error('EACCES: permission denied') as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    });
    await expect(readEnvFile('C:/whatever.env', {}, boom as never)).rejects.toThrow('EACCES');
  });
});