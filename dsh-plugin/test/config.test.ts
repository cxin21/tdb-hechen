import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, debugFromEnv, normalizeConfig } from '../src/config.js';
import { MemoryClient } from '../src/memory-client.js';

describe('config', () => {
  it('returns complete defaults for empty input', () => {
    const { config, warnings } = normalizeConfig(undefined);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it('ships the asset-reflection knobs with eval-safe defaults', () => {
    // task-82：反射段是可选资产，缺省开着但只在 /analyse 轮注入（alwaysOn 关）。
    expect(DEFAULT_CONFIG.assetReflection).toEqual({
      enabled: true,
      triggerToken: '/analyse',
      alwaysOn: false,
      maxChars: 600,
    });
    const { config, warnings } = normalizeConfig({
      assetReflection: { triggerToken: '  ', alwaysOn: true, maxChars: 999999 },
    });
    expect(warnings).toEqual([]);
    // 空 token 回落缺省：空串会让 hasTriggerToken 恒假，等于悄悄关掉触发。
    expect(config.assetReflection.triggerToken).toBe('/analyse');
    expect(config.assetReflection.alwaysOn).toBe(true);
    expect(config.assetReflection.maxChars).toBe(4000);
  });

  it('warns about unknown keys instead of failing', () => {
    expect(normalizeConfig({ nope: 1 }).warnings).toEqual(['unknown config key nope']);
    expect(normalizeConfig({ server: { nope: 1 } }).warnings).toEqual(['unknown config key server.nope']);
  });

  it('merges nested sections over the defaults', () => {
    const { config } = normalizeConfig({
      server: { teamId: 'team-override', requestTimeoutMs: 1500 },
      headPack: { maxChars: 123 },
      volatile: { enabled: false },
      tools: { recallTopK: 3 },
    });
    expect(config.server.teamId).toBe('team-override');
    expect(config.server.requestTimeoutMs).toBe(1500);
    expect(config.server.agentId).toBe(DEFAULT_CONFIG.server.agentId);
    expect(config.headPack.maxChars).toBe(123);
    expect(config.headPack.includeScenarioIndex).toBe(true);
    expect(config.volatile.enabled).toBe(false);
    expect(config.volatile.maxChars).toBe(DEFAULT_CONFIG.volatile.maxChars);
    expect(config.tools.recallTopK).toBe(3);
  });

  it('ships no identity and no private identifiers, only the real v3 paths', () => {
    const { config } = normalizeConfig({});
    // An install must never inherit someone else's memory account: the
    // isolation triple is empty until the profile patch provides it, and the
    // client then stays inert (see the next test).
    expect(config.server.teamId).toBe('');
    expect(config.server.agentId).toBe('');
    expect(config.server.userId).toBe('');
    expect(config.server.serviceId).toBe('default');
    // Local standalone MemoryCore stays the default origin; the README says how
    // to point it at the cloud.
    expect(config.server.baseUrl).toBe('http://127.0.0.1:8420');
    expect(config.paths).toEqual({
      coreRead: '/v3/core/read',
      atomicSearch: '/v3/atomic/search',
      scenarioLs: '/v3/scenario/ls',
      conversationAdd: '/v3/conversation/add',
      conversationDelete: '/v3/conversation/delete',
      // Second, independent pipeline: L0 feeds L1 facts, skill feeds L2 scenes.
      skillConversationAdd: '/v3/skill/conversation/add',
      // DS-RECALL-MERGE-001: merged soul + layered memory block; opt-in on the
      // server (v3Recall.enabled), so the client must tolerate a 404 here.
      recall: '/v3/recall',
      health: '/health',
      // Identity resolution (task-51): public metadata reads, no new core routes.
      metaAuthVerify: '/v3/meta/auth/verify',
      metaTeamList: '/v3/meta/team/list',
      metaAgentList: '/v3/meta/agent/list',
    });
    // The user key that resolves the triple is NOT the core api key: separate
    // fields, separate refs, and neither is shipped with a value.
    expect(config.server.userKey).toBe('');
    expect(config.server.userKeyRef).toBe('TDAI_USER_KEY');
    expect(config.server.apiKeyRef).not.toBe(config.server.userKeyRef);
  });

  it('trims a configured user key and keeps it out of the key ref', () => {
    const { config } = normalizeConfig({
      server: { userKey: '  user-key-123  ', userKeyRef: 'MY_USER_KEY' },
    });
    expect(config.server.userKey).toBe('user-key-123');
    expect(config.server.userKeyRef).toBe('MY_USER_KEY');
    // Supplying a user key must not make the profile look like it has an identity.
    expect(config.server.teamId).toBe('');
    expect(normalizeConfig({ server: { userKey: '   ' } }).config.server.userKey).toBe('');
  });

  it('feeds the L2 skill pipeline by default and allows opting out', () => {
    const { config } = normalizeConfig(undefined);
    expect(config.writeback.skillFeed).toBe(true);
    expect(DEFAULT_CONFIG.writeback.skillFeed).toBe(true);
    expect(normalizeConfig({ writeback: { skillFeed: false } }).config.writeback.skillFeed).toBe(false);
  });

  it('bounds the outbox so an unreachable core cannot grow it forever', () => {
    const { config } = normalizeConfig(undefined);
    expect(config.writeback.maxOutboxEntries).toBe(500);
    expect(config.writeback.maxOutboxBytes).toBe(20 * 1024 * 1024);

    // Clamped, not just defaulted: 0 entries would mean "drop every turn".
    expect(normalizeConfig({ writeback: { maxOutboxEntries: 0 } }).config.writeback.maxOutboxEntries).toBe(1);
    expect(normalizeConfig({ writeback: { maxOutboxBytes: 0 } }).config.writeback.maxOutboxBytes).toBe(1024);
    expect(normalizeConfig({ writeback: { maxOutboxEntries: 50 } }).config.writeback.maxOutboxEntries).toBe(50);
    expect(normalizeConfig({ writeback: { maxOutboxBytes: 5_000_000 } }).config.writeback.maxOutboxBytes)
      .toBe(5_000_000);
  });

  it('is inert (never touches the network) while the identity is unconfigured', async () => {
    const { config } = normalizeConfig(undefined);
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      throw new Error('the client must not call out without an identity');
    }) as unknown as typeof fetch;
    const client = new MemoryClient({
      baseUrl: config.server.baseUrl,
      apiKey: config.server.apiKey,
      apiKeyRef: config.server.apiKeyRef,
      identity: {
        serviceId: config.server.serviceId,
        teamId: config.server.teamId,
        agentId: config.server.agentId,
        userId: config.server.userId,
      },
      requestTimeoutMs: config.server.requestTimeoutMs,
      paths: config.paths,
      resolveApiKey: async () => undefined,
      fetchImpl,
    });

    await expect(client.readCore()).resolves.toBeUndefined();
    await expect(client.searchAtomic('pnpm', 3)).resolves.toEqual([]);
    await expect(client.listScenarios()).resolves.toEqual([]);
    await expect(
      client.addConversation('s1', [{ role: 'user', content: 'hi', timestamp: new Date().toISOString() }]),
    ).resolves.toBe(false);
    await expect(
      client.skillConversationAdd('s1', [{ role: 'user', content: 'hi' }]),
    ).resolves.toMatchObject({ ok: false, reason: 'identity missing (teamId)' });
    expect(calls).toEqual([]);
  });

  it('strips trailing slashes from the base url and rejects blank strings', () => {
    expect(normalizeConfig({ server: { baseUrl: 'http://127.0.0.1:8420///' } }).config.server.baseUrl)
      .toBe('http://127.0.0.1:8420');
    expect(normalizeConfig({ server: { baseUrl: '   ' } }).config.server.baseUrl)
      .toBe(DEFAULT_CONFIG.server.baseUrl);
  });

  it('keeps the budgets above the measured core cold-start cost', () => {
    const { config } = normalizeConfig(undefined);
    // Measured against the local core: the first atomic/search after an idle
    // period costs ~6.4s (cold embedding model), so a 4s budget silently lost
    // both the head pack and the first recall. Do not lower these.
    expect(config.server.requestTimeoutMs).toBe(10000);
    expect(config.headPack.timeoutMs).toBe(10000);
    expect(config.volatile.timeoutMs).toBe(3000);
    expect(config.server.requestTimeoutMs).toBeGreaterThan(6400);
    expect(config.headPack.timeoutMs).toBeGreaterThan(6400);
    // The volatile block rides in pre-step: bounded well below the read budget.
    expect(config.volatile.timeoutMs).toBeLessThan(config.server.requestTimeoutMs);
    // v0 ceiling for the per-step block, locked so a stray edit cannot raise it.
    // 1500 = 600 soul + ~900 memory. 1200 (was 800) was all memory: the soul
    // fragments never fit, so the plugin injected a personality-free block.
    expect(config.volatile.maxChars).toBe(1500);
    expect(DEFAULT_CONFIG.volatile.maxChars).toBe(1500);
    // The soul slice: on by default, 600 chars, feeling included.
    expect(config.volatile.soul).toEqual({ enabled: true, maxChars: 600, includeFeeling: true });
    // /v3/recall is session-aware and measured at 5.0s cold / 1.25-2.26s warm with
    // a fresh turn text: keep its own budget inside pre-step instead of the read
    // budget. 2500ms covers that distribution to ~p90 and still leaves 500ms of
    // the 3000ms volatile budget for the atomic/search fallback.
    expect(config.volatile.recall).toBe(true);
    expect(config.volatile.recallMaxResults).toBe(3);
    expect(config.volatile.recallTimeoutMs).toBe(2500);
    expect(config.volatile.recallTimeoutMs).toBeLessThan(config.server.requestTimeoutMs);
  });

  it('locks the capability segments to their measured defaults (task-74/97)', () => {
    const { config } = normalizeConfig(undefined);
    // Wiki is OFF by default: /v3/wiki/search has never answered on the 8420
    // build, so an enabled default would buy one 404 on every turn. The other
    // fields mirror wiki-segment.ts, which re-clamps whatever we hand it.
    expect(config.volatile.wiki).toEqual({
      enabled: false,
      topK: 3,
      perWikiLimit: 4,
      minScore: 0.02,
      maxChars: 800,
      timeoutMs: 2500,
    });
    // Knowledge is ON by default: /v3/knowledge/list answered 200 in 7ms with
    // one resource (2026-11-01 02:05), so an empty team costs one cheap call.
    expect(config.volatile.knowledge).toEqual({
      enabled: true,
      maxChars: 3000,
      maxResources: 8,
      timeoutMs: 2500,
    });

    // A config typo must not be able to blow the volatile block's budget: the
    // segment ceilings are clamped to the per-turn caps the seam enforces.
    const clamped = normalizeConfig({
      volatile: { wiki: { maxChars: 9000 }, knowledge: { maxChars: 9000, maxResources: 99 } },
    }).config;
    expect(clamped.volatile.wiki.maxChars).toBe(2000);
    expect(clamped.volatile.knowledge.maxChars).toBe(3000);
    expect(clamped.volatile.knowledge.maxResources).toBe(32);
  });

  it('caps writeback at the core wire limits and refuses to exceed them', () => {
    const { config } = normalizeConfig(undefined);
    // Core schema limits (wire-limits.ts): one message and one batch.
    expect(config.writeback.maxMessageChars).toBe(8192);
    expect(config.writeback.maxMessagesPerRequest).toBe(100);
    // Byte budget sits below the measured 0.9 MB success point; above the core's
    // 1 MiB socket wall the connection is destroyed without a 413.
    expect(config.writeback.maxRequestBytes).toBe(700000);

    // A config typo must not be able to reintroduce the 400-every-retry path.
    const raised = normalizeConfig({
      writeback: { maxMessageChars: 20000, maxMessagesPerRequest: 500 },
    }).config;
    expect(raised.writeback.maxMessageChars).toBe(8192);
    expect(raised.writeback.maxMessagesPerRequest).toBe(100);

    // Lowering is allowed (a privacy-conscious deployment may clip shorter).
    const lowered = normalizeConfig({
      writeback: { maxMessageChars: 1000, maxMessagesPerRequest: 20, maxRequestBytes: 300000 },
    }).config;
    expect(lowered.writeback.maxMessageChars).toBe(1000);
    expect(lowered.writeback.maxMessagesPerRequest).toBe(20);
    expect(lowered.writeback.maxRequestBytes).toBe(300000);

    // …but not below the socket wall either, and never to zero/negative.
    const raisedBytes = normalizeConfig({ writeback: { maxRequestBytes: 2000000 } }).config;
    expect(raisedBytes.writeback.maxRequestBytes).toBe(1000000);
    const zeroBytes = normalizeConfig({ writeback: { maxRequestBytes: 0 } }).config;
    expect(zeroBytes.writeback.maxRequestBytes).toBe(1);
  });

  it('never lets a timeout or interval collapse to 0ms', () => {
    // 0ms of patience aborts before the socket is written, which reads like a
    // permanent core outage; clamp every time budget to a >0 floor instead.
    const { config } = normalizeConfig({
      server: { requestTimeoutMs: 0 },
      headPack: { timeoutMs: 0, refreshMs: 0 },
      volatile: { timeoutMs: 0, recallTimeoutMs: 0 },
      writeback: { retryMs: 0 },
    });
    expect(config.server.requestTimeoutMs).toBe(100);
    expect(config.headPack.timeoutMs).toBe(100);
    expect(config.headPack.refreshMs).toBe(100);
    expect(config.volatile.timeoutMs).toBe(100);
    expect(config.volatile.recallTimeoutMs).toBe(100);
    expect(config.writeback.retryMs).toBe(100);

    // Real values above the floor still pass through untouched (4000 is not the
    // default, so this keeps testing the passthrough rather than the default).
    const kept = normalizeConfig({ volatile: { recallTimeoutMs: 4000 } }).config;
    expect(kept.volatile.recallTimeoutMs).toBe(4000);
  });

  it('takes AGEMEM_DEBUG from the environment unless the config says otherwise', () => {
    expect(debugFromEnv({})).toBeUndefined();
    expect(debugFromEnv({ AGEMEM_DEBUG: '' })).toBe(false);
    expect(debugFromEnv({ AGEMEM_DEBUG: '0' })).toBe(false);
    expect(debugFromEnv({ AGEMEM_DEBUG: 'off' })).toBe(false);
    expect(debugFromEnv({ AGEMEM_DEBUG: '1' })).toBe(true);
    expect(normalizeConfig(undefined).config.debug).toBe(false);
    expect(normalizeConfig({}, { AGEMEM_DEBUG: '1' }).config.debug).toBe(true);
    // A profile patch always wins over the ambient env.
    expect(normalizeConfig({ debug: false }, { AGEMEM_DEBUG: '1' }).config.debug).toBe(false);
    expect(normalizeConfig({ debug: true }, {}).config.debug).toBe(true);
  });

  it('clamps out-of-range numbers', () => {
    const { config } = normalizeConfig({ server: { requestTimeoutMs: 1 }, headPack: { maxChars: -5 } });
    expect(config.server.requestTimeoutMs).toBe(100);
    expect(config.headPack.maxChars).toBe(0);
  });

  it('budgets the L2 segment at 3000 by default and inside [0, 3000]', () => {
    expect(DEFAULT_CONFIG.headPack.l2Chars).toBe(3000);
    expect(normalizeConfig(undefined).config.headPack.l2Chars).toBe(3000);
    // Above the ceiling the segment would register with anyway.
    expect(normalizeConfig({ headPack: { l2Chars: 9000 } }).config.headPack.l2Chars).toBe(3000);
    // 0 is meaningful: render the switch on, contribute no characters.
    expect(normalizeConfig({ headPack: { l2Chars: -5 } }).config.headPack.l2Chars).toBe(0);
    expect(normalizeConfig({ headPack: { l2Chars: 1200 } }).config.headPack.l2Chars).toBe(1200);
  });

  it('keeps debugLogFile empty by default and passes an explicit path through', () => {
    // Empty is meaningful ("DSH_HOME/agemem/agemem.log"), so it must survive
    // normalization instead of being replaced by a resolved path here: the
    // entry resolves it at mount time, where DSH_HOME is known.
    expect(DEFAULT_CONFIG.debugLogFile).toBe('');
    expect(normalizeConfig(undefined).config.debugLogFile).toBe('');
    expect(normalizeConfig({ debugLogFile: '  D:/tmp/a.log  ' }).config.debugLogFile).toBe('D:/tmp/a.log');
    expect(normalizeConfig({ debugLogFile: 42 as unknown as string }).config.debugLogFile).toBe('');
  });

  it('treats a non-object config as defaults with a warning', () => {
    const { config, warnings } = normalizeConfig('oops');
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it('keeps secrets out of the config surface', () => {
    const serialized = JSON.stringify(DEFAULT_CONFIG);
    expect(serialized).not.toMatch(/authorization|bearer\s+[a-z0-9]{16,}/i);
    // No key ships: the ref names the core's key (not the proxy's TDB_API_KEY),
    // and the inline field is empty until a profile patch fills it.
    expect(DEFAULT_CONFIG.server.apiKey).toBe('');
    expect(DEFAULT_CONFIG.server.apiKeyRef).toBe('TDAI_GATEWAY_APIKEY');
    expect(DEFAULT_CONFIG.server.apiKeyRef).not.toBe('TDB_API_KEY');
    expect(normalizeConfig({ server: { apiKeyRef: 'OTHER_REF' } }).config.server.apiKeyRef).toBe('OTHER_REF');
  });
});
