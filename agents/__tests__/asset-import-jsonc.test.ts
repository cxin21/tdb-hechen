// #120 回归：目录里混入非会话 JSON（如 workbuddy 的 argv.json，VS Code 风格 JSONC）时，
// asset-import 只跳过该文件并告警一次，其余会话必须全部导入——不允许一个文件打断整批导入。
// 运行：cd agents && pnpm test（CI: .github/workflows/ci.yml 的 agents-test 作业）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS } from '../asset-import';

const dirs: string[] = [];

function scratchDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'asset-import-jsonc-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const GOOD = JSON.stringify({ input: [{ role: 'user', content: 'hello from a valid session' }] });
// 与 ~/.workbuddy/argv.json 同型：带 // 注释 + 尾逗号，JSON.parse 会抛 SyntaxError
const JSONC = '{\n  // VS Code 风格 JSONC\n  "argv": ["--foo"],\n}\n';

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('asset-import 扫盘容错 (#120)', () => {
  it('混入 JSONC 时跳过该文件、其余会话全部导入，单个坏文件只告警一次', () => {
    const dir = scratchDir({ 'good-session.json': GOOD, 'argv.json': JSONC });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sessions = ADAPTERS.workbuddy.scanSessions(dir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('good-session');
    expect(sessions[0].messages[0]?.content).toBe('hello from a valid session');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('argv.json');
  });

  it('多个坏文件按文件各告警一次，合法会话仍全部导入', () => {
    const dir = scratchDir({ 'good-session.json': GOOD, 'argv.json': JSONC, 'mcp.json': '{"mcp": [' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sessions = ADAPTERS.workbuddy.scanSessions(dir);

    expect(sessions.map((s) => s.sessionId)).toEqual(['good-session']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0]) + String(warn.mock.calls[1][0])).toContain('argv.json');
    expect(String(warn.mock.calls[0][0]) + String(warn.mock.calls[1][0])).toContain('mcp.json');
  });

  it('名字像 .json 的目录（EISDIR）也只跳过，不打断整批', () => {
    const dir = scratchDir({ 'good-session.json': GOOD });
    mkdirSync(join(dir, 'cache.json'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 读失败与解析失败分开报：这条走「无法读取」，不是「非法 JSON」
    expect(ADAPTERS.workbuddy.scanSessions(dir).map((s) => s.sessionId)).toEqual(['good-session']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('cache.json');
    expect(String(warn.mock.calls[0][0])).toContain('无法读取');
  });

  it('全是合法 JSON 时不告警（避免容错过度变成噪音）', () => {
    const dir = scratchDir({ 'good-session.json': GOOD });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(ADAPTERS.workbuddy.scanSessions(dir)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
