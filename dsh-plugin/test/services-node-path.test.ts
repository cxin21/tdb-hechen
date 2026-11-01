import { describe, expect, it } from 'vitest';
import { resolveNodePath } from '../src/services/node-path.js';

// The plugin runs inside the DSH host, where process.execPath is the Electron
// app. Spawning it as a service would open a second GUI, so "which node" is a
// correctness question, not a preference.

describe('resolveNodePath', () => {
  it('prefers services.nodePath when the operator pinned one', () => {
    const node = resolveNodePath({
      configured: 'C:/nvm4w/nodejs/node.exe',
      env: { PATH: 'C:/bin' },
      platform: 'win32',
      execPath: 'D:/DSH/DeepSeek Harness.exe',
      isFile: () => true,
    });
    expect(node).toEqual({ path: 'C:/nvm4w/nodejs/node.exe', electronRunAsNode: false, source: 'config' });
  });

  it('honours TDB_NODE_PATH when the patch cannot be edited', () => {
    const node = resolveNodePath({
      env: { TDB_NODE_PATH: 'C:/pinned/node.exe', PATH: 'C:/bin' },
      platform: 'win32',
      execPath: 'D:/DSH/DeepSeek Harness.exe',
      isFile: () => true,
    });
    expect(node.path).toBe('C:/pinned/node.exe');
    expect(node.source).toBe('env');
  });

  it('finds node on PATH before falling back to the host binary', () => {
    const node = resolveNodePath({
      env: { PATH: 'C:/empty;C:/nvm4w/nodejs;D:/other' },
      platform: 'win32',
      execPath: 'D:/DSH/DeepSeek Harness.exe',
      isFile: (path) => path.replaceAll('\\', '/') === 'C:/nvm4w/nodejs/node.exe',
    });
    expect(node.path.replaceAll('\\', '/')).toBe('C:/nvm4w/nodejs/node.exe');
    expect(node.electronRunAsNode).toBe(false);
    expect(node.source).toBe('path');
  });

  it('uses the host binary with ELECTRON_RUN_AS_NODE when PATH has no node', () => {
    const node = resolveNodePath({
      env: { PATH: 'C:/empty' },
      platform: 'win32',
      execPath: 'D:/DSH/DeepSeek Harness.exe',
      isFile: () => false,
    });
    // The supervisor turns electronRunAsNode into ELECTRON_RUN_AS_NODE=1.
    expect(node).toEqual({
      path: 'D:/DSH/DeepSeek Harness.exe',
      electronRunAsNode: true,
      source: 'host',
    });
  });

  it('looks for the bare name on POSIX and copes with an empty PATH', () => {
    const found = resolveNodePath({
      env: { PATH: '/usr/bin:/usr/local/bin' },
      platform: 'linux',
      execPath: '/opt/app',
      isFile: (path) => path === '/usr/local/bin/node',
    });
    expect(found.path).toBe('/usr/local/bin/node');
    const none = resolveNodePath({ env: {}, platform: 'linux', execPath: '/opt/app', isFile: () => false });
    expect(none.source).toBe('host');
    expect(none.electronRunAsNode).toBe(true);
  });
});