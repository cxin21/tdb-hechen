/**
 * Scope tests: does THIS host manage a service stack at all?
 *
 * The single-machine assumption was wrong: `server.baseUrl` may point at a core
 * on another box, and in that shape spawning a local core+knowledge+panel only
 * holds three ports hostage while every request goes over the network. These
 * cases pin the answer for each deployment shape, because "quietly did nothing"
 * and "quietly started three processes nobody talks to" look the same in a log
 * until the ports are gone.
 */
import { describe, expect, it } from 'vitest';
import {
  hostOfBaseUrl,
  isLoopbackHost,
  resolveStackScope,
} from '../src/services/scope.js';

describe('services scope: is this host the owner of the stack', () => {
  it('treats every spelling of "this machine" as loopback', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.1.1', '::1', '[::1]', '0.0.0.0', '']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['10.16.235.171', 'core.example.com', '192.168.1.20', '172.16.0.5']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('reads the host out of a base URL, with or without a scheme', () => {
    expect(hostOfBaseUrl('http://127.0.0.1:8420')).toBe('127.0.0.1');
    expect(hostOfBaseUrl('https://core.example.com/v3')).toBe('core.example.com');
    expect(hostOfBaseUrl('127.0.0.1:8420')).toBe('127.0.0.1');
    expect(hostOfBaseUrl('http://[::1]:8420')).toBe('[::1]');
    // Unparseable is not "loopback": guessing here spawns three processes.
    expect(hostOfBaseUrl('not a url at all')).toBe('');
    expect(hostOfBaseUrl('')).toBe('');
  });

  it('refuses to manage the stack when the configured core is remote', () => {
    const scope = resolveStackScope({ enabled: true, coreBaseUrl: 'http://10.16.235.171:8420' });
    expect(scope.managed).toBe(false);
    expect(scope.reason).toBe('remote-core');
    expect(scope.coreHost).toBe('10.16.235.171');
    expect(scope.detail).toContain('10.16.235.171');
    // The detail is meant for logs and the settings page: no secrets, no path.
    expect(scope.detail).not.toContain('apiKey');
  });

  it('manages the stack for a loopback core', () => {
    const scope = resolveStackScope({ enabled: true, coreBaseUrl: 'http://127.0.0.1:8420' });
    expect(scope.managed).toBe(true);
    expect(scope.reason).toBe('ok');
    expect(scope.coreHost).toBe('127.0.0.1');
    expect(scope.include).toEqual(['tdai-core', 'tdai-knowledge', 'tdai-panel']);
  });

  it('stays out of the way when the feature is off', () => {
    const scope = resolveStackScope({ enabled: false, coreBaseUrl: 'http://127.0.0.1:8420' });
    expect(scope.managed).toBe(false);
    expect(scope.reason).toBe('disabled-by-config');
  });

  it('narrows to the services listed in include (mixed deployment)', () => {
    const scope = resolveStackScope({
      enabled: true,
      coreBaseUrl: 'http://127.0.0.1:8420',
      include: ['tdai-core', ' tdai-panel ', ''],
    });
    expect(scope.managed).toBe(true);
    expect(scope.include).toEqual(['tdai-core', 'tdai-panel']);
  });

  it('stops managing when include selects nothing it knows', () => {
    const scope = resolveStackScope({
      enabled: true,
      coreBaseUrl: 'http://127.0.0.1:8420',
      include: ['tdai-proxy', 'nonsense'],
    });
    expect(scope.managed).toBe(false);
    expect(scope.reason).toBe('no-services');
    expect(scope.detail).toContain('tdai-proxy');
  });

  it('an empty include means all three known services', () => {
    const scope = resolveStackScope({ enabled: true, coreBaseUrl: 'http://localhost:8420', include: [] });
    expect(scope.managed).toBe(true);
    expect(scope.include).toHaveLength(3);
  });

  it('a broken base URL fails safe: no local stack', () => {
    const scope = resolveStackScope({ enabled: true, coreBaseUrl: 'garbage' });
    expect(scope.managed).toBe(false);
    expect(scope.reason).toBe('remote-core');
  });
});
