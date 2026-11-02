/**
 * TDAI Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `tdai-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { isSetCredential } from "../utils/credential.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import { readSettingsOverride, pickDefined, applyRerankOverrideToRaw, applyImportancePenaltyOverrideToRaw, applyWorthinessOverrideToRaw, applyExtractionOverrideToRaw, applyLayerRulerOverrideToRaw, applyInjectionOverrideToRaw } from "./settings-override.js";

// ============================
// Gateway config types
// ============================

/**
 * Deployment mode determines how the system manages state and coordination:
 *
 * - "standalone": Open-source single-node mode.
 *     Pipeline state lives in-process (Map/setTimeout/SerialQueue).
 *     No external dependencies beyond LLM API and optional VDB.
 *     Suitable for single-machine / sidecar / developer setups.
 *
 * - "service": Cloud service (multi-tenant) mode.
 *     Pipeline state is externalized through IStateBackend.
 *     Timer Scanner + Pipeline Worker run inside the gateway process.
 *     Supports multi-replica coordination and HA.
 *     May require deployment-specific remote backends.
 */
export type DeployMode = "standalone" | "service";


export interface SharkConfig {
  baseUrl?: string;
  vdbTtlMs: number;
  cosBufferMs: number;
  maxInstances: number;
}

export interface ScannerConfig {
  instances: string;
  instancesSharkUrl?: string;
  intervalMs: number;
  nodeId?: string;
}

export interface WorkerConfig {
  pollMs: number;
  /** 并发消费协程数 (default: 60) */
  concurrency: number;
}

export interface CosExtraConfig {
  domain?: string;
  /** Generation log retention in days. Default: 30. Set 0 to disable lifecycle management. */
  generationLogRetentionDays: number;
}

/**
 * 可观测性配置（DSH-only）。
 *
 * 四组件架构（OTel SDK / ClickHouse 双写 / Kafka / Langfuse）已整组退场
 * （docs/adr/0021）：只剩进程内的 noop 与 console 两个后端。
 *
 * yaml 示例:
 * ```yaml
 * observability:
 *   type: "noop"   # 或 "console"
 * ```
 *
 * 仍写着 otel/clickhouse/kafka/langfuse 段的旧配置：enabled=false 会被忽略并打一条
 * 警告；enabled=true 直接启动失败（不做静默降级）。
 */
export interface ObservabilityConfig {
  /** 观测后端。"noop"（默认，零副作用）或 "console"（打到 stdout）。 */
  type: "noop" | "console";
}

export interface GatewayConfig {
  /**
   * Deployment mode. Default: "standalone".
   *
   * env: TDAI_DEPLOY_MODE=standalone|service
   * yaml: deployMode: service
   */
  deployMode: DeployMode;
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `TDAI_GATEWAY_APIKEY`（主用；兼容存量别名 `TDAI_GATEWAY_API_KEY`，
     *      双名同设时无下划线优先——S3 env 双名统一）
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `TDAI_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for TDAI data storage. */
    baseDir: string;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-tdai plugin config (recall, capture, extraction, pipeline, etc.). */
  memory: MemoryTdaiConfig;

  /**
   * Optional Skill module config — passed through to MemoryTdaiConfig.skill
   * at load time. Kept at the top level here so gateway-only deployments
   * can configure skills without nesting under `memory.skill`. The loader
   * shallow-merges this onto `memory.skill` (yaml top-level wins).
   */
  skill?: import("../core/skill/types.js").SkillConfigInput;

  // ── Service-mode config (also settable via env vars, env takes priority) ──

  /** State backend type. env: STATE_BACKEND. yaml: stateBackend */
  stateBackend?: "local";
  /** Default instance ID for standalone pipeline. env: TDAI_INSTANCE_ID. yaml: instanceId */
  instanceId: string;

  shark: SharkConfig;
  scanner: ScannerConfig;
  worker: WorkerConfig;
  cos: CosExtraConfig;
  /** 可观测性配置 (yaml: observability, env: KAFKA_METRIC_*) */
  observability: ObservabilityConfig;
  /**
   * 元数据模块配置（env 优先于 yaml；见 applyMetadataEnvFromGatewayConfig）。
   * yaml: metadata.*
   * env: TDAI_METADATA_*
   */
  metadata: GatewayMetadataConfig;
}

/** v3 元数据 Gateway yaml 配置（§6.3）。 */
export interface GatewayMetadataStoreConfig {
  sqliteBaseDir?: string;
  /** 内存中最多缓存多少个实例 store 连接（LRU 驱逐）。 */
  storeCacheMaxInstances?: number;
  /** 元数据库名前缀，默认 tdai_metadata；库名 {prefix}_{instance_id} */
  mongoDbPrefix?: string;
}

export interface GatewayMemorySystemUserConfig {
  userId?: string;
  displayName?: string;
  userKey?: string;
}

export interface GatewayMetadataSystemUserConfig {
  memory?: GatewayMemorySystemUserConfig;
}

export interface GatewayMetadataConfig {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
  configParamsFile?: string;
  store?: GatewayMetadataStoreConfig;
  /** 内部静态系统用户（仅 auth/verify；不落库）。 */
  systemUser?: GatewayMetadataSystemUserConfig;
}

// ============================
// Config loading
// ============================

// ============================
// Utility Functions
// ============================



/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `TDAI_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./tdai-gateway.yaml` or `./tdai-gateway.json` in CWD
 * 3. `<dataDir>/tdai-gateway.yaml` or `<dataDir>/tdai-gateway.json`
 * 4. Pure environment-variable config (no file)
 */
export function loadGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch (err) {
      // Config file is optional — malformed files fall back to env-only config
      // (verify-s1 pins this fallback as an explicit assertion; do NOT remove).
      // But the failure itself must be LOUD: a silently swallowed parse error
      // (e.g. UTF-16 BOM from a Windows-edited yaml) boots the gateway on bare
      // defaults while looking perfectly healthy — the 09-10 login-outage
      // amplifier. Startup has no logger yet, and this runs once at boot (+ in
      // tests), so console.error is the correct, non-spammy tool.
      console.error(
        `[config] Gateway config file failed to parse: ${configPath} — ${err instanceof Error ? err.message : String(err)} (falling back to env-only config)`,
      );
    }
  }

  // Server config
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("TDAI_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("TDAI_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  // S3（T11+13 审计 M-1）env 双名：主用 `TDAI_GATEWAY_APIKEY`（无下划线，
  // 与 MemoryProxy / MemoryPanel 既有 env 名统一，跨进程同源），兼容存量
  // `TDAI_GATEWAY_API_KEY`；双名同设时无下划线优先。yaml `server.apiKey`
  // 仍为最后兜底，解析优先级 env > env(legacy) > yaml 不变。
  const apiKey = env("TDAI_GATEWAY_APIKEY") ?? env("TDAI_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  //
  // provider 唯一取值 "openai"（OpenAI 兼容端点直连）。原 "proxy"（走 context_proxy、
  // 运行期把 baseUrl 拼成 `${baseUrl}/proxy/<iid>/v1`、Authorization 用 memory 系统
  // 用户 key）已随 MemoryProxy 退出链路整体下线（DSH 特化 2026-11-01）。
  const llmConfig = obj(fileConfig, "llm");
  // DSH 特化（2026-11-01）：MemoryProxy 退出链路 ⇒ provider 只保留 "openai"（OpenAI 兼容端点）。
  // 历史配置里 provider: "proxy" 的取值不再被采用：baseUrl 若仍指向 8096，运行期会在
  // gateway/llm-resolver.ts 得到明确的「proxy 已下线」错误，而不是静默走到错误端点。
  const llmProvider: "openai" = "openai";
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    // ADR-0006（#70）：apiKey yaml 优先，env 仅 deprecated 回退（loud 告警）；
    // 占位符（__X__ / ${X}）视为未设置。override（config-override.json）在下方 :516 Object.assign 最后落。
    apiKey: resolveLlmApiKey(str(llmConfig, "apiKey")),
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    provider: llmProvider,
    // env 存在时直接用 env 解析(可显式关闭 yaml);
    // env 未设置才回退 yaml,与其他 LLM 字段语义一致。
    stream: (() => {
      const envVal = env("TDAI_LLM_STREAM");
      if (envVal !== undefined) return envVal === "true";
      return bool(llmConfig, "stream") ?? false;
    })(),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const topLevelPromptMode = str(fileConfig, "promptMode") ?? str(obj(fileConfig, "prompts"), "mode");
  const memoryCompatRaw: Record<string, unknown> = { ...memoryRaw };
  if (!str(memoryCompatRaw, "promptMode") && topLevelPromptMode) {
    memoryCompatRaw.promptMode = topLevelPromptMode;
  }

  // ── Admin settings override（{baseDir}/config-override.json）> yaml > TDAI_LLM_* env(deprecated)（ADR-0006；llm.apiKey 解析链同序，见 resolveLlmApiKey）──
  // rerank 段（P1 task-4）必须并入 parse 之前的 raw：rerank 的 provider 校验/
  // 非法回退 none/enabled 强制关闭/clamp 语义全部在 parseConfig 的 rerank 块内，
  // parse 后合并会绕过这些不变量（applyRerankOverrideToRaw 只在 memoryCompatRaw
  // 层做 recall.rerank 的浅/局部合并）。读取提前到此，llm 的 override 合并仍在
  // parse 之后（见下，保证 splice 到 memory.llm 的已是 override 后的值）。
  const settingsOverride = readSettingsOverride(baseDir);
  // P1 task-7：importancePenalty/worthiness 段同样必须并入 parse 之前的 raw
  //（enabled/penalty clamp/extractionEnabled 缺省语义在 parseConfig 内）。
  // #179 S5：layerRuler/injection 段同样在 parse 之前并入（mode 白名单 / keepRatio
  // clamp / minPerLayer 取整 / floor 形状 / budgetByIntent null 语义都在 parseConfig 内）。
  const memoryCompatWithRerank = applyInjectionOverrideToRaw(
    applyLayerRulerOverrideToRaw(
      applyImportancePenaltyOverrideToRaw(
        applyWorthinessOverrideToRaw(
          applyExtractionOverrideToRaw(
            applyRerankOverrideToRaw(memoryCompatRaw, settingsOverride?.rerank),
            settingsOverride?.extraction,
          ),
          settingsOverride?.worthiness,
        ),
        settingsOverride?.importancePenalty,
      ),
      settingsOverride?.layerRuler,
    ),
    settingsOverride?.injection,
  );
  const memory = parseMemoryConfig(memoryCompatWithRerank);

  // 注意：embedding 的 override 合并不能放在这里 —— 下方"Standalone embedding
  // override pass-through"兼容 splice 在其后执行，会把 yaml 顶层 embedding 字段
  // 反向盖回 override 值；embedding 合并统一挪到该 splice 块之后（见下）。
  if (settingsOverride?.llm) Object.assign(llm, pickDefined(settingsOverride.llm));

  // ── Standalone LLM override pass-through to MemoryTdaiConfig.llm ──
  // The gateway has its own top-level `llm` block (read above into the
  // `llm` variable), and `parseMemoryConfig` ALSO has a `memory.llm` block
  // that defaults to enabled=false. When the gateway's top-level llm is
  // configured (baseUrl + apiKey), splice it onto memory.llm so the
  // SkillExtractor / L1 / L2 / L3 runners see a usable runner without
  // requiring the user to duplicate the block under `memory.llm`.
  // provider=proxy 已下线 ⇒ 只有显式配置了 llm.apiKey 才 splice（空 apiKey = 未配置）。
  const shouldSpliceLlm = !memory.llm.enabled && Boolean(llm.baseUrl) && Boolean(llm.apiKey);
  if (shouldSpliceLlm) {
    memory.llm = {
      enabled: true,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      maxTokens: llm.maxTokens ?? 4096,
      timeoutMs: llm.timeoutMs ?? 120_000,
      provider: llm.provider,
    };
  }

  // ── Standalone embedding override pass-through ──
  // Some existing gateway configs place `embedding` at the top level next to
  // `llm`. The memory parser expects it under `memory.embedding`, so splice the
  // top-level block into MemoryTdaiConfig for backward compatibility.
  const topLevelEmbedding = obj(fileConfig, "embedding");
  if (topLevelEmbedding) {
    memory.embedding = {
      ...memory.embedding,
      enabled: bool(topLevelEmbedding, "enabled") ?? memory.embedding.enabled,
      provider: str(topLevelEmbedding, "provider") ?? memory.embedding.provider,
      baseUrl: str(topLevelEmbedding, "baseUrl") ?? memory.embedding.baseUrl,
      apiKey: str(topLevelEmbedding, "apiKey") ?? memory.embedding.apiKey,
      model: str(topLevelEmbedding, "model") ?? memory.embedding.model,
      dimensions: num(topLevelEmbedding, "dimensions") ?? memory.embedding.dimensions,
      sendDimensions: bool(topLevelEmbedding, "sendDimensions") ?? memory.embedding.sendDimensions,
      conflictRecallTopK: num(topLevelEmbedding, "conflictRecallTopK") ?? memory.embedding.conflictRecallTopK,
      maxInputChars: num(topLevelEmbedding, "maxInputChars") ?? memory.embedding.maxInputChars,
      timeoutMs: num(topLevelEmbedding, "timeoutMs") ?? memory.embedding.timeoutMs,
      recallTimeoutMs: num(topLevelEmbedding, "recallTimeoutMs") ?? memory.embedding.recallTimeoutMs,
      captureTimeoutMs: num(topLevelEmbedding, "captureTimeoutMs") ?? memory.embedding.captureTimeoutMs,
    };
  }

  // ── Admin settings override：embedding 段 ──
  // 必须放在上方"Standalone embedding override pass-through"兼容 splice 之后：
  // 该 splice 以 `str(yaml,"X") ?? memory.embedding.X` 逐字段回填 yaml 顶层
  // embedding，若 override 在它之前合并，yaml 值会反向覆盖 admin override，
  // 违背 spec §3.2 优先级（config-override.json > env > yaml；embedding 的 env 优先
  // 不受 ADR-0006 影响 —— ADR-0006 只改 llm.apiKey 这一秘密字段的通道序）。
  // override 最后落，保证其优先级最高；未指定的字段仍保留 yaml/默认值。
  if (settingsOverride?.embedding) {
    memory.embedding = { ...memory.embedding, ...pickDefined(settingsOverride.embedding) } as typeof memory.embedding;
    // ADR-0006 回归修复（2026-10-19 生产实锚）：parseConfig 的 embedding enabled 判定跑在
    // 本次 override 合并之前——yaml memory.embedding.apiKey 用 "${TDAI_LLM_API_KEY}" 占位
    // （一把 key 同源设计），env 键按 ADR-0006 迁移删除后 expandEnvVars 整串展开为空串 →
    // parseConfig 判 disabled（configError 记 missing apiKey）。override 补齐字段后必须
    // 重跑判定救回：enabled 的最终状态只能由最终合并值决定，不能由合并前的中间态定死。
    // 判定语义与 parseConfig embedding 块对齐：none/local 恒 disabled；（qclaw 已随
    // MemoryProxy 下线，不再单独要求 proxyUrl）。
    // 其余 remote 需 apiKey/baseUrl/model/dimensions>0 全齐。
    const me = memory.embedding as typeof memory.embedding & { configError?: string };
    const embProvider = me.provider;
    if (!me.enabled && embProvider !== "none" && embProvider !== "local") {
      const missing = [
        !me.apiKey && "apiKey",
        !me.baseUrl && "baseUrl",
        !me.model && "model",
        !(typeof me.dimensions === "number" && me.dimensions > 0) && "dimensions",
        ].filter((x): x is string => Boolean(x));
      if (missing.length === 0) {
        me.enabled = true;
        me.configError = undefined;
      }
    }
  }

  // ── Skill module config ──
  // Resolution order:
  //   1. Top-level `skill` block in yaml (preferred — skill is a top-level
  //      gateway feature, not buried under `memory`).
  //   2. `memory.skill` (if user nested it under memory by accident).
  //   3. env var TDAI_SKILL_ENABLED forces enabled=true so a one-line
  //      shell flag opts in without touching yaml.
  // The result is *also* spliced onto memory.skill so TdaiCore (which reads
  // from cfg.skill in its config) sees it regardless of which path wired it.
  const topLevelSkill = (fileConfig.skill && typeof fileConfig.skill === "object" && !Array.isArray(fileConfig.skill))
    ? (fileConfig.skill as import("../core/skill/types.js").SkillConfigInput)
    : undefined;
  const envSkillEnabled = env("TDAI_SKILL_ENABLED");
  const skillFromAnywhere: import("../core/skill/types.js").SkillConfigInput | undefined =
    topLevelSkill ?? memory.skill ?? (envSkillEnabled === "true" || envSkillEnabled === "1" ? { enabled: true } : undefined);
  if (skillFromAnywhere) {
    // Last write wins: env-only override forces enabled=true on top of yaml.
    if (envSkillEnabled === "true" || envSkillEnabled === "1") {
      skillFromAnywhere.enabled = true;
    }
    memory.skill = skillFromAnywhere;
  }

  // Deploy mode. "service" depended on the Redis state backend, the TCVDB memory store, the
  // MongoDB metadata store and the private integrations submodule — all retired in the
  // DSH-only build (docs/adr/0021). Fail startup instead of degrading to a lookalike.
  const rawMode = env("TDAI_DEPLOY_MODE") ?? str(fileConfig, "deployMode") ?? "standalone";
  if (rawMode !== "standalone") {
    throw new Error(
      `[gateway-config] deployMode "${rawMode}" has been retired in the DSH-only build ` +
        `(Redis state backend + TCVDB memory store + MongoDB metadata store + private ` +
        `integrations submodule were removed). Set deployMode: "standalone" — see docs/adr/0021.`,
    );
  }
  const deployMode: DeployMode = "standalone";

  // State backend: only the in-process "local" backend remains.
  const rawBackend = env("STATE_BACKEND") ?? str(fileConfig, "stateBackend");
  if (rawBackend !== undefined && rawBackend !== "" && rawBackend !== "local") {
    throw new Error(
      `[gateway-config] stateBackend "${rawBackend}" has been retired in the DSH-only build ` +
        `(the Redis state backend was removed). Set stateBackend: "local" or drop the key — ` +
        `see docs/adr/0021.`,
    );
  }
  const stateBackend: "local" = "local";

  // Instance ID: standalone mode uses the configured value or defaults to "default".
  const instanceId = env("TDAI_INSTANCE_ID") ?? str(fileConfig, "instanceId") ?? "default";

  // Remote config source settings
  const sharkConfig = obj(fileConfig, "shark");
  const shark: SharkConfig = {
    baseUrl: env("SHARK_BASE_URL") ?? str(sharkConfig, "baseUrl"),
    vdbTtlMs: envInt("CONFIG_VDB_TTL_MS") ?? num(sharkConfig, "vdbTtlMs") ?? 300_000,
    cosBufferMs: envInt("CONFIG_COS_BUFFER_MS") ?? num(sharkConfig, "cosBufferMs") ?? 120_000,
    maxInstances: envInt("CONFIG_MAX_INSTANCES") ?? num(sharkConfig, "maxInstances") ?? 1000,
  };

  // Scanner config
  const scannerConfig = obj(fileConfig, "scanner");
  const scanner: ScannerConfig = {
    instances: env("SCANNER_INSTANCES") ?? str(scannerConfig, "instances") ?? "default",
    instancesSharkUrl: env("SCANNER_INSTANCES_SHARK_URL") ?? str(scannerConfig, "instancesSharkUrl"),
    intervalMs: envInt("SCANNER_INTERVAL_MS") ?? num(scannerConfig, "intervalMs") ?? 500,
    nodeId: env("SCANNER_NODE_ID") ?? str(scannerConfig, "nodeId"),
  };

  // Worker config
  const workerConfig = obj(fileConfig, "worker");
  const worker: WorkerConfig = {
    pollMs: envInt("WORKER_POLL_MS") ?? num(workerConfig, "pollMs") ?? 200,
    concurrency: envInt("WORKER_CONCURRENCY") ?? num(workerConfig, "concurrency") ?? 60,
  };

  // COS extra config
  const cosConfig = obj(fileConfig, "cos");
  const cos: CosExtraConfig = {
    domain: env("COS_DOMAIN") ?? str(cosConfig, "domain"),
    generationLogRetentionDays: envInt("COS_GENERATION_LOG_RETENTION_DAYS")
      ?? num(cosConfig, "generationLogRetentionDays")
      ?? 30,
  };
  if (!Number.isInteger(cos.generationLogRetentionDays) || cos.generationLogRetentionDays < 0) {
    throw new Error("cos.generationLogRetentionDays must be a non-negative integer");
  }

  // Observability config (DSH-only): only the in-process noop / console backends remain.
  // A config that still enables otel / clickhouse / kafka / langfuse fails startup instead
  // of silently dropping telemetry (docs/adr/0021).
  const observabilityConfig = obj(fileConfig, "observability");
  const rawObservabilityType =
    env("TDAI_OBSERVABILITY_TYPE") ?? str(observabilityConfig, "type") ?? "noop";
  if (rawObservabilityType !== "noop" && rawObservabilityType !== "console") {
    throw new Error(
      `[gateway-config] observability.type "${rawObservabilityType}" has been retired in the ` +
        `DSH-only build (only "noop" and "console" remain). Set observability.type: "noop" ` +
        `and remove the otel/clickhouse/kafka/langfuse blocks — see docs/adr/0021.`,
    );
  }
  const retiredObservabilityBlocks: string[] = [];
  for (const blockName of ["otel", "clickhouse", "kafka", "langfuse"] as const) {
    const block = obj(observabilityConfig, blockName);
    if (Object.keys(block).length === 0) continue;
    if (block.enabled === true) {
      throw new Error(
        `[gateway-config] observability.${blockName}.enabled=true has been retired in the ` +
          `DSH-only build (the ${blockName} backend was removed). Delete the block or set ` +
          `observability.${blockName}.enabled=false, and rely on observability.type: "noop"|"console" ` +
          `— see docs/adr/0021.`,
      );
    }
    retiredObservabilityBlocks.push(blockName);
  }
  if (retiredObservabilityBlocks.length > 0) {
    console.warn(
      `[gateway-config] ignoring retired observability blocks (all disabled): ` +
        `${retiredObservabilityBlocks.join(", ")} — see docs/adr/0021`,
    );
  }
  const observability: ObservabilityConfig = {
    type: rawObservabilityType as ObservabilityConfig["type"],
  };

  const metadataConfig = obj(fileConfig, "metadata");
  const storeYaml = obj(metadataConfig, "store");
  const systemUserYaml = obj(metadataConfig, "systemUser");
  const memorySystemUserYaml = obj(systemUserYaml, "memory");
  const metadataStore: GatewayMetadataStoreConfig | undefined = (() => {
    const explicitMongoUri = str(storeYaml, "mongoUri");
    if (explicitMongoUri) {
      throw new Error(
        `[gateway-config] metadata.store.mongoUri has been retired in the DSH-only build ` +
          `(the MongoDB metadata adapter was removed). Delete the option and keep ` +
          `metadata.store.sqliteBaseDir — see docs/adr/0021.`,
      );
    }
    const sqliteBaseDir = str(storeYaml, "sqliteBaseDir");
    const cacheMax = num(storeYaml, "storeCacheMaxInstances");
    const dbPrefix = str(storeYaml, "mongoDbPrefix");
    if (!sqliteBaseDir && cacheMax === undefined && !dbPrefix) return undefined;
    return {
      sqliteBaseDir,
      storeCacheMaxInstances: cacheMax,
      mongoDbPrefix: dbPrefix,
    };
  })();
  const metadata: GatewayMetadataConfig = {
    maxUsersPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_USERS") ?? num(metadataConfig, "maxUsersPerInstance"),
      500,
    ),
    maxTeamsPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_TEAMS") ?? num(metadataConfig, "maxTeamsPerInstance"),
      100,
    ),
    configParamsFile: process.env.TDAI_METADATA_CONFIG_PARAMS_FILE || str(metadataConfig, "configParamsFile") || undefined,
    store: metadataStore,
    systemUser: str(memorySystemUserYaml, "userId") || str(memorySystemUserYaml, "userKey") ||
      str(memorySystemUserYaml, "displayName")
      ? {
          memory: {
            userId: str(memorySystemUserYaml, "userId"),
            displayName: str(memorySystemUserYaml, "displayName"),
            userKey: str(memorySystemUserYaml, "userKey"),
          },
        }
      : undefined,
  };

  const base: GatewayConfig = {
    deployMode,
    stateBackend,
    instanceId,
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir },
    llm,
    memory,
    shark,
    scanner,
    worker,
    cos,
    observability,
    metadata,
    skill: skillFromAnywhere,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server ?? {}) },
    data: { ...base.data, ...(overrides.data ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

// ============================
// Helpers
// ============================

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  const dataDir = resolveDefaultDataDir();
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}


// ── llm.apiKey 解析（ADR-0006，#70）──
// 服务凭据唯一 SoT = admin settings（config-override.json）。运行时解析链：
//   override（settingsOverride.llm.apiKey，:516 Object.assign 最后落）
//   > gateway yaml llm.apiKey
//   > TDAI_LLM_API_KEY env（deprecated 回退，loud 告警一次/值）
// 占位符（__X__ / ${X}，云模板未替换/未展开标记）视为未设置（src/utils/credential.ts）。
// baseUrl/model/provider 的 env 优先保留 —— 非秘密，不在本合同内。
let lastWarnedLlmApiKeyEnv: string | null = null;
function warnLlmApiKeyEnvDeprecated(value: string): void {
  if (lastWarnedLlmApiKeyEnv === value) return;
  lastWarnedLlmApiKeyEnv = value;
  console.error(
    "[config] TDAI_LLM_API_KEY 已弃用（ADR-0006）：LLM 凭据 SoT=admin settings（config-override.json）。" +
      "本次回退读取 env，请尽快迁移：写入 <dataDir>/config-override.json 的 llm 段，或经 admin settings UI 设置。",
  );
}
/** 测试专用：重置弃用告警去重状态。 */
export function resetLlmApiKeyDeprecationWarnForTests(): void {
  lastWarnedLlmApiKeyEnv = null;
}
function resolveLlmApiKey(yamlApiKey: string | undefined): string {
  if (isSetCredential(yamlApiKey)) return yamlApiKey;
  const envKey = env("TDAI_LLM_API_KEY");
  if (isSetCredential(envKey)) {
    warnLlmApiKeyEnvDeprecated(envKey);
    return envKey;
  }
  return "";
}
function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveQuotaLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Read `server.corsOrigins` from yaml or `TDAI_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `TDAI_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  const envValue = env("TDAI_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}
