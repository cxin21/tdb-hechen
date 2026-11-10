/**
 * configCatalog.ts — 自动生成，勿手改。生成命令见 docs/ops/settings-tabs-2026-11-07.md。
 *
 * 来源：config/templates/memorycore.keys.json（服务配置键 390 条，MemoryCore 实读面）
 *   + D:/TDB/.scratch/cfg-inventory/merged-dedup.json（每键大白话）。
 * tier 为「配置面四档」：A 部署身份/凭据、B 应急回滚总闸、C 实测校准阈值、D 结构与协议常量。
 * 生成时间：2026-11-07；计数 A/B/C/D = 48/7/15/295（共 365 条）。
 *
 * T3 手工裁剪（2026-11-07）：删除 26 个已无 loader 的死键（锚发现提案 4 + 承诺提案 1 + 自证门 16 + 灵魂提案 5，
 * 全在 D 档：369→343）。依据：MemoryCore/src 对这些键路径的全量 grep = 0 命中（loader 已随提案通道删除）。
 *
 * T9 手工裁剪（2026-11-07）：再删 25 个 anchor/character 通道退场后的死键（锚发现子组 20：
 * character 4 + descRefresh 3 + person 4 + similarMerge 2 + identityMaintain 1 + 顶层 intervalHours /
 * maintainIntervalHours / maxPerPass / maxTotal / minEvidence / quotaScope 6；性格张力阈值 3；
 * seedValues 1；selfIdentity.intervalHours 1，全在 D 档：343→318）。
 * 判据不是字符串 grep，而是实跑 MemoryCore parseConfig 做「注入-效果差分」：把候选键按多种类型值注入 raw，
 * 与基线配置逐叶对比，一个输出叶子都不变的才判死（`lifecycle.filter.*`、`recall.fusion` / `factChannel` /
 * `rerankGate.*` 这类条件解析键因此被正确判活；`capture.cleanTime` 虽不落在 capture 上，但会改写
 * memoryCleanup.cleanTime，同样判活保留）。Core 侧配置键清理清单与本次判定在 24 条上一致，
 * 多出的 seedValues 属 S8 价值锚整表删除时的遗留（MemoryCore/src/config.ts:1609 只剩退场注释）。
 * T20 手工裁剪（2026-11-07）：Core 退役 /core-memory/write 后，再删 allowedSlots / maxContentLength 两条（D 档）
 * 与 writeEnabled / seedValues；模板 keys.json 已同步清到 364 条，本 catalog 与之一致。
 *
 * T21 手工裁剪（2026-11-07）：Core 配置面最终收敛后，用同一「注入-效果差分」判据复测，再删 24 条已无解析产出的键
 * （人格维护总闸（S9 起恒开、开关移除）1；灵魂注入面（soul 渲染：锚去重/锚选择/预算/能力/承诺/快照/规则去重）21；
 * 价值锚缓存 TTL 1；核心写入口总闸 1——写路由与信任边界守卫 task-20 已退役，配置只剩解析、零消费者），
 * 落 B/D 两档：B 8→7、D 318→295，共 389→365。
 * 判据修正（关键）：parseConfig(raw) 的 raw 就是 yaml 里 memory: 之下的那一层，注入必须写在 raw.<key>
 * 而不是 raw.memory.<key>——按后者注入一条都命中不了，会把所有键误判成死键。本轮已按前者复测。
 * 条件解析键（lifecycle.filter、recall.fusion / factChannel / rerankGate、capture.cleanTime）注入即改输出，判活保留。
 * 保留说明：仅「有解析产出且有消费者」的键留在目录里；只剩解析、零消费者的键按用户口径（不用的就删掉）一律移除。
 */
export type ConfigTier = 'A' | 'B' | 'C' | 'D';

export interface ConfigCatalogEntry {
  /** 配置键路径（memory.* 走 MemoryCore parseConfig；少数 skill.* 属同包其它内部键）。 */
  path: string;
  tier: ConfigTier;
  type: string;
  def: string;
  /** 大白话意义（来自盘点表；空串表示未采集）。 */
  meaning: string;
  /** 解析点 path:line（config.ts 等）。 */
  source: string;
}

export const CONFIG_TIER_LABEL: Record<ConfigTier, string> = {
  A: 'A 部署与凭据',
  B: 'B 应急开关',
  C: 'C 校准阈值',
  D: 'D 常量清单',
};

export const CONFIG_TIER_DESC: Record<ConfigTier, string> = {
  A: '换环境就会变、且必须由部署方填的值：服务地址、密钥、端口、实例身份。改错后果明确（连不上/鉴权失败），允许管理员 override。',
  B: '出问题时的回滚总闸：关掉即退回旧行为。平时不应改；上线灰度、故障止血时由管理员一键关。',
  C: '需要实测反推的阈值/权重：改一个数会改变召回质量，必须带实验数据才能定。研发下发，不进日常界面。',
  D: '只有一个合法值或纯结构常量：时长上限、批大小、协议路径、单值枚举。改它只会在编译/启动时报错，不建议暴露可写。',
};

const ENTRIES: ConfigCatalogEntry[] = [
  {
    "path": "cos.domain",
    "tier": "A",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 undefined。yaml COS 域名。 yaml COS 域名。",
    "source": "MemoryCore/src/gateway/config.ts:507"
  },
  {
    "path": "cos.generationLogRetentionDays",
    "tier": "A",
    "type": "int",
    "def": "30",
    "meaning": "缺省 30。yaml 保留天数。类型注释 Default 30，与代码一致。 yaml 保留天数。类型注释 Default 30，与代码一致。",
    "source": "MemoryCore/src/gateway/config.ts:509"
  },
  {
    "path": "data.baseDir",
    "tier": "A",
    "type": "path",
    "def": "unset",
    "meaning": "缺省 ~/.memory-tencentdb/memory-tdai。yaml 数据目录。 yaml 数据目录。",
    "source": "MemoryCore/src/gateway/config.ts:272"
  },
  {
    "path": "deployMode",
    "tier": "A",
    "type": "enum(standalone)",
    "def": "standalone",
    "meaning": "缺省 standalone。yaml 部署模式。非 standalone 启动失败。类型注释 :90 仍列出 service，与退役行为不一致。 yaml 部署模式。非 standalone 启动失败。类型注释 :90 仍列出 service，与退役行为不一致。",
    "source": "MemoryCore/src/gateway/config.ts:455"
  },
  {
    "path": "instanceId",
    "tier": "A",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 default。yaml 实例 ID。 yaml 实例 ID。",
    "source": "MemoryCore/src/gateway/config.ts:477"
  },
  {
    "path": "llm.apiKey",
    "tier": "A",
    "type": "str",
    "def": "",
    "meaning": "调用外部服务的密钥。空着通常表示不启用或走别的来源。 缺省 (empty)。 ADR-0006：yaml 优先于 env。占位符 __X__ 或 ${X} 视为未设，函数返回空串。最终还可被 config-override.json 的 llm 段覆盖；本文件不读该文件的键，只调用 readSettingsOverride。",
    "source": "MemoryCore/src/gateway/config.ts:290"
  },
  {
    "path": "llm.baseUrl",
    "tier": "A",
    "type": "str",
    "def": "https://api.openai.com/v1",
    "meaning": "外部服务地址。 缺省 https://api.openai.com/v1。 yaml LLM 端点。 空则解析直接抛错，skill runner 也不构造",
    "source": "MemoryCore/src/gateway/config.ts:287"
  },
  {
    "path": "llm.maxTokens",
    "tier": "A",
    "type": "int",
    "def": "4096",
    "meaning": "缺省 4096。yaml 最大 token。 yaml 最大 token。",
    "source": "MemoryCore/src/gateway/config.ts:292"
  },
  {
    "path": "llm.model",
    "tier": "A",
    "type": "str",
    "def": "gpt-4o",
    "meaning": "用哪个模型。 缺省 gpt-4o。 yaml 模型名。 runner 未单独指定 model 时用配置模型；splice 时写入 memory.llm.model",
    "source": "MemoryCore/src/gateway/config.ts:291"
  },
  {
    "path": "llm.provider",
    "tier": "A",
    "type": "enum(openai|proxy)",
    "def": "openai",
    "meaning": "用哪家服务。none 一般表示关掉。 缺省 openai。 写死 openai。历史 proxy 不再被采用。",
    "source": "MemoryCore/src/gateway/config.ts:382"
  },
  {
    "path": "llm.stream",
    "tier": "A",
    "type": "bool",
    "def": "false",
    "meaning": "缺省 false。yaml 流式开关，仅 env 未设时生效。 yaml 流式开关，仅 env 未设时生效。 true 走流式补全；lifecycle consolidation runner 也按它建",
    "source": "MemoryCore/src/gateway/config.ts:300"
  },
  {
    "path": "llm.timeoutMs",
    "tier": "A",
    "type": "ms",
    "def": "120000",
    "meaning": "最多等多久（毫秒）。超时就放弃这次调用，避免卡住。 缺省 120000。 yaml LLM 超时。 单次 run 未传 timeoutMs 时用它，缺省 120000",
    "source": "MemoryCore/src/gateway/config.ts:293"
  },
  {
    "path": "memory.auth.adminBypassEnabled",
    "tier": "A",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:3044"
  },
  {
    "path": "memory.auth.requireTeamOwnership",
    "tier": "A",
    "type": "enum(off|warn|enforce)",
    "def": "off",
    "meaning": "parseTeamOwnershipMode 第二参 off。未知非空在 gateway/team-ownership.ts 解释为 enforce。 缺省 off。 解析成 off/warn/enforce；非 off 才对 gated 路径做 team 归属校验",
    "source": "MemoryCore/src/config.ts:3048"
  },
  {
    "path": "memory.auth.requireUserBinding",
    "tier": "A",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。 缺省 false。 true 时 /v3 要求凭据主体与请求 user_id 一致，否则 403",
    "source": "MemoryCore/src/config.ts:3039"
  },
  {
    "path": "memory.auth.teamOwnershipWhitelist",
    "tier": "A",
    "type": "list<str>",
    "def": "",
    "meaning": "normalizeTeamOwnershipWhitelist。未写时空名单。具体归一规则在 gateway/team-ownership.ts，本文件只调用。",
    "source": "MemoryCore/src/config.ts:3052"
  },
  {
    "path": "memory.auth.unknownPrincipalPolicy",
    "tier": "A",
    "type": "enum(off|warn|reject)",
    "def": "off",
    "meaning": "parseUnknownPrincipalPolicy 第二参 off。未知非空的 fail-secure 在 gateway/auth-binding.ts。",
    "source": "MemoryCore/src/config.ts:3041"
  },
  {
    "path": "memory.embedding.apiKey",
    "tier": "A",
    "type": "str",
    "def": "",
    "meaning": "外部服务密钥。空着通常表示不启用或另有来源。",
    "source": "MemoryCore/src/config.ts:2899"
  },
  {
    "path": "memory.embedding.baseUrl",
    "tier": "A",
    "type": "str",
    "def": "",
    "meaning": "外部服务地址。",
    "source": "MemoryCore/src/config.ts:2219"
  },
  {
    "path": "memory.embedding.captureTimeoutMs",
    "tier": "A",
    "type": "ms",
    "def": "unset",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2983"
  },
  {
    "path": "memory.embedding.conflictRecallTopK",
    "tier": "A",
    "type": "int",
    "def": "5",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2963"
  },
  {
    "path": "memory.embedding.dimensions",
    "tier": "A",
    "type": "int",
    "def": "0",
    "meaning": "provider=none 时 0。 缺省 0。 建库向量维数；0 则 vec0 推迟，skill 也要求大于 0 才算可用",
    "source": "MemoryCore/src/config.ts:2961"
  },
  {
    "path": "memory.embedding.maxInputChars",
    "tier": "A",
    "type": "int",
    "def": "5000",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2964"
  },
  {
    "path": "memory.embedding.model",
    "tier": "A",
    "type": "str",
    "def": "",
    "meaning": "用哪个模型。 缺省 。 传入 embedding 服务，决定请求的模型名",
    "source": "MemoryCore/src/config.ts:2641"
  },
  {
    "path": "memory.embedding.modelCacheDir",
    "tier": "A",
    "type": "path",
    "def": "unset",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2984"
  },
  {
    "path": "memory.embedding.provider",
    "tier": "A",
    "type": "enum(none|openai_compatible|qclaw|local)",
    "def": "none",
    "meaning": "用哪家服务。none 一般表示关掉。 缺省 none。 local 不建远端 embedding 服务；其余作为 createEmbeddingService 的 provider，并写入启动日志",
    "source": "MemoryCore/src/config.ts:2886"
  },
  {
    "path": "memory.embedding.recallTimeoutMs",
    "tier": "A",
    "type": "ms",
    "def": "unset",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2982"
  },
  {
    "path": "memory.embedding.sendDimensions",
    "tier": "A",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2962"
  },
  {
    "path": "memory.embedding.timeoutMs",
    "tier": "A",
    "type": "ms",
    "def": "10000",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。 缺省 10000。 captureTimeoutMs 缺省时作为抽取侧 embedding 超时；服务构造时大于 0 才覆盖默认 API 超时",
    "source": "MemoryCore/src/config.ts:2582"
  },
  {
    "path": "memory.llm.apiKey",
    "tier": "A",
    "type": "str",
    "def": "",
    "meaning": "外部服务密钥。空着通常表示不启用或另有来源。",
    "source": "MemoryCore/src/config.ts:2899"
  },
  {
    "path": "memory.llm.baseUrl",
    "tier": "A",
    "type": "str",
    "def": "https://api.openai.com/v1",
    "meaning": "外部服务地址。 缺省 https://api.openai.com/v1。 空则解析直接抛错，skill runner 也不构造",
    "source": "MemoryCore/src/config.ts:2219"
  },
  {
    "path": "memory.llm.enabled",
    "tier": "A",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 false 则不建 Skill LLM runner，skill 探测标不可用；gateway 还用它决定是否把顶层 llm splice 进 memory.llm。管线 L1/L2/L3 runner 已不再分支这个键",
    "source": "MemoryCore/src/config.ts:2579"
  },
  {
    "path": "memory.llm.maxTokens",
    "tier": "A",
    "type": "int",
    "def": "4096",
    "meaning": "网关 TDAI_LLM_MAX_TOKENS 优先。",
    "source": "MemoryCore/src/config.ts:3005"
  },
  {
    "path": "memory.llm.maxTokensLimit",
    "tier": "A",
    "type": "int",
    "def": "131072",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:3008"
  },
  {
    "path": "memory.llm.model",
    "tier": "A",
    "type": "str",
    "def": "gpt-4o",
    "meaning": "用哪个模型。 缺省 gpt-4o。 runner 未单独指定 model 时用配置模型；splice 时写入 memory.llm.model",
    "source": "MemoryCore/src/config.ts:2641"
  },
  {
    "path": "memory.llm.provider",
    "tier": "A",
    "type": "enum(openai|proxy)",
    "def": "openai",
    "meaning": "用哪家服务。none 一般表示关掉。",
    "source": "MemoryCore/src/config.ts:2886"
  },
  {
    "path": "memory.llm.stream",
    "tier": "A",
    "type": "bool",
    "def": "false",
    "meaning": "网关 TDAI_LLM_STREAM 优先。 缺省 false。 true 走流式补全；lifecycle consolidation runner 也按它建",
    "source": "MemoryCore/src/config.ts:3010"
  },
  {
    "path": "memory.llm.timeoutMs",
    "tier": "A",
    "type": "ms",
    "def": "120000",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。 缺省 120000。 单次 run 未传 timeoutMs 时用它，缺省 120000",
    "source": "MemoryCore/src/config.ts:2582"
  },
  {
    "path": "memory.storeBackend",
    "tier": "A",
    "type": "enum(sqlite)",
    "def": "sqlite",
    "meaning": "仅 sqlite。其它值抛 Error [config] storeBackend retired。 缺省 sqlite。 非 sqlite 在建库时 assert 失败；通过后只作为日志和 skill 探测值，不再分支",
    "source": "MemoryCore/src/config.ts:1643"
  },
  {
    "path": "server.apiKey",
    "tier": "A",
    "type": "str",
    "def": "unset",
    "meaning": "调用外部服务的密钥。空着通常表示不启用或走别的来源。 缺省 。 Inline API key for the desktop profile (empty by default — never shipped). Wins over the credentials ref.",
    "source": "MemoryCore/src/gateway/config.ts:267"
  },
  {
    "path": "server.corsOrigins",
    "tier": "A",
    "type": "list<str>",
    "def": "",
    "meaning": "缺省 []。yaml CORS 白名单，数组或逗号串均可；显式空数组可压过泄漏的 env。 yaml CORS 白名单，数组或逗号串均可；显式空数组可压过泄漏的 env。",
    "source": "MemoryCore/src/gateway/config.ts:775"
  },
  {
    "path": "server.host",
    "tier": "A",
    "type": "str",
    "def": "127.0.0.1",
    "meaning": "缺省 127.0.0.1。yaml 监听地址。 yaml 监听地址。",
    "source": "MemoryCore/src/gateway/config.ts:257"
  },
  {
    "path": "server.port",
    "tier": "A",
    "type": "int",
    "def": "8420",
    "meaning": "缺省 8420。yaml 端口，被 TDAI_GATEWAY_PORT 覆盖。 yaml 端口，被 TDAI_GATEWAY_PORT 覆盖。",
    "source": "MemoryCore/src/gateway/config.ts:256"
  },
  {
    "path": "shark.baseUrl",
    "tier": "A",
    "type": "str",
    "def": "unset",
    "meaning": "外部服务地址。 缺省 undefined。 yaml Shark 基址。",
    "source": "MemoryCore/src/gateway/config.ts:482"
  },
  {
    "path": "shark.cosBufferMs",
    "tier": "A",
    "type": "ms",
    "def": "120000",
    "meaning": "缺省 120000。yaml COS 缓冲。 yaml COS 缓冲。",
    "source": "MemoryCore/src/gateway/config.ts:484"
  },
  {
    "path": "shark.maxInstances",
    "tier": "A",
    "type": "int",
    "def": "1000",
    "meaning": "缺省 1000。yaml 最大实例数。 yaml 最大实例数。",
    "source": "MemoryCore/src/gateway/config.ts:485"
  },
  {
    "path": "shark.vdbTtlMs",
    "tier": "A",
    "type": "ms",
    "def": "300000",
    "meaning": "缺省 300000。yaml VDB TTL。 yaml VDB TTL。",
    "source": "MemoryCore/src/gateway/config.ts:483"
  },
  {
    "path": "stateBackend",
    "tier": "A",
    "type": "enum(local)",
    "def": "unset",
    "meaning": "缺省 local。yaml 状态后端。 yaml 状态后端。",
    "source": "MemoryCore/src/gateway/config.ts:466"
  },
  {
    "path": "memory.bm25.enabled",
    "tier": "B",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 true。 false 返回 undefined，不建稀疏编码器",
    "source": "MemoryCore/src/config.ts:2989"
  },
  {
    "path": "memory.embedding.enabled",
    "tier": "B",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 false 则不建 EmbeddingService，skill 探测也把 embeddingAvailable 标假",
    "source": "MemoryCore/src/config.ts:1582"
  },
  {
    "path": "memory.evolution.enabled",
    "tier": "B",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 必须 ===true 才跑受控正文演化；gateway 把整个 evolution 对象接进调度器",
    "source": "MemoryCore/src/config.ts:2201"
  },
  {
    "path": "memory.extraction.enabled",
    "tier": "B",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 true。 initialize 时为 false 则不建 pipeline manager，L1/L2/L3 调度整段不启动",
    "source": "MemoryCore/src/config.ts:2271"
  },
  {
    "path": "memory.lifecycle.consolidation.enabled",
    "tier": "B",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1797"
  },
  {
    "path": "memory.links.enabled",
    "tier": "B",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 true。 作为 enableMemoryLinks 传入 L1，false 则不建 similar/evolve 边",
    "source": "MemoryCore/src/config.ts:1669"
  },
  {
    "path": "memory.sceneGovernance.enabled",
    "tier": "B",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 整对象传入抽取器；enabled 才在文件名归一后跑 SceneGovernor",
    "source": "MemoryCore/src/config.ts:2253"
  },
  {
    "path": "memory.recall.rerank.apiKey",
    "tier": "C",
    "type": "str",
    "def": "",
    "meaning": "外部服务密钥。空着通常表示不启用或另有来源。",
    "source": "MemoryCore/src/config.ts:2899"
  },
  {
    "path": "memory.recall.rerank.baseUrl",
    "tier": "C",
    "type": "str",
    "def": "",
    "meaning": "外部服务地址。",
    "source": "MemoryCore/src/config.ts:2219"
  },
  {
    "path": "memory.recall.rerank.candidates",
    "tier": "C",
    "type": "int",
    "def": "32",
    "meaning": "DEFAULT_RERANK_CANDIDATES。clamp 1..100。",
    "source": "MemoryCore/src/config.ts:2912"
  },
  {
    "path": "memory.recall.rerank.enabled",
    "tier": "C",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2468"
  },
  {
    "path": "memory.recall.rerank.filterKeepRatio",
    "tier": "C",
    "type": "float",
    "def": "0.5",
    "meaning": "非正回落 0.5，>1 clamp 到 1。",
    "source": "MemoryCore/src/config.ts:2919"
  },
  {
    "path": "memory.recall.rerank.filterMarginTop",
    "tier": "C",
    "type": "float",
    "def": "8",
    "meaning": "非正回落 8。",
    "source": "MemoryCore/src/config.ts:2918"
  },
  {
    "path": "memory.recall.rerank.filterRule",
    "tier": "C",
    "type": "enum(floor|margin|quantile)",
    "def": "floor",
    "meaning": "margin|quantile|floor，其它 floor。",
    "source": "MemoryCore/src/config.ts:2917"
  },
  {
    "path": "memory.recall.rerank.local.idleUnloadMs",
    "tier": "C",
    "type": "ms",
    "def": "600000",
    "meaning": "0=常驻。",
    "source": "MemoryCore/src/config.ts:2925"
  },
  {
    "path": "memory.recall.rerank.local.modelDir",
    "tier": "C",
    "type": "path",
    "def": "",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2924"
  },
  {
    "path": "memory.recall.rerank.minScore",
    "tier": "C",
    "type": "float",
    "def": "-10.5",
    "meaning": "provider=none/local 用 -10.5。云 provider 用 sigmoid(-10.5)。yaml 显式值优先。",
    "source": "MemoryCore/src/config.ts:2465"
  },
  {
    "path": "memory.recall.rerank.mode",
    "tier": "C",
    "type": "enum(rerank|filter)",
    "def": "rerank",
    "meaning": "仅 filter。",
    "source": "MemoryCore/src/config.ts:2443"
  },
  {
    "path": "memory.recall.rerank.model",
    "tier": "C",
    "type": "str",
    "def": "",
    "meaning": "用哪个模型。",
    "source": "MemoryCore/src/config.ts:2383"
  },
  {
    "path": "memory.recall.rerank.provider",
    "tier": "C",
    "type": "enum(siliconflow|dashscope|local|none)",
    "def": "none",
    "meaning": "用哪家服务。none 一般表示关掉。",
    "source": "MemoryCore/src/config.ts:2886"
  },
  {
    "path": "memory.recall.rerank.timeoutMs",
    "tier": "C",
    "type": "ms",
    "def": "800",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。",
    "source": "MemoryCore/src/config.ts:2482"
  },
  {
    "path": "memory.worthiness.extractionEnabled",
    "tier": "C",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。 缺省 false。 true 才把重要度标注块拼进 L1 prompt",
    "source": "MemoryCore/src/config.ts:3025"
  },
  {
    "path": "memory.bm25.language",
    "tier": "D",
    "type": "enum(zh|en)",
    "def": "zh",
    "meaning": "仅 en 被采纳。",
    "source": "MemoryCore/src/config.ts:2990"
  },
  {
    "path": "memory.capture.allowAggressiveCleanup",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "允许 1-2 天激进清理。",
    "source": "MemoryCore/src/config.ts:1540"
  },
  {
    "path": "memory.capture.cleanTime",
    "tier": "D",
    "type": "str",
    "def": "03:00",
    "meaning": "非法值回落 03:00。实际消费在 memoryCleanup.cleanTime。",
    "source": "MemoryCore/src/config.ts:1634"
  },
  {
    "path": "memory.capture.excludeAgents",
    "tier": "D",
    "type": "list<str>",
    "def": "",
    "meaning": "不捕获这些 agent。 缺省 []。 启动时把 excludeAgents 交给 SessionFilter，构造器把 glob 并进内置匹配器，命中会话不捕获",
    "source": "MemoryCore/src/config.ts:2266"
  },
  {
    "path": "memory.capture.l0l1RetentionDays",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "0=永久保留。配置 1 或 2 天必须同时 allowAggressiveCleanup，否则返回 0。 缺省 0。 叶子本身无生产读取。parseConfig 把它改写成 memoryCleanup.retentionDays，真正消费在 MemoryCore/src/gateway/server.ts:713-719 LocalMemoryCleaner.retentionDays",
    "source": "MemoryCore/src/config.ts:1539"
  },
  {
    "path": "memory.coreMemory.anchorDiscovery.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1582"
  },
  {
    "path": "memory.coreMemory.moodLine.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1669"
  },
  {
    "path": "memory.coreMemory.moodLine.halfLifeHours",
    "tier": "D",
    "type": "float",
    "def": "48",
    "meaning": "过这么久，这项影响大约衰减一半。",
    "source": "MemoryCore/src/config.ts:1832"
  },
  {
    "path": "memory.coreMemory.moodLine.maxSamples",
    "tier": "D",
    "type": "int",
    "def": "20",
    "meaning": "floor clamp 1..200。",
    "source": "MemoryCore/src/config.ts:1828"
  },
  {
    "path": "memory.coreMemory.moodLine.minSamples",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "floor clamp 1..100。",
    "source": "MemoryCore/src/config.ts:1829"
  },
  {
    "path": "memory.coreMemory.moodLine.negThreshold",
    "tier": "D",
    "type": "float",
    "def": "-0.15",
    "meaning": "clamp -1..1。",
    "source": "MemoryCore/src/config.ts:1831"
  },
  {
    "path": "memory.coreMemory.moodLine.posThreshold",
    "tier": "D",
    "type": "float",
    "def": "0.15",
    "meaning": "clamp -1..1。",
    "source": "MemoryCore/src/config.ts:1830"
  },
  {
    "path": "memory.coreMemory.moodLine.windowHours",
    "tier": "D",
    "type": "int",
    "def": "72",
    "meaning": "clamp 1..720。",
    "source": "MemoryCore/src/config.ts:1827"
  },
  {
    "path": "memory.coreMemory.selfIdentity.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1669"
  },
  {
    "path": "memory.coreMemory.selfIdentity.maxPerPass",
    "tier": "D",
    "type": "int",
    "def": "2",
    "meaning": "clamp 1..10。",
    "source": "MemoryCore/src/config.ts:1719"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.alpha",
    "tier": "D",
    "type": "float",
    "def": "0.15",
    "meaning": "clamp 0..0.5。",
    "source": "MemoryCore/src/config.ts:1999"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.boundary",
    "tier": "D",
    "type": "int",
    "def": "2600",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:368"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.identity",
    "tier": "D",
    "type": "int",
    "def": "400",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:362"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.method",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:373"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.narrative",
    "tier": "D",
    "type": "int",
    "def": "300",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:372"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.relationship",
    "tier": "D",
    "type": "int",
    "def": "900",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:371"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.values",
    "tier": "D",
    "type": "int",
    "def": "320",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:367"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.budget.voice",
    "tier": "D",
    "type": "int",
    "def": "600",
    "meaning": "yaml 可覆盖，clamp 0..4000。",
    "source": "MemoryCore/src/core/soul/types.ts:361"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.degradeAfterDays",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "clamp 1..365。",
    "source": "MemoryCore/src/config.ts:2002"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.degradeWeightFactor",
    "tier": "D",
    "type": "float",
    "def": "0.7",
    "meaning": "clamp 0.1..1。",
    "source": "MemoryCore/src/config.ts:2004"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.driftConsecutive",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "clamp 1..30。",
    "source": "MemoryCore/src/config.ts:2009"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.driftDegrade",
    "tier": "D",
    "type": "float",
    "def": "0.75",
    "meaning": "clamp 0.3..1。",
    "source": "MemoryCore/src/config.ts:2007"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.driftFreeze",
    "tier": "D",
    "type": "float",
    "def": "0.6",
    "meaning": "clamp 0.1..1。",
    "source": "MemoryCore/src/config.ts:2008"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.emotionHalfLifeHours",
    "tier": "D",
    "type": "float",
    "def": "3",
    "meaning": "clamp 0.5..72。",
    "source": "MemoryCore/src/config.ts:2014"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.freezeAfterDays",
    "tier": "D",
    "type": "int",
    "def": "90",
    "meaning": "clamp 1..730。",
    "source": "MemoryCore/src/config.ts:2003"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.freezeContradictions",
    "tier": "D",
    "type": "int",
    "def": "2",
    "meaning": "clamp 1..10。",
    "source": "MemoryCore/src/config.ts:2005"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.boundary",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:327"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.identity",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:324"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.method",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:330"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.narrative",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:329"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.relationship",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:328"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.values",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:326"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItemChars.voice",
    "tier": "D",
    "type": "int",
    "def": "160",
    "meaning": "layerItemChars(160)。yaml 可覆盖，clamp 20..1000。",
    "source": "MemoryCore/src/core/soul/types.ts:323"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.boundary",
    "tier": "D",
    "type": "int",
    "def": "40",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:316"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.identity",
    "tier": "D",
    "type": "int",
    "def": "7",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:313"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.method",
    "tier": "D",
    "type": "int",
    "def": "64",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:319"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.narrative",
    "tier": "D",
    "type": "int",
    "def": "7",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:318"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.relationship",
    "tier": "D",
    "type": "int",
    "def": "12",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:317"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.values",
    "tier": "D",
    "type": "int",
    "def": "7",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:315"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxItems.voice",
    "tier": "D",
    "type": "int",
    "def": "7",
    "meaning": "yaml 可覆盖，clamp 1..64。",
    "source": "MemoryCore/src/core/soul/types.ts:312"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxSoulEvidenceShare",
    "tier": "D",
    "type": "float",
    "def": "0.5",
    "meaning": "clamp 0..1。",
    "source": "MemoryCore/src/config.ts:2011"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.maxUpdatedPerCycle",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "clamp 1..20。",
    "source": "MemoryCore/src/config.ts:1998"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.mergeSimilarity",
    "tier": "D",
    "type": "float",
    "def": "0.85",
    "meaning": "clamp 0.5..1。",
    "source": "MemoryCore/src/config.ts:2006"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.minEvidence",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "clamp 1..10。",
    "source": "MemoryCore/src/config.ts:1718"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.moodDeviationThreshold",
    "tier": "D",
    "type": "float",
    "def": "0.15",
    "meaning": "clamp 0.01..1。",
    "source": "MemoryCore/src/config.ts:2016"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.moodHalfLifeHours",
    "tier": "D",
    "type": "float",
    "def": "48",
    "meaning": "clamp 1..336。",
    "source": "MemoryCore/src/config.ts:2015"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.redlineMaxChars",
    "tier": "D",
    "type": "int",
    "def": "120",
    "meaning": "clamp 20..400。",
    "source": "MemoryCore/src/config.ts:2013"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.updateIntervalHours",
    "tier": "D",
    "type": "int",
    "def": "6",
    "meaning": "clamp 1..168。",
    "source": "MemoryCore/src/config.ts:1997"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.verbatimMinChars",
    "tier": "D",
    "type": "int",
    "def": "8",
    "meaning": "clamp 4..40。",
    "source": "MemoryCore/src/config.ts:2012"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.windowDays",
    "tier": "D",
    "type": "int",
    "def": "7",
    "meaning": "clamp 1..90。",
    "source": "MemoryCore/src/config.ts:2000"
  },
  {
    "path": "memory.coreMemory.soulMaintenance.windowRewrites",
    "tier": "D",
    "type": "int",
    "def": "1",
    "meaning": "clamp 1..10。",
    "source": "MemoryCore/src/config.ts:2001"
  },
  {
    "path": "memory.coreMemory.soulRender.budgetIdentityChars",
    "tier": "D",
    "type": "int",
    "def": "900",
    "meaning": "clamp 100..2000。",
    "source": "MemoryCore/src/config.ts:1845"
  },
  {
    "path": "memory.coreMemory.soulRender.budgetSelfChars",
    "tier": "D",
    "type": "int",
    "def": "600",
    "meaning": "clamp 100..2000。",
    "source": "MemoryCore/src/config.ts:1844"
  },
  {
    "path": "memory.coreMemory.soulRender.identityNarrative.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1669"
  },
  {
    "path": "memory.coreMemory.soulRender.introspect.evidenceWindowHours",
    "tier": "D",
    "type": "int",
    "def": "168",
    "meaning": "clamp 1..2160。",
    "source": "MemoryCore/src/config.ts:1945"
  },
  {
    "path": "memory.coreMemory.soulRender.introspect.snapshotLimit",
    "tier": "D",
    "type": "int",
    "def": "20",
    "meaning": "clamp 1..200。",
    "source": "MemoryCore/src/config.ts:1939"
  },
  {
    "path": "memory.coreMemory.soulRender.promiseEvidence.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1766"
  },
  {
    "path": "memory.evolution.intervalMs",
    "tier": "D",
    "type": "ms",
    "def": "3600000",
    "meaning": "隔多久跑一轮，单位毫秒。",
    "source": "MemoryCore/src/config.ts:2203"
  },
  {
    "path": "memory.evolution.maxRewrites",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "clamp 1..20。",
    "source": "MemoryCore/src/config.ts:2202"
  },
  {
    "path": "memory.extraction.dedupTimeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "300000",
    "meaning": "clamp 60000..3600000。 缺省 300000。 透传后作为 l1-conflict-detection 的 llmRunner.run timeoutMs，缺省 300000",
    "source": "MemoryCore/src/config.ts:2288"
  },
  {
    "path": "memory.extraction.durativeEnabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "持续事实提取。 缺省 false。 仅开关为 true 且 LLM 标 durative 时才写 valid_start，否则效期字段丢弃",
    "source": "MemoryCore/src/config.ts:2277"
  },
  {
    "path": "memory.extraction.enableDedup",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "是否启用去重。 缺省 true。 透传进 extractL1Memories；true 才走 batchDedup，否则直接 store",
    "source": "MemoryCore/src/config.ts:2272"
  },
  {
    "path": "memory.extraction.extractionTimeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "300000",
    "meaning": "clamp 60000..3600000。 缺省 300000。 同时作为 L1 抽取超时和 L2 SceneExtractor.timeoutMs",
    "source": "MemoryCore/src/config.ts:2285"
  },
  {
    "path": "memory.extraction.facts.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 true 才把多事实输出块拼进 prompt，并独占 metadata.facts",
    "source": "MemoryCore/src/config.ts:2026"
  },
  {
    "path": "memory.extraction.facts.includeTriples",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。 缺省 false。 true 且抽出非空三元组时才写 metadata.factTriples，供写侧建事实键",
    "source": "MemoryCore/src/config.ts:2326"
  },
  {
    "path": "memory.extraction.facts.maxFacts",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "clampMaxFacts，缺省 DEFAULT_MAX_FACTS=5（fact-key.ts:103）。 缺省 5。 钳制后作为 facts 块的条数上限传给 prompt",
    "source": "MemoryCore/src/config.ts:2325"
  },
  {
    "path": "memory.extraction.ignoreSessionPatterns",
    "tier": "D",
    "type": "list<str>",
    "def": "probe-,session-probe-",
    "meaning": "缺省 DEFAULT_IGNORE_SESSION_PATTERNS（session-ignore.ts:24）。显式数组含空数组才覆盖。 缺省 [\"probe-\",\"session-probe-\"]。 编译成会话忽略匹配器，命中 probe 等会话的 L0 行不进 L1 候选、不计入 batch",
    "source": "MemoryCore/src/config.ts:2291"
  },
  {
    "path": "memory.extraction.maxMemoriesPerSession",
    "tier": "D",
    "type": "int",
    "def": "20",
    "meaning": "每次提取最多记忆数。 缺省 20。 单会话抽出条数超过该值时 slice 截断后再去重/落库",
    "source": "MemoryCore/src/config.ts:2273"
  },
  {
    "path": "memory.extraction.model",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "用哪个模型。 缺省 undefined。 作为 L1 extractL1Memories 的 model 选项传入抽取/去重 LLM 调用",
    "source": "MemoryCore/src/config.ts:2280"
  },
  {
    "path": "memory.extraction.promptMode",
    "tier": "D",
    "type": "enum(chat|code)",
    "def": "chat",
    "meaning": "未写时继承全局 promptMode，全局也未写则 chat。 缺省 chat。 决定 L1 抽取走 chat 还是 code 提示词，并透传给 dedup",
    "source": "MemoryCore/src/config.ts:2281"
  },
  {
    "path": "memory.extraction.recurrenceEnabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "重复事件提取。 缺省 false。 true 才把 RECURRENCE_BLOCK 拼进 L1 system prompt，否则 prompt 字节不变",
    "source": "MemoryCore/src/config.ts:2279"
  },
  {
    "path": "memory.extraction.sceneBatchMaxChars",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "0=不限制。 缺省 0。 L2 memoriesJson 估长超过该值则预分批，缺省不拆",
    "source": "MemoryCore/src/config.ts:2294"
  },
  {
    "path": "memory.extraction.scenePoisonSplit",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "混合场景是否拆分。 缺省 false。 true 时 L2 场景批失败对半递归重试，缺省关=单调用",
    "source": "MemoryCore/src/config.ts:2293"
  },
  {
    "path": "memory.extraction.sessionScope",
    "tier": "D",
    "type": "enum(session|profile)",
    "def": "session",
    "meaning": "仅 profile 被采纳，其它回落 session。 缺省 session。 profile 才允许多会话同批；session（缺省）在多 sessionId 时拆批",
    "source": "MemoryCore/src/config.ts:2275"
  },
  {
    "path": "memory.extractionExtensions.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 true 才用落库记录滚会话 soul_state 并写库，false 零读零写",
    "source": "MemoryCore/src/config.ts:2597"
  },
  {
    "path": "memory.lifecycle.consolidation.minCount",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2051"
  },
  {
    "path": "memory.lifecycle.consolidation.minSpanDays",
    "tier": "D",
    "type": "int",
    "def": "1",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2052"
  },
  {
    "path": "memory.lifecycle.consolidation.persist",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2050"
  },
  {
    "path": "memory.lifecycle.consolidation.subjectStrategy",
    "tier": "D",
    "type": "enum(llm|lexical)",
    "def": "unset",
    "meaning": "仅 llm/lexical。未设则消费侧默认 llm。",
    "source": "MemoryCore/src/config.ts:2055"
  },
  {
    "path": "memory.lifecycle.embedBackfill.batchLimit",
    "tier": "D",
    "type": "int",
    "def": "50",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2046"
  },
  {
    "path": "memory.lifecycle.embedBackfill.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1797"
  },
  {
    "path": "memory.lifecycle.embedBackfill.intervalMinutes",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2045"
  },
  {
    "path": "memory.lifecycle.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 true。 !==false 且 store 在才 startLifecycleScheduler，否则巩固/遗忘整段不启",
    "source": "MemoryCore/src/config.ts:1781"
  },
  {
    "path": "memory.lifecycle.filter.agentId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "只处理这个 agent；不写就不过滤。",
    "source": "MemoryCore/src/config.ts:2035"
  },
  {
    "path": "memory.lifecycle.filter.taskId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "只处理这个任务；不写就不过滤。",
    "source": "MemoryCore/src/config.ts:2036"
  },
  {
    "path": "memory.lifecycle.filter.teamId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "只处理这个团队；四个过滤都不写就不过滤。",
    "source": "MemoryCore/src/config.ts:2033"
  },
  {
    "path": "memory.lifecycle.filter.userId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "只处理这个用户；不写就不过滤。",
    "source": "MemoryCore/src/config.ts:2034"
  },
  {
    "path": "memory.lifecycle.forgetting.arousalRetention",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "clamp 0..0.9。",
    "source": "MemoryCore/src/config.ts:2072"
  },
  {
    "path": "memory.lifecycle.forgetting.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1811"
  },
  {
    "path": "memory.lifecycle.forgetting.lambda",
    "tier": "D",
    "type": "float",
    "def": "0.01",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2071"
  },
  {
    "path": "memory.lifecycle.forgetting.lowThreshold",
    "tier": "D",
    "type": "float",
    "def": "0.12",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2073"
  },
  {
    "path": "memory.lifecycle.forgetting.minAgeDays",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2074"
  },
  {
    "path": "memory.lifecycle.forgetting.recurrenceProtection",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2080"
  },
  {
    "path": "memory.lifecycle.forgetting.refProtection",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2076"
  },
  {
    "path": "memory.lifecycle.intervalMs",
    "tier": "D",
    "type": "ms",
    "def": "600000",
    "meaning": "隔多久跑一轮，单位毫秒。",
    "source": "MemoryCore/src/config.ts:2027"
  },
  {
    "path": "memory.lifecycle.reflection.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1826"
  },
  {
    "path": "memory.lifecycle.reflection.rRef",
    "tier": "D",
    "type": "int",
    "def": "150",
    "meaning": "clamp 1..100000。",
    "source": "MemoryCore/src/config.ts:2087"
  },
  {
    "path": "memory.links.minSimilarity",
    "tier": "D",
    "type": "float",
    "def": "0.3",
    "meaning": "clamp 0..1。非法回落 0.3。 缺省 0.3。 similar 边最低余弦，低于该分不建边",
    "source": "MemoryCore/src/config.ts:1674"
  },
  {
    "path": "memory.persona.backupCount",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2381"
  },
  {
    "path": "memory.persona.maxScenes",
    "tier": "D",
    "type": "int",
    "def": "15",
    "meaning": "注释与代码不一致：注释写默认 20，代码缺省 15。 缺省 15。 场景数达到上限时强制先 MERGE，差 1 时禁止 CREATE",
    "source": "MemoryCore/src/config.ts:2380"
  },
  {
    "path": "memory.persona.model",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "用哪个模型。",
    "source": "MemoryCore/src/config.ts:2280"
  },
  {
    "path": "memory.persona.promptMode",
    "tier": "D",
    "type": "enum(chat|code)",
    "def": "chat",
    "meaning": "未写继承全局 promptMode。",
    "source": "MemoryCore/src/config.ts:2281"
  },
  {
    "path": "memory.persona.reasoningEffort",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "未写=端点默认。none=关深度思考。 缺省 undefined。 透传到 L1 抽取/dedup 与 L2 runner.run，未配置则不带字段",
    "source": "MemoryCore/src/config.ts:2386"
  },
  {
    "path": "memory.persona.sceneBackupCount",
    "tier": "D",
    "type": "int",
    "def": "10",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2382"
  },
  {
    "path": "memory.persona.triggerEveryN",
    "tier": "D",
    "type": "int",
    "def": "50",
    "meaning": "每 N 条新记忆触发一次人格生成。 缺省 50。 作为 PersonaTrigger.interval，未满间隔则跳过 L3 人格生成",
    "source": "MemoryCore/src/config.ts:2379"
  },
  {
    "path": "memory.pipeline.enableWarmup",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。 缺省 true。 false 时新会话直接用 everyNConversations，不再走 1→2→4 指数预热",
    "source": "MemoryCore/src/config.ts:2422"
  },
  {
    "path": "memory.pipeline.everyNConversations",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "改这个值会改变这项运行行为。 缺省 5。 会话累计对话达到该阈值才触发 L1；warmup 完成后也回落到这个固定值",
    "source": "MemoryCore/src/config.ts:2421"
  },
  {
    "path": "memory.pipeline.l1IdleTimeoutSeconds",
    "tier": "D",
    "type": "int",
    "def": "600",
    "meaning": "注释与代码不一致：注释写默认 30，代码缺省 600。 缺省 600。 乘 1000 成空闲毫秒，会话空闲超过该值也触发 L1",
    "source": "MemoryCore/src/config.ts:2423"
  },
  {
    "path": "memory.pipeline.l2DelayAfterL1Seconds",
    "tier": "D",
    "type": "int",
    "def": "10",
    "meaning": "注释与代码不一致：注释写默认 90，代码缺省 10。 缺省 10。 L1 成功后延迟这么多秒才允许排 L2",
    "source": "MemoryCore/src/config.ts:2424"
  },
  {
    "path": "memory.pipeline.l2MaxIntervalSeconds",
    "tier": "D",
    "type": "int",
    "def": "3600",
    "meaning": "改这个值会改变这项运行行为。 缺省 3600。 同一会话 L2 最长间隔，到期强制再跑",
    "source": "MemoryCore/src/config.ts:2426"
  },
  {
    "path": "memory.pipeline.l2MinIntervalSeconds",
    "tier": "D",
    "type": "int",
    "def": "900",
    "meaning": "改这个值会改变这项运行行为。 缺省 900。 同一会话两次 L2 的最短间隔",
    "source": "MemoryCore/src/config.ts:2425"
  },
  {
    "path": "memory.pipeline.sessionActiveWindowHours",
    "tier": "D",
    "type": "int",
    "def": "24",
    "meaning": "改这个值会改变这项运行行为。 缺省 24。 换算成毫秒后，会话超过该窗口视为冷会话，L2 触发条件改变",
    "source": "MemoryCore/src/config.ts:2427"
  },
  {
    "path": "memory.promptMode",
    "tier": "D",
    "type": "enum(chat|code)",
    "def": "chat",
    "meaning": "顶层优先于 prompts.mode。仅 code/chat 合法，其它回落 chat。",
    "source": "MemoryCore/src/config.ts:1533"
  },
  {
    "path": "memory.recall.ageDecay.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2253"
  },
  {
    "path": "memory.recall.ageDecay.halfLifeDays",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "过这么久，这项影响大约衰减一半。",
    "source": "MemoryCore/src/config.ts:2595"
  },
  {
    "path": "memory.recall.candidateK",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未设=消费侧 maxResults*3。",
    "source": "MemoryCore/src/config.ts:2436"
  },
  {
    "path": "memory.recall.conclusionLayer.arbitrate",
    "tier": "D",
    "type": "enum(off|redundant)",
    "def": "off",
    "meaning": "仅 redundant。",
    "source": "MemoryCore/src/config.ts:2791"
  },
  {
    "path": "memory.recall.conclusionLayer.arbitrateThreshold",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设 undefined。",
    "source": "MemoryCore/src/config.ts:2793"
  },
  {
    "path": "memory.recall.conclusionLayer.cacheTtlMs",
    "tier": "D",
    "type": "ms",
    "def": "unset",
    "meaning": "未设则运行期回落 sessionReuseTtlMs。显式 0=关。",
    "source": "MemoryCore/src/config.ts:2754"
  },
  {
    "path": "memory.recall.conclusionLayer.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2733"
  },
  {
    "path": "memory.recall.conclusionLayer.idfWeighted",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2758"
  },
  {
    "path": "memory.recall.conclusionLayer.maxCharsPerMemory",
    "tier": "D",
    "type": "int",
    "def": "2000",
    "meaning": "最多保留多少字，多了截断。",
    "source": "MemoryCore/src/config.ts:2734"
  },
  {
    "path": "memory.recall.conclusionLayer.maxConclusions",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未设=运行期 floor(maxResults/2)。",
    "source": "MemoryCore/src/config.ts:2774"
  },
  {
    "path": "memory.recall.conclusionLayer.maxTotalChars",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未设=关。非正=0。",
    "source": "MemoryCore/src/config.ts:2743"
  },
  {
    "path": "memory.recall.conclusionLayer.minBm25Rel",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设=off。",
    "source": "MemoryCore/src/config.ts:2762"
  },
  {
    "path": "memory.recall.conclusionLayer.minBm25RelRatio",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设=off。clamp 0..1。",
    "source": "MemoryCore/src/config.ts:2768"
  },
  {
    "path": "memory.recall.conclusionLayer.minUniqRatio",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设=关。clamp 0..1。",
    "source": "MemoryCore/src/config.ts:2748"
  },
  {
    "path": "memory.recall.conclusionLayer.pairing",
    "tier": "D",
    "type": "enum(off|require)",
    "def": "off",
    "meaning": "仅 require。",
    "source": "MemoryCore/src/config.ts:2784"
  },
  {
    "path": "memory.recall.conclusionLayer.rerankGate.minScore",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未写或非有限时键不出现。消费侧 auto-recall.ts:1720 回落 -1。",
    "source": "MemoryCore/src/config.ts:2465"
  },
  {
    "path": "memory.recall.conclusionLayer.rerankGate.mode",
    "tier": "D",
    "type": "enum(shadow|enforce|off)",
    "def": "unset",
    "meaning": "只在 rerankGate 组写了才有。enforce/off 透传，其它值回落 shadow。整组未写时对象是 undefined；消费侧 auto-recall.ts:1660 把",
    "source": "MemoryCore/src/config.ts:2340"
  },
  {
    "path": "memory.recall.conclusionLayer.routing",
    "tier": "D",
    "type": "enum(off|assistantRecall|intent)",
    "def": "off",
    "meaning": "assistantRecall|intent|其它 off。",
    "source": "MemoryCore/src/config.ts:2780"
  },
  {
    "path": "memory.recall.conclusionLayer.slotCost",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设则消费侧 1.5。clamp 1..3。",
    "source": "MemoryCore/src/config.ts:2787"
  },
  {
    "path": "memory.recall.conclusionLayer.truncateMode",
    "tier": "D",
    "type": "enum(chars|sentences)",
    "def": "chars",
    "meaning": "仅 sentences。",
    "source": "MemoryCore/src/config.ts:2739"
  },
  {
    "path": "memory.recall.conclusionRelaxedForAnalytical",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2589"
  },
  {
    "path": "memory.recall.coreRefBoost",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "历史注释写 0.05。注释与代码不一致：注释写默认 0.05，代码缺省 0。 缺省 0。 命中价值锚标签的候选排序加成，缺省 0",
    "source": "MemoryCore/src/config.ts:2489"
  },
  {
    "path": "memory.recall.dynamicTopK.dropRatio",
    "tier": "D",
    "type": "float",
    "def": "0.5",
    "meaning": "clamp 0.01..1。",
    "source": "MemoryCore/src/config.ts:2839"
  },
  {
    "path": "memory.recall.dynamicTopK.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2395"
  },
  {
    "path": "memory.recall.dynamicTopK.minTopK",
    "tier": "D",
    "type": "int",
    "def": "2",
    "meaning": "clamp 1..50。",
    "source": "MemoryCore/src/config.ts:2838"
  },
  {
    "path": "memory.recall.emotionSalienceWeight",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "下限 0。",
    "source": "MemoryCore/src/config.ts:2565"
  },
  {
    "path": "memory.recall.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 true。 未找到生产调用（可能死键或只在测试中）",
    "source": "MemoryCore/src/config.ts:2101"
  },
  {
    "path": "memory.recall.evidencePack.adjacent",
    "tier": "D",
    "type": "int",
    "def": "1",
    "meaning": "clamp 0..3。",
    "source": "MemoryCore/src/config.ts:2612"
  },
  {
    "path": "memory.recall.evidencePack.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2271"
  },
  {
    "path": "memory.recall.evidencePack.maxExtraLines",
    "tier": "D",
    "type": "int",
    "def": "6",
    "meaning": "clamp 0..24。",
    "source": "MemoryCore/src/config.ts:2614"
  },
  {
    "path": "memory.recall.evidencePack.maxSessionRows",
    "tier": "D",
    "type": "int",
    "def": "400",
    "meaning": "clamp 1..5000。",
    "source": "MemoryCore/src/config.ts:2615"
  },
  {
    "path": "memory.recall.evidencePack.windowMinutes",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "clamp 0..1440。",
    "source": "MemoryCore/src/config.ts:2613"
  },
  {
    "path": "memory.recall.excludeInvalidated",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。 缺省 true。 与 validity.mode 合成失效排除策略，决定失效行是否离开候选池",
    "source": "MemoryCore/src/config.ts:2531"
  },
  {
    "path": "memory.recall.exploreSlot",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。 缺省 true。 !==false 时给探索槽留位，false 关闭该通道",
    "source": "MemoryCore/src/config.ts:2588"
  },
  {
    "path": "memory.recall.factChannel.candidateK",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未写、或小于 1 时键不出现。消费侧 auto-recall.ts:4110 回落 candidateK。",
    "source": "MemoryCore/src/config.ts:2436"
  },
  {
    "path": "memory.recall.factChannel.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "只在 factChannel 组写了才有。组存在时未写 enabled 回落 false。整组未写时对象是 undefined，通道退出。",
    "source": "MemoryCore/src/config.ts:2131"
  },
  {
    "path": "memory.recall.factChannel.minScore",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未写或非有限时键不出现。消费侧 auto-recall.ts:4307 回落 recall.scoreThreshold。",
    "source": "MemoryCore/src/config.ts:2225"
  },
  {
    "path": "memory.recall.factChannel.onlyForTypes",
    "tier": "D",
    "type": "list<str>",
    "def": "unset",
    "meaning": "未写或空数组时键不出现，等于全类型。",
    "source": "MemoryCore/src/config.ts:2350"
  },
  {
    "path": "memory.recall.factChannel.weight",
    "tier": "D",
    "type": "float",
    "def": "0.6",
    "meaning": "组存在时，非数字或负数回落 0.6，上界 clamp 到 1。",
    "source": "MemoryCore/src/config.ts:2463"
  },
  {
    "path": "memory.recall.foldClusterEnabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。 缺省 false。 ===true 才在搜索返回前用 foldClusterAwareWithMeta 折叠近重复行，否则保持原行",
    "source": "MemoryCore/src/config.ts:2629"
  },
  {
    "path": "memory.recall.ftsOnlyInjectCap",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未设则运行期 2。",
    "source": "MemoryCore/src/config.ts:2832"
  },
  {
    "path": "memory.recall.fusion.bm25",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传。消费侧按 mode 回落：rrf 1，weighted 0.3，normalized 0.2。",
    "source": "MemoryCore/src/config.ts:2452"
  },
  {
    "path": "memory.recall.fusion.dense",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传，不填缺省。消费侧 fusionWeightsOf 按 mode 回落：rrf 恒等 1，weighted 0.4，normalized 0.5。非法或负数同样回落。",
    "source": "MemoryCore/src/config.ts:2451"
  },
  {
    "path": "memory.recall.fusion.fact",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传。融合表缺省 rrf/weighted 都是 0、normalized 是 0.3。事实通道真实权重另走 factChannelWeightOf：本键优先，否则 factChannel.weight，再否则 0.6。",
    "source": "MemoryCore/src/config.ts:2453"
  },
  {
    "path": "memory.recall.fusion.mode",
    "tier": "D",
    "type": "enum(rrf|weighted|normalized)",
    "def": "rrf",
    "meaning": "只在 fusion 组写了才有。weighted/normalized 透传，其它值回落 rrf。整组未写时对象本身是 undefined。",
    "source": "MemoryCore/src/config.ts:2340"
  },
  {
    "path": "memory.recall.fusion.recency",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传。消费侧按 mode 回落：rrf 0，weighted 0.2，normalized 0。",
    "source": "MemoryCore/src/config.ts:2454"
  },
  {
    "path": "memory.recall.fusion.recencyHalfLifeDays",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传。消费侧 recencyHalfLifeDaysOf：未设、非有限或非正都回落 30。",
    "source": "MemoryCore/src/config.ts:2456"
  },
  {
    "path": "memory.recall.fusion.validity",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "parse 原样透传。消费侧按 mode 回落：rrf 0，weighted 0.1，normalized 0。",
    "source": "MemoryCore/src/config.ts:2455"
  },
  {
    "path": "memory.recall.graphDiscount",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "历史注释写 0.6。注释与代码不一致：注释写默认 0.6，代码缺省 0。上界 1。 缺省 0。 0 时图扩散通道完全退出，否则作为邻居候选分的折扣",
    "source": "MemoryCore/src/config.ts:2525"
  },
  {
    "path": "memory.recall.graphMinStrength",
    "tier": "D",
    "type": "float",
    "def": "0.5",
    "meaning": "上界 1。",
    "source": "MemoryCore/src/config.ts:2521"
  },
  {
    "path": "memory.recall.importancePenalty.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2504"
  },
  {
    "path": "memory.recall.importancePenalty.penalty",
    "tier": "D",
    "type": "float",
    "def": "0.3",
    "meaning": "上界 0.9。",
    "source": "MemoryCore/src/config.ts:2505"
  },
  {
    "path": "memory.recall.inferredPenalty",
    "tier": "D",
    "type": "float",
    "def": "0.1",
    "meaning": "上界 1。 缺省 0.1。 certainty=inferred 的候选降权系数",
    "source": "MemoryCore/src/config.ts:2498"
  },
  {
    "path": "memory.recall.injectTimeSort.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2604"
  },
  {
    "path": "memory.recall.injectWrapper",
    "tier": "D",
    "type": "enum(legacy|neutral|calibrated)",
    "def": "calibrated",
    "meaning": "INJECT_WRAPPER_DEFAULT。未知值回落该常量。 缺省 calibrated。 决定注入块头是 legacy 还是新包装文案",
    "source": "MemoryCore/src/config.ts:2608"
  },
  {
    "path": "memory.recall.maxCharsPerMemory",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "最多保留多少字，多了截断。",
    "source": "MemoryCore/src/config.ts:2475"
  },
  {
    "path": "memory.recall.maxResults",
    "tier": "D",
    "type": "int",
    "def": "10",
    "meaning": "一次最多返回几条。 缺省 10。 经验层注入条数上限；精排 active 时临时扩到 rerank.candidates，searchMemories 也用它做截断",
    "source": "MemoryCore/src/config.ts:2433"
  },
  {
    "path": "memory.recall.maxTotalRecallChars",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "0=不限。",
    "source": "MemoryCore/src/config.ts:2476"
  },
  {
    "path": "memory.recall.mmr.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2504"
  },
  {
    "path": "memory.recall.mmr.lambda",
    "tier": "D",
    "type": "float",
    "def": "0.7",
    "meaning": "clamp 0..1。",
    "source": "MemoryCore/src/config.ts:2933"
  },
  {
    "path": "memory.recall.moodBoost",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2519"
  },
  {
    "path": "memory.recall.nativeMinRRF",
    "tier": "D",
    "type": "float",
    "def": "unset",
    "meaning": "未设=关。",
    "source": "MemoryCore/src/config.ts:2480"
  },
  {
    "path": "memory.recall.pprDamping",
    "tier": "D",
    "type": "float",
    "def": "0.85",
    "meaning": "上界 1。 缺省 0.85。 作为 PPR 阻尼传入 runPPRDetail，缺省回落引擎默认",
    "source": "MemoryCore/src/config.ts:2569"
  },
  {
    "path": "memory.recall.pprIterations",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "下限 1，上界 100。",
    "source": "MemoryCore/src/config.ts:2571"
  },
  {
    "path": "memory.recall.pprTopK",
    "tier": "D",
    "type": "int",
    "def": "10",
    "meaning": "上界 100。",
    "source": "MemoryCore/src/config.ts:2570"
  },
  {
    "path": "memory.recall.presentTemporal.boost",
    "tier": "D",
    "type": "float",
    "def": "0.08",
    "meaning": "上界 1。",
    "source": "MemoryCore/src/config.ts:2514"
  },
  {
    "path": "memory.recall.presentTemporal.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2201"
  },
  {
    "path": "memory.recall.presentTemporal.recentDays",
    "tier": "D",
    "type": "int",
    "def": "30",
    "meaning": "下限 1。",
    "source": "MemoryCore/src/config.ts:2511"
  },
  {
    "path": "memory.recall.queryEmbeddingCacheTtlMs",
    "tier": "D",
    "type": "ms",
    "def": "60000",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2528"
  },
  {
    "path": "memory.recall.queryExpansion.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2579"
  },
  {
    "path": "memory.recall.queryExpansion.hotPathTimeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "1500",
    "meaning": "0=旧行为全额等待。",
    "source": "MemoryCore/src/config.ts:2583"
  },
  {
    "path": "memory.recall.queryExpansion.maxTerms",
    "tier": "D",
    "type": "int",
    "def": "8",
    "meaning": "上界 32，下限 1。",
    "source": "MemoryCore/src/config.ts:2580"
  },
  {
    "path": "memory.recall.queryExpansion.negativeTtlMs",
    "tier": "D",
    "type": "ms",
    "def": "30000",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2584"
  },
  {
    "path": "memory.recall.queryExpansion.timeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "8000",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。",
    "source": "MemoryCore/src/config.ts:2582"
  },
  {
    "path": "memory.recall.queryExpansion.ttlMs",
    "tier": "D",
    "type": "ms",
    "def": "600000",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2581"
  },
  {
    "path": "memory.recall.recencyBoost",
    "tier": "D",
    "type": "float",
    "def": "0.03",
    "meaning": "改这个值会改变这项运行行为。 缺省 0.03。 排序层新近度权重",
    "source": "MemoryCore/src/config.ts:2496"
  },
  {
    "path": "memory.recall.reinforcementWeight",
    "tier": "D",
    "type": "float",
    "def": "0.03",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2518"
  },
  {
    "path": "memory.recall.rerankWeights.coreRef",
    "tier": "D",
    "type": "float",
    "def": "0.05",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2854"
  },
  {
    "path": "memory.recall.rerankWeights.relevance",
    "tier": "D",
    "type": "float",
    "def": "0.7",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2851"
  },
  {
    "path": "memory.recall.rerankWeights.significance",
    "tier": "D",
    "type": "float",
    "def": "0.1",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2853"
  },
  {
    "path": "memory.recall.rerankWeights.timeProx",
    "tier": "D",
    "type": "float",
    "def": "0.15",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2852"
  },
  {
    "path": "memory.recall.sceneBoost",
    "tier": "D",
    "type": "float",
    "def": "0",
    "meaning": "历史注释写 0.04。注释与代码不一致：注释写默认 0.04，代码缺省 0。 缺省 0。 场景命中加成，0 等于该通道退出",
    "source": "MemoryCore/src/config.ts:2526"
  },
  {
    "path": "memory.recall.scoreThreshold",
    "tier": "D",
    "type": "float",
    "def": "0.3",
    "meaning": "分数低于这个值就丢掉。0 等于不卡。 缺省 0。 余弦门槛，低于该分的命中不进候选池；三路同源透传，缺省 0=只排序不过滤",
    "source": "MemoryCore/src/config.ts:2478"
  },
  {
    "path": "memory.recall.sessionReuseTtlMs",
    "tier": "D",
    "type": "ms",
    "def": "300000",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2566"
  },
  {
    "path": "memory.recall.sigWeight",
    "tier": "D",
    "type": "float",
    "def": "0.03",
    "meaning": "改这个值会改变这项运行行为。 缺省 0.03。 排序层显著性权重",
    "source": "MemoryCore/src/config.ts:2497"
  },
  {
    "path": "memory.recall.smallToBig.budget",
    "tier": "D",
    "type": "enum(shared|additive|slot)",
    "def": "shared",
    "meaning": "additive|slot|其它 shared。",
    "source": "MemoryCore/src/config.ts:2822"
  },
  {
    "path": "memory.recall.smallToBig.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2816"
  },
  {
    "path": "memory.recall.smallToBig.maxExtraLines",
    "tier": "D",
    "type": "int",
    "def": "2",
    "meaning": "非正=0。",
    "source": "MemoryCore/src/config.ts:2817"
  },
  {
    "path": "memory.recall.smallToBig.relevanceRanked",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2827"
  },
  {
    "path": "memory.recall.strategy",
    "tier": "D",
    "type": "enum(embedding|keyword|hybrid)",
    "def": "hybrid",
    "meaning": "非法值回落 hybrid。 缺省 hybrid。 缺省 hybrid，决定本轮召回走向量混合还是其它策略",
    "source": "MemoryCore/src/config.ts:2481"
  },
  {
    "path": "memory.recall.timeBoost",
    "tier": "D",
    "type": "float",
    "def": "0.05",
    "meaning": "下限 0。 缺省 0.05。 排序层时间邻近信号权重，传入 search 的 rank signals",
    "source": "MemoryCore/src/config.ts:2495"
  },
  {
    "path": "memory.recall.timeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "5000",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。 缺省 5000。 整段召回 Promise.race 的超时毫秒，缺省 5000",
    "source": "MemoryCore/src/config.ts:2221"
  },
  {
    "path": "memory.recall.timeProxFallbackEnabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2626"
  },
  {
    "path": "memory.recall.v3Recall.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2864"
  },
  {
    "path": "memory.recall.v3Recall.l1BudgetMs",
    "tier": "D",
    "type": "ms",
    "def": "2000",
    "meaning": "<=0 表示关预算。正值 clamp 200..15000。",
    "source": "MemoryCore/src/config.ts:2870"
  },
  {
    "path": "memory.recall.v3Recall.l1Fallback",
    "tier": "D",
    "type": "enum(fts|none)",
    "def": "fts",
    "meaning": "仅 none 被采纳。",
    "source": "MemoryCore/src/config.ts:2876"
  },
  {
    "path": "memory.recall.v3Recall.timeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "5000",
    "meaning": "这次调用最多等多久，单位毫秒。超时就放弃。",
    "source": "MemoryCore/src/config.ts:2865"
  },
  {
    "path": "memory.recall.validity.hardOnPresentIntent",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2561"
  },
  {
    "path": "memory.recall.validity.mode",
    "tier": "D",
    "type": "enum(hard|soft)",
    "def": "soft",
    "meaning": "注释与代码不一致：接口注释写默认 hard，代码缺省 soft。非法值回落 soft 并告警。",
    "source": "MemoryCore/src/config.ts:2340"
  },
  {
    "path": "memory.recall.validity.softPenalty",
    "tier": "D",
    "type": "float",
    "def": "0.5",
    "meaning": "clamp 0..1。",
    "source": "MemoryCore/src/config.ts:2560"
  },
  {
    "path": "memory.recallJournal.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。 缺省 false。 true 才把召回日志 append 到 logs/recall，失败不影响主链路",
    "source": "MemoryCore/src/config.ts:2513"
  },
  {
    "path": "memory.recallJournal.maxFiles",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "<1 回落 5，上界 100。",
    "source": "MemoryCore/src/config.ts:2950"
  },
  {
    "path": "memory.recallJournal.rotationSizeMB",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "非正回落 5，上界 100。",
    "source": "MemoryCore/src/config.ts:2945"
  },
  {
    "path": "memory.sceneGovernance.distillTimeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "60000",
    "meaning": "负值抬到 0。",
    "source": "MemoryCore/src/config.ts:2255"
  },
  {
    "path": "memory.sceneGovernance.hardCapChars",
    "tier": "D",
    "type": "int",
    "def": "20000",
    "meaning": "不得低于 maxBlockChars。",
    "source": "MemoryCore/src/config.ts:2258"
  },
  {
    "path": "memory.sceneGovernance.maxBlockChars",
    "tier": "D",
    "type": "int",
    "def": "8000",
    "meaning": "clamp 500..100000。",
    "source": "MemoryCore/src/config.ts:2251"
  },
  {
    "path": "memory.search.neighborExpand.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:1961"
  },
  {
    "path": "memory.search.neighborExpand.maxAdd",
    "tier": "D",
    "type": "int",
    "def": "3",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2236"
  },
  {
    "path": "memory.search.neighborExpand.maxHop",
    "tier": "D",
    "type": "int",
    "def": "1",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2235"
  },
  {
    "path": "memory.sensitivity.extractionEnabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。 缺省 false。 true 才把敏感性标注块拼进 L1 prompt",
    "source": "MemoryCore/src/config.ts:3025"
  },
  {
    "path": "memory.wiki.baseUrl",
    "tier": "D",
    "type": "str",
    "def": "http://127.0.0.1:8421",
    "meaning": "外部服务地址。 缺省 http://127.0.0.1:8421。 yaml 缺省。与 wiki-config.ts:26 常量一致。 合并 env 后作为 WikiForwardClient.baseUrl，空则回落缺省地址",
    "source": "MemoryCore/src/config.ts:2219"
  },
  {
    "path": "memory.wiki.concurrency",
    "tier": "D",
    "type": "int",
    "def": "4",
    "meaning": "缺省 4。clamp 1 到 8。无 env。 clamp 1 到 8。无 env。",
    "source": "MemoryCore/src/config.ts:2227"
  },
  {
    "path": "memory.wiki.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。开了这条能力才工作，关了就当没有。 缺省 true。 yaml 缺省 true。env 覆盖在 wiki-config.ts:70。 false 时 wiki 转发入口直接 403，文案写 memory.wiki.enabled=false",
    "source": "MemoryCore/src/config.ts:1931"
  },
  {
    "path": "memory.wiki.maxWikis",
    "tier": "D",
    "type": "int",
    "def": "8",
    "meaning": "缺省 8。clamp 1 到 16。无 env。 clamp 1 到 16。无 env。",
    "source": "MemoryCore/src/config.ts:2226"
  },
  {
    "path": "memory.wiki.minScore",
    "tier": "D",
    "type": "float",
    "def": "0.02",
    "meaning": "clamp 0..10。env TDB_WIKI_MIN_SCORE 覆盖。",
    "source": "MemoryCore/src/config.ts:2225"
  },
  {
    "path": "memory.wiki.perWikiLimit",
    "tier": "D",
    "type": "int",
    "def": "4",
    "meaning": "缺省 4。clamp 1 到 20 后 floor。无对应 env。 clamp 1 到 20 后 floor。无对应 env。",
    "source": "MemoryCore/src/config.ts:2223"
  },
  {
    "path": "memory.wiki.perWikiTimeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "2000",
    "meaning": "clamp 100..10000。env TDB_WIKI_PER_WIKI_TIMEOUT_MS 覆盖。",
    "source": "MemoryCore/src/config.ts:2222"
  },
  {
    "path": "memory.wiki.serviceId",
    "tier": "D",
    "type": "str",
    "def": "default",
    "meaning": "缺省 default。yaml",
    "source": "MemoryCore/src/config.ts:2220"
  },
  {
    "path": "memory.wiki.teamVerify",
    "tier": "D",
    "type": "enum(off|warn|enforce)",
    "def": "enforce",
    "meaning": "off|warn|enforce，其它回落 enforce。env TDB_WIKI_TEAM_VERIFY 覆盖。",
    "source": "MemoryCore/src/config.ts:2214"
  },
  {
    "path": "memory.wiki.timeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "2500",
    "meaning": "最多等多久（毫秒）。超时就放弃这次调用，避免卡住。 缺省 2500。 yaml clamp 100 到 10000。",
    "source": "MemoryCore/src/config.ts:2221"
  },
  {
    "path": "memory.wiki.topK",
    "tier": "D",
    "type": "int",
    "def": "6",
    "meaning": "clamp 1..20。env TDB_WIKI_TOP_K 覆盖。",
    "source": "MemoryCore/src/config.ts:2224"
  },
  {
    "path": "memory.write.factKey.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2338"
  },
  {
    "path": "memory.write.factKey.includeTriples",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2349"
  },
  {
    "path": "memory.write.factKey.maxFactChars",
    "tier": "D",
    "type": "int",
    "def": "240",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2347"
  },
  {
    "path": "memory.write.factKey.maxFacts",
    "tier": "D",
    "type": "int",
    "def": "5",
    "meaning": "clampMaxFacts，缺省 5。",
    "source": "MemoryCore/src/config.ts:2348"
  },
  {
    "path": "memory.write.factKey.mode",
    "tier": "D",
    "type": "enum(replace|channel)",
    "def": "replace",
    "meaning": "仅 append 被采纳，其它 replace。",
    "source": "MemoryCore/src/config.ts:2340"
  },
  {
    "path": "memory.write.factKey.onlyForTypes",
    "tier": "D",
    "type": "list<str>",
    "def": "",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2350"
  },
  {
    "path": "memory.write.factKey.separator",
    "tier": "D",
    "type": "str",
    "def": " | ",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2344"
  },
  {
    "path": "memory.write.factRows.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2070"
  },
  {
    "path": "memory.write.factRows.maxFacts",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "未设置保持 undefined，不套 DEFAULT_MAX_FACTS。",
    "source": "MemoryCore/src/config.ts:2370"
  },
  {
    "path": "memory.write.supersession.cardinalityDefault",
    "tier": "D",
    "type": "enum(single|multi)",
    "def": "single",
    "meaning": "仅 multi 被采纳，其它 single。",
    "source": "MemoryCore/src/config.ts:2358"
  },
  {
    "path": "memory.write.supersession.cardinalityGate",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "改这个值会改变这项运行行为。",
    "source": "MemoryCore/src/config.ts:2361"
  },
  {
    "path": "memory.write.supersession.enabled",
    "tier": "D",
    "type": "bool",
    "def": "true",
    "meaning": "总开关。关掉这条能力就不工作。",
    "source": "MemoryCore/src/config.ts:2063"
  },
  {
    "path": "metadata.configParamsFile",
    "tier": "D",
    "type": "path",
    "def": "unset",
    "meaning": "缺省 undefined。yaml 参数文件路径。 yaml 参数文件路径。",
    "source": "MemoryCore/src/gateway/config.ts:585"
  },
  {
    "path": "metadata.maxTeamsPerInstance",
    "tier": "D",
    "type": "int",
    "def": "100",
    "meaning": "缺省 100。yaml 团队上限。 yaml 团队上限。",
    "source": "MemoryCore/src/gateway/config.ts:582"
  },
  {
    "path": "metadata.maxUsersPerInstance",
    "tier": "D",
    "type": "int",
    "def": "500",
    "meaning": "缺省 500。yaml 用户上限，被 env 覆盖。与 JSON quota.max_users_per_instance 种子值同为 500，但是另一条通道。 yaml 用户上限，被 env 覆盖。与 JSON quota.max_users_per_instance 种子值同为 500，但是另一条通道。",
    "source": "MemoryCore/src/gateway/config.ts:578"
  },
  {
    "path": "metadata.store.mongoDbPrefix",
    "tier": "D",
    "type": "str",
    "def": "tdai_metadata",
    "meaning": "缺省 undefined。类型注释 :176 写默认 tdai_metadata，但加载函数不填该默认。注释与代码不一致。mongoUri 出现即抛错。 类型注释 :176 写默认 tdai_metadata，但加载函数不填该默认。注释与代码不一致。mongoUri 出现即抛错。",
    "source": "MemoryCore/src/gateway/config.ts:568"
  },
  {
    "path": "metadata.store.sqliteBaseDir",
    "tier": "D",
    "type": "path",
    "def": "unset",
    "meaning": "缺省 undefined。元数据 sqlite 目录。三者都空则 store 整段 undefined。无 env 覆盖。 元数据 sqlite 目录。三者都空则 store 整段 undefined。无 env 覆盖。",
    "source": "MemoryCore/src/gateway/config.ts:566"
  },
  {
    "path": "metadata.store.storeCacheMaxInstances",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "缺省 undefined。实例 store 连接 LRU 上限。注释未给数字默认，代码也不填默认。 实例 store 连接 LRU 上限。注释未给数字默认，代码也不填默认。",
    "source": "MemoryCore/src/gateway/config.ts:567"
  },
  {
    "path": "metadata.systemUser.memory.displayName",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 undefined。系统用户显示名。",
    "source": "MemoryCore/src/gateway/config.ts:588"
  },
  {
    "path": "metadata.systemUser.memory.userId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 undefined。内部静态系统用户，仅 auth/verify，不落库。三字段都空则整段 undefined。 内部静态系统用户，仅 auth/verify，不落库。三字段都空则整段 undefined。",
    "source": "MemoryCore/src/gateway/config.ts:587"
  },
  {
    "path": "metadata.systemUser.memory.userKey",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 undefined。系统用户 key。 系统用户 key。",
    "source": "MemoryCore/src/gateway/config.ts:587"
  },
  {
    "path": "observability.type",
    "tier": "D",
    "type": "enum(noop|console)",
    "def": "noop",
    "meaning": "缺省 noop。yaml 观测后端。otel/clickhouse/kafka/langfuse 子块 enabled=true 抛错，false 忽略并警告。 yaml 观测后端。otel/clickhouse/kafka/langfuse 子块 enabled=true 抛错，false 忽略并警告。",
    "source": "MemoryCore/src/gateway/config.ts:521"
  },
  {
    "path": "scanner.instances",
    "tier": "D",
    "type": "str",
    "def": "default",
    "meaning": "缺省 default。yaml 扫描实例。 yaml 扫描实例。",
    "source": "MemoryCore/src/gateway/config.ts:491"
  },
  {
    "path": "scanner.intervalMs",
    "tier": "D",
    "type": "ms",
    "def": "500",
    "meaning": "隔多久跑一轮（毫秒）。 缺省 500。 yaml 扫描间隔。",
    "source": "MemoryCore/src/gateway/config.ts:493"
  },
  {
    "path": "scanner.nodeId",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "缺省 undefined。yaml 节点 ID。 yaml 节点 ID。",
    "source": "MemoryCore/src/gateway/config.ts:494"
  },
  {
    "path": "skill.compress.headBytes",
    "tier": "D",
    "type": "int",
    "def": "1024",
    "meaning": "缺省 1024。未指定 1024。 未指定 1024。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:249"
  },
  {
    "path": "skill.compress.tailBytes",
    "tier": "D",
    "type": "int",
    "def": "1024",
    "meaning": "缺省 1024。未指定 1024。 未指定 1024。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:250"
  },
  {
    "path": "skill.compress.toolContentThresholdBytes",
    "tier": "D",
    "type": "int",
    "def": "2048",
    "meaning": "缺省 2048。未指定 2048。 未指定 2048。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:248"
  },
  {
    "path": "skill.contentBackend",
    "tier": "D",
    "type": "enum(local|cos)",
    "def": "unset",
    "meaning": "缺省 probe。未指定时有 COS 凭据为 cos，否则 local。显式 cos 且无凭据：非 strict 降级 local。无固定字面默认。 未指定时有 COS 凭据为 cos，否则 local。显式 cos 且无凭据：非 strict 降级 local。无固定字面默认。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:93"
  },
  {
    "path": "skill.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。开了这条能力才工作，关了就当没有。 缺省 true。 Inject the <available_skills> listing into the head pack and register the skill tools.",
    "source": "MemoryCore/src/core/skill/skill-config.ts:137"
  },
  {
    "path": "skill.extraction.archiveBytes",
    "tier": "D",
    "type": "int",
    "def": "40960",
    "meaning": "缺省 40960。DEFAULT_ARCHIVE_BYTES=40*1024。非正整数回落并 warn。派生 bytesThreshold requestCompressThre DEFAULT_ARCHIVE_BYTES=40*1024。非正整数回落并 warn。派生 bytesThreshold requestCompressThresholdBytes headKeepBytes tailKeepBytes headChars t",
    "source": "MemoryCore/src/core/skill/skill-config.ts:153"
  },
  {
    "path": "skill.extraction.enabled",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "总开关。开了这条能力才工作，关了就当没有。 缺省 false。 仅严格等于 true 才开。无 LLMRunner 时不关开关，但记 degradation。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:137"
  },
  {
    "path": "skill.extraction.maxIterations",
    "tier": "D",
    "type": "int",
    "def": "16",
    "meaning": "缺省 16。未指定 16。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:227"
  },
  {
    "path": "skill.extraction.maxTokens",
    "tier": "D",
    "type": "int",
    "def": "unset",
    "meaning": "缺省 undefined。可选，无默认。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:229"
  },
  {
    "path": "skill.extraction.model",
    "tier": "D",
    "type": "str",
    "def": "unset",
    "meaning": "用哪个模型。 缺省 undefined。 可选，无默认。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:226"
  },
  {
    "path": "skill.extraction.prefixSkillsLimit",
    "tier": "D",
    "type": "int",
    "def": "20",
    "meaning": "缺省 20。正整数校验，非法回落 20。 正整数校验，非法回落 20。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:231"
  },
  {
    "path": "skill.extraction.timeoutMs",
    "tier": "D",
    "type": "ms",
    "def": "unset",
    "meaning": "最多等多久（毫秒）。超时就放弃这次调用，避免卡住。 缺省 undefined。 可选，无默认。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:230"
  },
  {
    "path": "skill.extraction.toolCallThreshold",
    "tier": "D",
    "type": "int",
    "def": "10",
    "meaning": "缺省 10。未指定 10。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:225"
  },
  {
    "path": "skill.resources.allowExecutable",
    "tier": "D",
    "type": "bool",
    "def": "false",
    "meaning": "缺省 false。仅严格等于 true 才允许。 仅严格等于 true 才允许。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:256"
  },
  {
    "path": "skill.resources.downloadDir",
    "tier": "D",
    "type": "path",
    "def": "/tmp/tdai-skill-resources",
    "meaning": "缺省 /tmp/tdai-skill-resources。未指定用该路径。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:255"
  },
  {
    "path": "skill.resources.maxResourceSizeBytes",
    "tier": "D",
    "type": "int",
    "def": "5000000",
    "meaning": "缺省 5000000。未指定 5000000。 未指定 5000000。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:253"
  },
  {
    "path": "skill.routing.charBudgetPercent",
    "tier": "D",
    "type": "float",
    "def": "0.01",
    "meaning": "缺省 0.01。未指定 0.01。 未指定 0.01。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:220"
  },
  {
    "path": "skill.routing.fastPathMinNameLength",
    "tier": "D",
    "type": "int",
    "def": "4",
    "meaning": "缺省 4。未指定 4。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:221"
  },
  {
    "path": "skill.routing.hybridAlpha",
    "tier": "D",
    "type": "float",
    "def": "0.3",
    "meaning": "缺省 0.3。未指定 0.3。无 clamp。 未指定 0.3。无 clamp。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:218"
  },
  {
    "path": "skill.routing.mode",
    "tier": "D",
    "type": "enum(bm25|embedding|hybrid)",
    "def": "bm25",
    "meaning": "缺省 bm25。embedding 或 hybrid 在 embedding 不可用时降级 bm25。 embedding 或 hybrid 在 embedding 不可用时降级 bm25。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:217"
  },
  {
    "path": "skill.routing.searchTopK",
    "tier": "D",
    "type": "int",
    "def": "20",
    "meaning": "缺省 20。未指定 20。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:219"
  },
  {
    "path": "skill.storeBackend",
    "tier": "D",
    "type": "enum(sqlite)",
    "def": "unset",
    "meaning": "缺省 sqlite。写死 sqlite。文件头注释 :12 仍写 inherit probe.outerStoreBackend fallback sqlite，与代码不一致。 写死 sqlite。文件头注释 :12 仍写 inherit probe.outerStoreBackend fallback sqlite，与代码不一致。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:77"
  },
  {
    "path": "skill.versionTtlDays",
    "tier": "D",
    "type": "int",
    "def": "0",
    "meaning": "缺省 0。输入单位天，输出 versionTtlSeconds=(days 缺省 0)*86400。默认 0 秒。 输入单位天，输出 versionTtlSeconds=(days 缺省 0)*86400。默认 0 秒。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:258"
  },
  {
    "path": "skill.worker.brpopBlockMs",
    "tier": "D",
    "type": "ms",
    "def": "5000",
    "meaning": "缺省 5000。DEFAULT_WORKER_BRPOP_MS=5000。正整数，非法回落。 DEFAULT_WORKER_BRPOP_MS=5000。正整数，非法回落。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:261"
  },
  {
    "path": "skill.worker.concurrency",
    "tier": "D",
    "type": "int",
    "def": "60",
    "meaning": "缺省 60。DEFAULT_WORKER_CONCURRENCY=60。env 非法时才看 yaml；yaml 也非法回落 60。 DEFAULT_WORKER_CONCURRENCY=60。env 非法时才看 yaml；yaml 也非法回落 60。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:260"
  },
  {
    "path": "skill.worker.extractLockRenewIntervalMs",
    "tier": "D",
    "type": "ms",
    "def": "unset",
    "meaning": "缺省 floor(ttl/4)=150000。未指定时为 floor(生效 ttl/4)。默认 ttl 600000 下为 150000。 未指定时为 floor(生效 ttl/4)。默认 ttl 600000 下为 150000。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:263"
  },
  {
    "path": "skill.worker.extractLockTtlMs",
    "tier": "D",
    "type": "ms",
    "def": "600000",
    "meaning": "缺省 600000。DEFAULT_EXTRACT_LOCK_TTL_MS=600000。 DEFAULT_EXTRACT_LOCK_TTL_MS=600000。",
    "source": "MemoryCore/src/core/skill/skill-config.ts:262"
  },
  {
    "path": "worker.concurrency",
    "tier": "D",
    "type": "int",
    "def": "60",
    "meaning": "缺省 60。yaml worker 并发。与 skill 的 TDAI_SKILL_WORKER_CONCURRENCY 不是同一键。 yaml worker 并发。与 skill 的 TDAI_SKILL_WORKER_CONCURRENCY 不是同一键。",
    "source": "MemoryCore/src/gateway/config.ts:501"
  },
  {
    "path": "worker.pollMs",
    "tier": "D",
    "type": "ms",
    "def": "200",
    "meaning": "缺省 200。yaml 轮询间隔。 yaml 轮询间隔。",
    "source": "MemoryCore/src/gateway/config.ts:500"
  }
];

export const CONFIG_CATALOG = ENTRIES;
