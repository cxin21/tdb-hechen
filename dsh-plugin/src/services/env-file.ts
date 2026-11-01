/**
 * Service environment file reader (Wave 4: the service stack is supervised
 * inside this plugin, so the secrets this plugin hands to its children must
 * come from a format the plugin can parse itself).
 *
 * The file is `KEY=VALUE`, one per line:
 *   - blank lines and `#` comments are ignored;
 *   - an optional leading `export ` is accepted, so the same file also works
 *     when a POSIX shell sources it;
 *   - surrounding single or double quotes are stripped;
 *   - `${NAME}` is expanded from the values defined ABOVE it in the same file,
 *     then from the ambient environment. `$$` is a literal `$`.
 *
 * Why `${NAME}` and not `$NAME`: `$` appears inside real values (bcrypt-ish
 * keys, passwords) and a greedy `$NAME` rule would silently mangle them. An
 * unknown `${NAME}` expands to the empty string, the same thing the shell does,
 * and is reported as a warning so an operator can see a typo instead of
 * wondering why a credential stopped working.
 *
 * Red line: this module never logs values. Callers get the map; only the
 * NAMES are ever printable.
 */
import { readFile } from 'node:fs/promises';

export interface EnvFileResult {
  /** Resolved values, insertion-ordered. */
  values: Record<string, string>;
  /** Human-readable problems (unknown variable, malformed line). Never a value. */
  warnings: string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Expand `${NAME}` against `defined` first, then the ambient environment. */
export function expandEnvValue(
  raw: string,
  defined: Record<string, string>,
  ambient: Record<string, string | undefined> = {},
): { value: string; missing: string[] } {
  const missing: string[] = [];
  // `$$` is an escape for a literal `$`; hold it behind a sentinel that cannot
  // appear in a variable name.
  const guarded = raw.replace(/\$\$/g, '\u0000');
  const value = guarded.replace(VAR_RE, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(defined, name)) return defined[name]!;
    const fromAmbient = ambient[name];
    if (typeof fromAmbient === 'string') return fromAmbient;
    missing.push(name);
    return '';
  });
  return { value: value.replace(/\u0000/g, '$'), missing };
}

/**
 * Parse the file contents. Pure: no filesystem, no environment mutation, so the
 * launcher can be tested against a fixture string.
 */
export function parseEnvText(
  text: string,
  ambient: Record<string, string | undefined> = {},
): EnvFileResult {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const where = 'line ' + (index + 1);
    let line = lines[index]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) {
      warnings.push(where + ': not a KEY=VALUE line, ignored');
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      warnings.push(where + ': "' + key + '" is not a valid variable name, ignored');
      continue;
    }
    const { value, missing } = expandEnvValue(unquote(line.slice(eq + 1)), values, ambient);
    for (const name of missing) {
      // Name only: the value that would have used it never reaches a log line.
      warnings.push(where + ': ' + key + ' references ${' + name + '} which is not defined here or in the environment');
    }
    values[key] = value;
  }
  return { values, warnings };
}

/**
 * Read and parse the file. A missing file is not an error: the caller decides
 * whether services can run without it (they can — ambient DSH environment
 * variables are a legal deployment), so this returns `null` and lets the
 * launcher print one line saying which path it looked at.
 */
export async function readEnvFile(
  path: string,
  ambient: Record<string, string | undefined> = {},
  readFileImpl: typeof readFile = readFile,
): Promise<EnvFileResult | null> {
  let text: string;
  try {
    text = await readFileImpl(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw error;
  }
  return parseEnvText(text, ambient);
}