/**
 * Context Injection Module — Public API.
 *
 * This module provides:
 * - Type definitions (AgentContext, InjectionHook, InjectionPoint, etc.)
 * - HookRegistry for registering injection hooks
 * - InjectionPipeline for executing the full injection flow
 * - Protocol adapters (OpenAI, Anthropic)
 * - Context utility functions
 */

// Types
export type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  AnchorRelation,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  ContextBlockType,
  ContextMessage,
  HookPriority,
  HookRegistry,
  InjectionHook,
  InjectionPoint,
  MessageRole,
  PrewarmInput,
  Protocol,
  SemanticSlot,
} from "./types.js";
export { HOOK_PRIORITY, INJECTION_POINTS } from "./types.js";

// Agent adaptation layer
export type { AgentProfile, PromptSegment, ResolvedAnchor, SegmentKind } from "./agents/interface.js";

// Content provider + generic hook factory
export type { ContextContentProvider, InjectionHookSpec } from "./provider.js";
export { createInjectionHook } from "./provider.js";

// Context utilities
export {
  appendTextToMessage,
  createAgentContext,
  getLastUserMessage,
  getMessageText,
  getSystemMessage,
  isFirstTurn,
  prependTextToMessage,
  textBlock,
  textMessage,
} from "./context.js";

// Registry
export { HookRegistryImpl } from "./registry.js";

// Pipeline
export { InjectionPipeline } from "./pipeline.js";

// Observer (injection pipeline observability)
export type { InjectionObserver, HookResult } from "./observer.js";
export { NoopInjectionObserver, LoggingInjectionObserver } from "./observer.js";

// Prewarm runner
export { prewarmAll } from "./prewarm.js";
export type { PrewarmOptions, PrewarmResult } from "./prewarm.js";

// Adapters
export type { ProtocolAdapter } from "./adapters/interface.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { AnthropicAdapter } from "./adapters/anthropic.js";

// Injectors
export { SkillInjector } from "./injectors/skill-injector.js";
export { SkillToolsInjector } from "./injectors/skill-tools-injector.js";
export { TdaiL1RecallInjector } from "./injectors/tdai-l1-recall-injector.js";
export { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
export { TdaiCurrentFeelingInjector } from "./injectors/tdai-current-feeling-injector.js";
export { TdaiToolsInjector } from "./injectors/tdai-tools-injector.js";
export { KnowledgeToolsInjector } from "./injectors/knowledge-tools-injector.js";
export { AssetReflectionInjector, renderAssetReflectionBlock } from "./injectors/asset-reflection-injector.js";

// CodeBuddy
export { isCodeBuddyPrompt, parseCodeBuddySystemPrompt } from "./agents/codebuddy/parser.js";
export { rebuildSystemPrompt, insertBeforeTag, insertAfterTag, appendInsideTag, prependInsideTag } from "./agents/codebuddy/serializer.js";
export { detectUnknownTags, classifyTags } from "./agents/codebuddy/constants.js";
export { CodeBuddyProfile } from "./agents/codebuddy/profile.js";

// Claude Code
export { ClaudeCodeProfile } from "./agents/claude-code/index.js";

// WorkBuddy — independent client (structurally XML-tag, wire protocol OpenAI/Responses).
// Deliberately kept as a distinct namespace with duplicated logic; no cross-imports
// from codebuddy/codex/claude-code.
export {
  WorkbuddyProfile,
  parseWorkbuddySystemPrompt,
  isWorkbuddyPrompt,
  WORKBUDDY_KNOWN_TAGS,
} from "./agents/workbuddy/index.js";

// ── Pipeline Factory ──────────────────────────────────────────────────────────

import os from "os";
import type { ProxyConfig } from "../types.js";
import { InjectionPipeline } from "./pipeline.js";
import { HookRegistryImpl } from "./registry.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { SkillInjector } from "./injectors/skill-injector.js";
import { SkillToolsInjector } from "./injectors/skill-tools-injector.js";
import { TdaiProfileMemoryInjector } from "./injectors/tdai-profile-memory-injector.js";
import { TdaiCurrentFeelingInjector } from "./injectors/tdai-current-feeling-injector.js";
import { TdaiL1RecallInjector } from "./injectors/tdai-l1-recall-injector.js";
import { TdaiClient } from "../tdai/client.js";
import { TdaiToolsInjector } from "./injectors/tdai-tools-injector.js";
import { KnowledgeToolsInjector } from "./injectors/knowledge-tools-injector.js";
import { AssetReflectionInjector } from "./injectors/asset-reflection-injector.js";
import {
  WikiRecallInjector,
  resolveBoundWikiResources,
  shouldRegisterWikiRecallInjector,
} from "./injectors/wiki-recall-injector.js";
import { getCoreKnowledgeClient } from "../knowledge/core-client.js";
import { WikiRetrieveClient } from "../knowledge/wiki-retrieve-client.js";
import { getTdaiIdentity } from "../tdai/identity.js";
import type { WikiRecallConfig } from "../types.js";
import type { ProtocolAdapter } from "./adapters/interface.js";
import type { AgentProfile } from "./agents/interface.js";
import { CodeBuddyProfile } from "./agents/codebuddy/profile.js";
import { ClaudeCodeProfile } from "./agents/claude-code/index.js";
import { WorkbuddyProfile } from "./agents/workbuddy/profile.js";
import { PiProfile } from "./agents/pi/index.js";
import { getHookCacheRepo, setHookCacheRepo, type HookCacheRepo } from "../db/hookCacheRepo.js";
import { getSessionRepo, setSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import { getRedisClient } from "../db/redis-client.js";
import { RedisSessionRepo } from "../db/redis-session-repo.js";
import { RedisHookCacheRepo } from "../db/redis-hook-cache-repo.js";
import { RedisBindingRepo } from "../db/binding-repo.js";
import { KvSessionRepo } from "../db/kv-session-repo.js";
import { KvHookCacheRepo } from "../db/kv-hook-cache-repo.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { getProxyStorage, getEffectiveBackend } from "../storage/factory.js";
import { FsStorage } from "../storage/fs-storage.js";
import { getSessionStore } from "../session/store.js";
import type { HookRegistry, PrewarmInput } from "./types.js";
import { prewarmAll, type PrewarmOptions, type PrewarmResult } from "./prewarm.js";
import { LoggingInjectionObserver, NoopInjectionObserver, LangfuseInjectionObserver } from "./observer.js";

// ... (rest)

interface PipelineBundle {
  pipeline: InjectionPipeline;
  registry: HookRegistry;
  hookCacheRepo?: HookCacheRepo;
}

let cachedBundle: PipelineBundle | null = null;
let cachedConfigHash = "";

/**
 * Try to activate ProxyStorage (Kv*Repo) if `storage.enabled`.
 *
 * When active, replaces the RedisSessionRepo / RedisHookCacheRepo /
 * RedisBindingRepo entirely with their Kv* equivalents.
 *
 * Returns true iff ProxyStorage repos were installed (Redis path bypassed).
 */
export function tryActivateStorage(config: ProxyConfig): boolean {
  if (!config.storage?.enabled) return false;
  try {
    const storage = getProxyStorage(config.storage);
    setSessionRepo(new KvSessionRepo(storage));
    setHookCacheRepo(new KvHookCacheRepo(storage));
    const store = getSessionStore();
    store.setBindingRepo(new KvBindingRepo(storage));
    const eff = getEffectiveBackend();
    console.log(
      `[injection] activated ProxyStorage (requested=${eff.requested}, effective=${eff.effective})`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[injection] ProxyStorage init failed, falling back to Redis/SQLite:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Try to activate Redis repos. Called once at pipeline build time, also exported for early activation. */
export function tryActivateRedis(config: ProxyConfig): boolean {
  if (!config.redis?.enabled) return false;
  try {
    const redis = getRedisClient(config.redis);
    if (!redis) return false;

    const ttl = config.redis.injectionTtlSeconds;
    setSessionRepo(new RedisSessionRepo(redis, ttl));
    setHookCacheRepo(new RedisHookCacheRepo(redis, ttl));
    const store = getSessionStore();
    store.setBindingRepo(new RedisBindingRepo(redis));
    console.log("[injection] activated Redis storage");
    return true;
  } catch (err) {
    console.warn("[injection] Redis unavailable, falling back to SQLite:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * session binding 必须始终持久化，不存在纯内存运行模式。
 *
 * 如果 storage 和 redis 都未激活（bindingRepo 仍为 undefined），
 * 用 fs 自动创建一个 KvBindingRepo 兜底。
 *
 * 默认路径: ~/.memory-tencentdb/proxy-state/ （与 MemoryCore 的
 * ~/.memory-tencentdb/memory-tdai/ 同级，保持项目数据聚拢）。
 * 可通过 config.storage.fs.fsRoot 或环境变量 PROXY_DATA_DIR 覆盖。
 *
 * 降级机制: fs 创建失败（权限不足、磁盘满等）→ 打 warn 回退到内存逻辑，
 * 不阻断 proxy 启动。用户可在线使用但 proxy 重启后需重新 session-init。
 */
export function ensureBindingRepoPersistent(config: ProxyConfig): void {
  const store = getSessionStore();
  if (store.getBindingRepo()) return; // 已有（storage/redis 激活过了）

  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const defaultFsRoot = `${home}/.memory-tencentdb/proxy-state`;
  const fsRoot = process.env.PROXY_DATA_DIR || config.storage?.fs?.fsRoot || defaultFsRoot;

  try {
    const fsStorage = new FsStorage(fsRoot);
    store.setBindingRepo(new KvBindingRepo(fsStorage));
    console.log(`[injection] bindingRepo fallback → fs (${fsRoot})`);
  } catch (err) {
    // 降级: fs 不可用时回退到内存逻辑，不阻断启动。
    // proxy 可正常运行，但重启后 binding 丢失 → 用户需重新 session-init。
    console.warn(
      `[injection] fs bindingRepo at ${fsRoot} failed: ${(err as Error).message}. ` +
      `Falling back to in-memory — session bindings will NOT persist across restarts.`,
    );
  }
}

/** Resolve `HookCacheRepo`. `getHookCacheRepo()` self-degrades to a NullRepo
 *  when better-sqlite3 is absent, so callers always receive a usable instance. */
function tryLoadHookCacheRepo(): HookCacheRepo | undefined {
  try {
    return getHookCacheRepo();
  } catch (err) {
    console.warn(
      "[injection] hook-cache repo unavailable, hooks will run without caching:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

function buildPipelineBundle(config: ProxyConfig): PipelineBundle {
  const registry = new HookRegistryImpl();
  const adapters = new Map<string, ProtocolAdapter>();
  adapters.set("openai", new OpenAIAdapter());
  adapters.set("anthropic", new AnthropicAdapter());

  // Register configured injectors. Each injector reads its own kernel config
  // (`coreSkill`, `tdai`, ...); there is no shared external endpoint anymore.
  const injectors = config.injection?.injectors ?? [];

  // proxyBaseUrl 在 skill-tools-injector 和 tdai-tools-injector 之间共享。
  //
  // ⚠️ 多节点部署必须显式配 `injection.externalGatewayUrl`（gateway 对外域名，
  // 例如 https://gateway.example.com）—— 否则每个 pod 会把
  // 自己的 host:port 嵌进 `<skill_tools>` / `<tdai_memory_tools>` 文本，
  // pods 互相覆盖 hook cache，同时上游 KV cache 每次 miss。
  //
  // 未配时 fallback 到本机 host:port（仅单节点 / 本地开发场景可用），启动时 warn 一次。
  let proxyBaseUrl: string | undefined;
  if (injectors.includes("skill") || (injectors.includes("tdai-memory") && config.tdai.enabled)) {
    const externalBase = config.injection?.externalGatewayUrl;
    if (externalBase && externalBase.length > 0) {
      proxyBaseUrl = externalBase.replace(/\/$/, "");
      console.log(`[injection] proxyBaseUrl (from injection.externalGatewayUrl) = ${proxyBaseUrl}`);
    } else {
      let hostIp = config.server.host;
      if (hostIp === "0.0.0.0" || hostIp === "127.0.0.1") {
        const interfaces = os.networkInterfaces();
        let foundIp = "";
        for (const name of Object.keys(interfaces)) {
          const iface = interfaces[name];
          if (!iface) continue;
          for (const entry of iface) {
            if (entry.family === "IPv4" && !entry.internal) {
              foundIp = entry.address;
              break;
            }
          }
          if (foundIp) break;
        }
        hostIp = foundIp || "127.0.0.1";
      }
      proxyBaseUrl = `http://${hostIp}:${config.server.port}`;
      console.warn(
        `[injection] injection.externalGatewayUrl not set — falling back to ` +
        `${proxyBaseUrl}. This causes hook cache thrashing + upstream KV-cache misses ` +
        `in multi-node deployments; set injection.externalGatewayUrl to the shared ` +
        `gateway domain (e.g. https://gateway.example.com).`,
      );
    }
  }

  if (injectors.includes("skill")) {
    // RAG-driven `<cloud_skills>` block. Calls /v3/skill/search at prewarm time.
    // When coreSkill is unconfigured (no serviceToken), the searchSkills call
    // will fail and the injector silently degrades to no <cloud_skills> block.
    registry.register(
      new SkillInjector({ coreSkill: config.coreSkill }),
    );

    // Always inject the curl-recipe `<skill_tools>` block alongside the
    // dynamic `<cloud_skills>` block. Even when there are no skills to
    // recommend, the LLM still needs to know how to create / search them.
    const allowLlmWrite = config.skillRuntime?.allowLlmWrite ?? false;
    registry.register(new SkillToolsInjector({ proxyBaseUrl: proxyBaseUrl!, allowLlmWrite }));
  }

  if (injectors.includes("knowledge")) {
    // Knowledge tools injector — fetches team knowledge from kernel and
    // renders <knowledge_tools> prompt block with two-step self-discovery flow.
    // Independent `knowledge:` config (endpoint can diverge from skill).
    if (shouldRegisterKnowledgeInjector(config)) {
      registry.register(new KnowledgeToolsInjector({
        coreSkill: config.knowledge,
      }));
    }

    // WikiRecallInjector — per-turn team wiki auto-recall (test-bed, direction B).
    // Registered under the same "knowledge" gate + an extra `wikiRecall.enabled`
    // switch so an operator can disable recall while keeping <knowledge_tools>.
    // Unknown `config.wikiRecall` (optional in ProxyConfig) falls back to defaults.
    if (shouldRegisterWikiRecallInjector(config)) {
      const knowledgeClient = getCoreKnowledgeClient(config.knowledge);
      // Retrieve client is rebuilt per bound wiki (endpoint-safe): each wiki has
      // its own service_url base — a single instance would miss other tenants' wikis.
      // serviceId 用当前请求的会话 spaceId（与 listBoundWiki 同源）；缺省回退
      // config.knowledge.serviceId。此前误用固定 config.knowledge.serviceId 导致
      // 检索租户与实际数据租户错位（404 wiki not found）。
      const makeRetrieve = (serviceUrl: string, serviceId?: string) =>
        new WikiRetrieveClient(
          serviceUrl,
          serviceId ?? config.knowledge.serviceId ?? "default",
          { timeoutMs: 3000 },
        );
      registry.register(new WikiRecallInjector(
        config.wikiRecall ?? defaultWikiRecallConfig,
        {
          knowledgeClient,
          retrieveClientFactory: (serviceUrl: string, serviceId?: string) =>
            makeRetrieve(serviceUrl, serviceId),
          identityResolver: (ctx) => getTdaiIdentity(ctx.metadata.custom),
          listBoundWiki: (ctx, teamId, agentId, userKey, spaceId) =>
            resolveBoundWikiResources(teamId, agentId, userKey, spaceId, knowledgeClient),
        },
      ));
    }
  }

  if (injectors.includes("tdai-memory") && config.tdai.enabled && config.tdai.memory.enabled && config.tdai.memory.inject) {
    // Base TdaiClient config. `TdaiProfileMemoryInjector` rebuilds a per-request
    // TdaiClient with `serviceId := session.space_id || baseConfig.serviceId`
    // so writes/recalls hit the correct kernel tenant (was hard-coded to
    // `config.tdai.serviceId` before; broke multi-tenant tests).
    const tdaiBaseConfig = {
      enabled: config.tdai.enabled && config.tdai.memory.enabled,
      endpoint: config.tdai.endpoint,
      apiKey: config.tdai.apiKey,
      serviceId: config.tdai.serviceId,
      writeL0: config.tdai.memory.writeL0,
      recallL1: config.tdai.memory.recallL1,
      injectL2L3: config.tdai.memory.injectL2L3,
      l1Limit: config.tdai.memory.l1Limit,
      l2Limit: config.tdai.memory.l2Limit,
      timeoutMs: config.tdai.memory.timeoutMs,
      appraisal: config.appraisal,
    };
    // fixed-asset-agents（self + 借入≤2）通过内核 MetadataClient 获取；
    // 内核不可达时 injector 自动降级为"只查当前 agent 的记忆"。
    if (config.tdai.memory.injectL2L3) {
      registry.register(new TdaiProfileMemoryInjector(tdaiBaseConfig, config.coreSkill));
      // T16（K3）current_feeling 解冻：感受块从 profile injector 的 session_init
      // 稳定缓存拆出，改为每轮重算（cacheStrategy="none" 不进 prewarm 白名单，
      // user.before 动态区 + 当轮真实用户消息）。与 profile injector 同条件注册，
      // 保持拆分前的功能开关语义（injectL2L3）不变。
      registry.register(new TdaiCurrentFeelingInjector(tdaiBaseConfig));
    }
    // L1 召回注入（2026-09-11 重新接线；2026-09-12 审查修补 I② 注释更正）：
    // 注意——本注入器（TdaiL1RecallInjector）走内核 /v3/atomic/search（"自有 + 借入"
    // 跨 agent 合并 top-K），**不是** MemoryCore 的 R7 九通道分层链路（selectL2Conclusions
    // + 预算对半 + 结论层幂等，before_prompt_build / auto-recall）；3667ddc 注释称
    // "R7 分层形态化解 KV cache 前提"对本注入器不成立，特此更正。
    // 两条链路相互独立、无跨链路防重——同一部署若同时启用（本开关 recallL1=true 且
    // MemoryCore recall.enabled=true），同一轮存在双重 L1 注入风险。防线：
    //   ① 配置默认只开一条链路：recallL1 缺省 false（DEFAULT_CONFIG，见 src/config.ts），
    //     默认形态只有 MemoryCore before_prompt_build 一条 L1 注入链路；
    //   ② 注入器侧标记跳过（审查修补 I②）：当轮用户消息已含 MemoryCore 注入块固定
    //     标记头 <relevant-memories> → TdaiL1RecallInjector 直接退出（见该类 execute）。
    // recallL1 配置开关维持语义：true = 额外启用本注入器（纯工具制之外的自动召回）。
    // 配套 profile-memory-injector：L2 仅注入 path 索引；LLM 通过 Bash curl
    // <proxy>/memory-bridge/v3/* 调用只读工具。proxy 自动注入身份。
    // proxyBaseUrl 复用 skill-tools-injector 算出来的（同一 host:port）。
    if (typeof proxyBaseUrl !== "undefined") {
      registry.register(new TdaiToolsInjector({ proxyBaseUrl }));
    }
    // L1 召回注入器注册（独立于 injectL2L3 门——L1 召回与 L2/L3 注入是两个开关）
    if (
      config.tdai.enabled &&
      config.tdai.memory.enabled &&
      config.tdai.memory.recallL1 &&
      typeof proxyBaseUrl !== "undefined"
    ) {
      const l1Client = new TdaiClient({
        enabled: true,
        endpoint: config.tdai.endpoint,
        apiKey: config.tdai.apiKey,
        serviceId: config.tdai.serviceId,
        writeL0: config.tdai.memory.writeL0,
        recallL1: true,
        injectL2L3: config.tdai.memory.injectL2L3,
        l1Limit: config.tdai.memory.l1Limit,
        l2Limit: config.tdai.memory.l2Limit,
        timeoutMs: config.tdai.memory.timeoutMs,
      });
      registry.register(
        // R7 复审 Minor ③：globalTopK 由硬编码 5 改为读 tdai.memory.l1GlobalTopK
        // （缺省 5 = 现行为不变，见 config.ts DEFAULT_CONFIG / config.yaml 注释）。
        new TdaiL1RecallInjector(
          l1Client,
          config.coreSkill,
          undefined,
          config.tdai.memory.l1GlobalTopK,
          l1Client,
        ),
      );
    }
  }

  // ── Asset Reflection (内部效果评估) ─────────────────────────────────────
  // 默认开启（markerOptIn=true）—— 未配置 assetReflection 的 pod 也 register
  // 本 injector。register 只是加进 registry，marker 未命中时 execute() 直接
  // 返回 []，正常请求 prompt 完全不变；只有请求 URL 带 `/analyse` marker
  // 才真 emit 块。Tag 列表由本节点上"实际 register 了的资产 injector"派生，
  // 避免让 LLM 反思一个本节点根本没接入的资产。
  //
  // 显式配 markerOptIn=false 时 injector 不 register，且 server.ts 顶部 gate
  // 会把任何带 `/analyse/` 段的请求 404 拒。
  if (config.injection?.assetReflection?.markerOptIn) {
    const registeredIds = new Set(registry.getAll().map((h) => h.id));
    const activeAssetTags: string[] = [];
    // Skill 家族：SkillInjector 出 <available_skills>，SkillToolsInjector 出 <skill_tools>；
    // 两个 injector 一起启用（见上文 `if (injectors.includes("skill"))`），任一存在都算 skill 资产命中。
    if (registeredIds.has("skill-injector") || registeredIds.has("skill-tools-injector")) {
      activeAssetTags.push("skill_tools");
      activeAssetTags.push("available_skills");
    }
    if (registeredIds.has("tdai-memory-tools-injector")) {
      activeAssetTags.push("tdai_memory_tools");
    }
    if (registeredIds.has("knowledge-tools-injector")) {
      activeAssetTags.push("knowledge_tools");
    }
    if (activeAssetTags.length > 0) {
      registry.register(new AssetReflectionInjector({ activeAssetTags }));
      console.log(`[injection] asset-reflection registered, tags=[${activeAssetTags.join(",")}]`);
    } else {
      console.log(`[injection] asset-reflection markerOptIn=true 但本节点无资产 injector，跳过 register`);
    }
  }

  // Activate storage backend if configured (before loading repos).
  // ProxyStorage (COS/SQLite/FS/Memory) takes precedence when storage.enabled;
  // otherwise fall back to the original Redis path.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // session binding 必须始终持久化 — 不存在纯内存模式。
  // 如果 storage 和 redis 都未激活，用 fs 作为 bindingRepo 兜底。
  ensureBindingRepoPersistent(config);

  const hookCacheRepo = tryLoadHookCacheRepo();

  // Observer: prefer Langfuse (injection spans under LLM trace) when enabled;
  // fall back to structured logging when log level ≤ info; else noop.
  const observer = config.langfuse?.enabled
    ? new LangfuseInjectionObserver()
    : (config.log?.level === "debug" || config.log?.level === "info")
      ? new LoggingInjectionObserver()
      : new NoopInjectionObserver();

  const pipeline = new InjectionPipeline(registry, adapters, {
    hookCacheRepo,
    // Agent profile registry — lookup by URL path prefix (agentSource).
    // Adding a new agent only adds a line here. The legacy detectAgent
    // (content-scanning) is kept as fallback for un-prefixed paths.
    agentProfiles: new Map<string, AgentProfile>([
      ["codebuddy", new CodeBuddyProfile()],
      ["claude-code", new ClaudeCodeProfile()],
      ["workbuddy", new WorkbuddyProfile()],
      ["pi", new PiProfile()],
      // ["cursor", new CursorProfile()],
    ]),
    // Legacy fallback: scan system prompt content (for backward compat).
    detectAgent: (() => {
      const agentProfiles: AgentProfile[] = [
        new CodeBuddyProfile(),
        new ClaudeCodeProfile(),
        new WorkbuddyProfile(),
      ];
      return (systemText: string) =>
        agentProfiles.find((p) => p.detect(systemText)) ?? null;
    })(),
  }, observer);

  return { pipeline, registry, hookCacheRepo };
}

function getOrBuildBundle(config: ProxyConfig): PipelineBundle {
  const configHash = JSON.stringify({
    injection: config.injection,
    tdai: config.tdai,
    coreSkill: config.coreSkill,
    knowledge: config.knowledge,
    server: config.server,
  });
  if (cachedBundle && cachedConfigHash === configHash) {
    return cachedBundle;
  }
  cachedBundle = buildPipelineBundle(config);
  cachedConfigHash = configHash;
  return cachedBundle;
}

/**
 * Get or create an InjectionPipeline configured from ProxyConfig.
 * The pipeline is cached and reused for the lifetime of the config.
 */
export function getInjectionPipeline(config: ProxyConfig): InjectionPipeline {
  return getOrBuildBundle(config).pipeline;
}

/**
 * Drive `prewarmAll` against the same HookRegistry / HookCacheRepo used by
 * the live pipeline. Intended for the session_init hot path: call this once
 * per session immediately after the control plane returns `sessionInfo`.
 *
 * Errors are NEVER thrown — caller can safely `await` without try/catch.
 */
export async function prewarmFromConfig(
  config: ProxyConfig,
  input: PrewarmInput,
  opts?: PrewarmOptions,
): Promise<PrewarmResult> {
  const bundle = getOrBuildBundle(config);
  // No persistence layer or no hooks declaring strategy → noop with empty result.
  if (!bundle.hookCacheRepo) {
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
  try {
    return await prewarmAll(bundle.registry, bundle.hookCacheRepo, input, opts);
  } catch (err) {
    console.warn(
      "[hook-cache] prewarmFromConfig swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
    return { cachedHookIds: [], skipped: [], durationMs: 0 };
  }
}

/**
 * Pure predicate: should the knowledge-tools injector be registered?
 * Exposed for unit tests (registry itself is not publicly introspectable).
 *
 * Conditions (all must hold):
 *   1. `injection.injectors` includes "knowledge"
 *   2. `knowledge.enabled` is true
 *   3. `knowledge.serviceToken` is non-empty
 */
export function shouldRegisterKnowledgeInjector(config: ProxyConfig): boolean {
  return config.injection.injectors.includes("knowledge")
    && config.knowledge.enabled
    && !!config.knowledge.serviceToken;
}

/** WikiRecallInjector 缺省参数（config.wikiRecall 缺失/整段时兜底）。导出仅供同形验证断言。 */
export const defaultWikiRecallConfig: WikiRecallConfig = {
  enabled: true,
  perWikiLimit: 8,
  globalTopK: 5,
  minScore: 0.02,
  hop: 0,
  decay: 0.5,
  maxTotalChars: 0,
  minInjectNormScore: 0.6,
  // W5（T18-B）：新增结构页权重 other/log/index/schema = 0.3（结构页同时在
  // wiki-recall-injector 排尾不竞争 top-K，权重为兜底乘法项）；既有 3 项保留。
  typeWeights: { entity: 0.6, concept: 0.9, overview: 0.6, other: 0.3, log: 0.3, index: 0.3, schema: 0.3 },
  // C3（2026-09-10）domainRouter 默认退役：09-09 隔离实验（锚点 evals/recall-golden/
  // runs/2026-09-10T04-07-38.json，B on vs E off 同语料快照）实证——部署工作点
  // （tw09/rel0.6/absGate1.5）router 对 posRecall 单变量贡献=0（0.66 vs 0.66）、
  // negInjected 恒 +2（13 vs 11），且 W4 boost→归一→注入门耦合未解。
  // **显式退役标记**：keywords 空表 → injector 跨库软定域恒 no-op（能力形状保留，
  // 重开只需填 keywords）。重开 router 前必须：(a) 先归档 router-on 实验；
  // (b) 先解耦 W4（boost 作用于归一前分数、直接受注入门放大）——独立任务。
  domainRouter: { boost: 1.5, keywords: {} },
};

/** Test-only: drop the cached pipeline so the next call rebuilds from config. */
export function __resetInjectionPipelineForTests(): void {
  cachedBundle = null;
  cachedConfigHash = "";
}
