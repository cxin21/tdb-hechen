# config/templates/env.ps1 — 五服务环境变量模板（PowerShell）
#
# 编码红线：本文件必须存为 UTF-8 with BOM。Windows PowerShell 5.1 无 BOM 时会按 ANSI 解码中文注释，
#   实测会让附近几行赋值被静默跳过（TDAI_MEMORY_SYSTEM_USER_ID 读出来是空串）。改完请用
#   powershell -NoProfile -ExecutionPolicy Bypass -Command ". ./config/templates/env.ps1; $env:TDAI_DATA_DIR" 自检。
#
# 用法（PowerShell）：
#   . ./config/templates/env.ps1            # dot-source之后进程内生效
#   . ./config/templates/env.ps1 -ListKeys  # 只打印 SET/unset，绝不打印值
#
# 档位只有两档（另 1 个变量归档在 env.keys.json 的 ignored）：
#   【现役】= 本机 D:/TDB/etc/env.ps1 真的设了、且代码能读到（12 个生效键 + 1 个归档的 TDAI_DSH_USER_KEY）
#   【建议】= 本机未设，当前值来自代码缺省或 yaml；只在需要时才取消注释
#   【现役·需填】= 本机设了但值是密钥：模板里整行注释 + <REPLACE_ME>，替换后自行去掉 #
#
# 红线：
#   1) 本文件不含真实密钥；<REPLACE_ME> 必须替换（或从凭据库导入），不要提交/外发。
#   2) 【现役】行 dot-source 即生效；【建议】行整行是注释。不要把【建议】整批取消注释——多数键本机该走缺省。
#   3) 行格式：档位 类型 default=缺省 — 改变什么行为 · 消费: file:line · 配错会怎样。
#
# 与 D:/TDB/etc/env.ps1 的关系：那份是本机现役 13 个变量的最小集（含真密钥，不共享）；本文件是「五包代码能读到的全集模板」，
#   新机器照这份配；键名与那份逐字一致，值因不能带密钥改成占位。
#
# 关于 proxy 的运行时渲染：MemoryProxy/config.yaml 写的是变量展开名（如 PROXY_ADMIN_API_KEY），启动时展开成
#   D:/TDB/data/run/proxy-config.runtime.yaml 临时副本 —— 不是第 13 个服务，只是渲染机制；改完变量要重启 proxy 才重新渲染。
#
# 维护纪律：键与 config/templates/env.keys.json 一一对应，改一边必须改另一边（scripts/check-config-templates.mjs 会核）。

param([switch]$ListKeys)

$ErrorActionPreference = "Stop"
$script:EnvKeys = @('TDAI_GATEWAY_PORT', 'TDAI_GATEWAY_HOST', 'TDAI_GATEWAY_APIKEY', 'TDAI_GATEWAY_API_KEY', 'TDAI_GATEWAY_CONFIG', 'TDAI_DATA_DIR', 'TDAI_CORS_ORIGINS', 'TDAI_DEPLOY_MODE', 'MEMORY_LOG_LEVEL', 'MEMORY_MAX_BODY_BYTES', 'STORE_MODE', 'STATE_BACKEND', 'MEMORY_TENCENTDB_ROOT', 'TDB_INJECTION_GUARD_MODE', 'TDAI_LLM_PROVIDER', 'TDAI_LLM_BASE_URL', 'TDAI_LLM_MODEL', 'TDAI_LLM_MAX_TOKENS', 'TDAI_LLM_TIMEOUT_MS', 'TDAI_LLM_STREAM', 'TDAI_LLM_API_KEY', 'TDAI_MEMORY_SYSTEM_USER_ID', 'TDAI_MEMORY_SYSTEM_USER_KEY', 'TDAI_MEMORY_SYSTEM_USER_NAME', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_DB', 'REDIS_KEY_PREFIX', 'SHARK_BASE_URL', 'CONFIG_VDB_TTL_MS', 'CONFIG_COS_BUFFER_MS', 'CONFIG_MAX_INSTANCES', 'SCANNER_INSTANCES', 'SCANNER_INSTANCES_SHARK_URL', 'SCANNER_INTERVAL_MS', 'SCANNER_NODE_ID', 'WORKER_POLL_MS', 'WORKER_CONCURRENCY', 'COS_DOMAIN', 'COS_GENERATION_LOG_RETENTION_DAYS', 'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_TOKEN', 'COS_BUCKET', 'COS_REGION', 'COS_PREFIX', 'COS_PATH_PREFIX', 'COS_URL', 'VDB_ENDPOINT', 'VDB_USER', 'VDB_API_KEY', 'VDB_DATABASE', 'VDB_CA_PEM_PATH', 'LOG_PATH', 'OPENCLAW_ROOT', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'TDAI_METADATA_MAX_USERS', 'TDAI_METADATA_MAX_TEAMS', 'TDAI_METADATA_CONFIG_PARAMS_FILE', 'TDAI_METADATA_MONGO_URI', 'TDAI_METADATA_MONGO_DB_PREFIX', 'TDAI_METADATA_MONGO_TRANSACTIONS', 'TDAI_METADATA_STORE_CACHE_MAX', 'TDAI_METADATA_SQLITE_BASE_DIR', 'MEMORY_AUTH_REQUIRE_USER_BINDING', 'MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY', 'MEMORY_AUTH_ADMIN_BYPASS_ENABLED', 'MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP', 'MEMORY_AUTH_TEAM_OWNERSHIP_WHITELIST', 'V3_STRICT_ISOLATION', 'TDAI_API_TRACE_ENABLED', 'TDAI_SKILL_ENABLED', 'TDAI_SKILL_WORKER_CONCURRENCY', 'TDAI_USER_KEY_MAX_ACTIVE', 'RERANK_THREADS', 'RERANK_DOC_CAP', 'RERANK_SCORE_DUMP', 'TDAI_OTEL_ENABLED', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_SERVICE_NAME', 'OTEL_TENANT_ID', 'OTEL_LOG_EXPORT_INTERVAL', 'OTEL_LOG_LEVEL', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_RESOURCE_ATTRIBUTES', 'TDAI_INSTANCE_ID', 'CLICKHOUSE_ENABLED', 'CLICKHOUSE_ENDPOINT', 'CLICKHOUSE_USERNAME', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_DATABASE', 'CLICKHOUSE_HTTP_ENDPOINT', 'CLICKHOUSE_USER', 'KAFKA_METRIC_ENABLED', 'KAFKA_METRIC_BROKERS', 'KAFKA_METRIC_TOPIC', 'LANGFUSE_ENABLED', 'LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'OPIK_ENABLED', 'OPIK_API_KEY', 'OPIK_URL_OVERRIDE', 'OPIK_PROJECT_NAME', 'OPIK_WORKSPACE', 'PORT', 'API_PREFIX', 'LOG_LEVEL', 'KNOWLEDGE_PUBLIC_BASE_URL', 'KNOWLEDGE_DATA_DIR', 'KNOWLEDGE_DB_PATH', 'KNOWLEDGE_SERVICE_KEY', 'KNOWLEDGE_API_URL', 'KNOWLEDGE_API_TOKEN', 'TMC_CALLBACK_URL', 'KNOWLEDGE_RERANK_URL', 'KNOWLEDGE_RERANK_API_KEY', 'KNOWLEDGE_RERANK_TIMEOUT_MS', 'LLM_MODE', 'LLM_PROTOCOL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS', 'LLM_STREAM', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'KNOWLEDGE_WIKI_POOL_MAX', 'KNOWLEDGE_WIKI_INGEST_CONCURRENCY', 'KNOWLEDGE_LLM_GLOBAL_CONCURRENCY', 'KNOWLEDGE_AUTO_SYNC_ENABLED', 'KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN', 'KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT', 'KNOWLEDGE_SSRF_CHECK', 'KNOWLEDGE_CLICKHOUSE_ENABLED', 'KNOWLEDGE_CLICKHOUSE_URL', 'KNOWLEDGE_CLICKHOUSE_DATABASE', 'KNOWLEDGE_CLICKHOUSE_TABLE', 'KNOWLEDGE_CLICKHOUSE_USER', 'KNOWLEDGE_CLICKHOUSE_PASSWORD', 'KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS', 'KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD', 'KNOWLEDGE_CLICKHOUSE_TTL_DAYS', 'KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS', 'LANGFUSE_BASE_URL', 'PROXY_DATA_DIR', 'PROXY_DB_PATH', 'CC_FORM_MODE', 'TDAI_KNOWLEDGE_CACHE_TTL_MS', 'TDAI_PROXY_ADMIN_API_KEY', 'PROXY_ADMIN_API_KEY', 'TDAI_TASK_DRAFT_API_KEY', 'TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS', 'PROXY_DEBUG_DUMP_BODY', 'PROXY_DEBUG_DUMP_INBOUND', 'PROXY_DEBUG_DUMP_OUTBOUND_MD5', 'PROXY_DEBUG_ASSET_REFLECTION', 'OTEL_BSP_MAX_QUEUE_SIZE', 'TDAI_WIKI_SYSTEM_USER_ID', 'TDAI_WIKI_SYSTEM_USER_KEY', 'TDAI_WIKI_SYSTEM_USER_NAME', 'HOST', 'LOG_FORMAT', 'METADATA_INSTANCES_CONFIG', 'METADATA_REMOTE_TIMEOUT_MS', 'UI_DIST_DIR', 'KNOWLEDGE_SERVICE_URL', 'KNOWLEDGE_AUTH_TOKEN', 'KNOWLEDGE_TIMEOUT_MS', 'KNOWLEDGE_LLM_BINDING_SYNC', 'KNOWLEDGE_LLM_PROXY_BASE_URL', 'TDAI_AGENT_TEMPLATE_DIR', 'LLM_PROVIDER_PROXY_BASE_URL', 'TDAI_RECALL_JOURNAL_DIR', 'DSH_HOME')
if ($ListKeys) {
  foreach ($n in $script:EnvKeys) {
    $v = [Environment]::GetEnvironmentVariable($n)
    $state = if ([string]::IsNullOrEmpty($v)) { "unset" } else { "SET" }
    Write-Output ($n.PadRight(42) + " " + $state)
  }
  return
}

# ── MemoryCore：进程与服务
# $env:TDAI_GATEWAY_PORT = ""   # 【建议】int default=8420 — core HTTP 监听端口 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:434 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_GATEWAY_HOST = ""   # 【建议】str default=127.0.0.1 — 监听地址；对外服务改 0.0.0.0 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:435 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_GATEWAY_APIKEY = $env:TDAI_GATEWAY_API_KEY   # 【现役·需填】 str default=none — 网关 Bearer（proxy/panel/knowledge 同源）；空=不校验 · 本机现役: proxy 只读本键（无下划线）；必须与 TDAI_GATEWAY_API_KEY 同值，只设一个 → 另一条链 401 · 消费: MemoryProxy/src/tdai/bearer-token.ts:48 · 配错: 与 API_KEY 不同值=proxy→core 401；空=core 不校验鉴权（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:TDAI_GATEWAY_API_KEY = "<REPLACE_ME: 从凭据库取真值>"   # 【现役·需填】 str default=none — 网关 Bearer 的存量别名；同设时无下划线优先 · 本机现役: core 端鉴权读这一对：TDAI_GATEWAY_APIKEY 优先、本键兜底（同一行 config.ts:445） · 消费: MemoryCore/src/gateway/config.ts:445 · 配错: 空=core 不校验鉴权（任何客户端可读写记忆）（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:TDAI_GATEWAY_CONFIG = ""   # 【建议】path default=none — 显式指定 gateway yaml 路径 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:841 · 配错: 值拼错时该功能静默失效或回落缺省
$env:TDAI_DATA_DIR = "D:/TDB/data"   # 【现役】 path default=D:/TDB/data — core 数据根（metadata/journal/yml 都在其下） · 本机现役: dataDir 单一真源（panel/core 同源锚）；改它=换整棵数据目录 · 消费: MemoryCore/src/gateway/config.ts:450 · 配错: 指错=读不到既有记忆，且可能在旧目录继续写
# $env:TDAI_CORS_ORIGINS = ""   # 【建议】list<str> default=none — 逗号分隔 CORS 白名单；空=不放行 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:990 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_DEPLOY_MODE = ""   # 【建议】enum(standalone,service) default=none — 部署形态；standalone 走本地凭据解析 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:628 · 配错: 值拼错时该功能静默失效或回落缺省
$env:MEMORY_LOG_LEVEL = "info"   # 【现役】 enum(debug,info,warn,error) default=debug — console 日志级别；产线设 info 收敛 journald · 本机现役: 本机现役=debug、代码缺省=debug；模板取 info 收敛 journald，排查时临时改 debug · 消费: MemoryCore/src/utils/env-config.ts:64 · 配错: 非法值回落 debug；产线 debug 刷爆 journald
# $env:MEMORY_MAX_BODY_BYTES = ""   # 【建议】int default=1048576 — 请求体上限；超限 413 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:79 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:STORE_MODE = ""   # 【建议】enum(sqlite,tcvdb) default=none — 强制存储后端；空=按能力自动选 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/server.ts:2476 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:STATE_BACKEND = ""   # 【建议】enum(redis,local) default=redis — 定时扫描器状态后端 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/services/timer-scanner.ts:257 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_TENCENTDB_ROOT = ""   # 【建议】path default=none — 旧版数据根兜底（~/.memory-tencentdb） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:872 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDB_INJECTION_GUARD_MODE = ""   # 【建议】enum(off,warn,block) default=none — 注入护栏档位；空=代码缺省档 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/injection-guard.ts:205 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：LLM 与记忆系统用户
# $env:TDAI_LLM_PROVIDER = ""   # 【建议】enum(openai,proxy) default=openai — openai 直连 / proxy 走记账 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:463 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_LLM_BASE_URL = ""   # 【建议】str default=https://api.openai.com/v1 — LLM baseUrl（含 /v1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:467 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_LLM_MODEL = ""   # 【建议】str default=gpt-4o — 缺省模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:471 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_LLM_MAX_TOKENS = ""   # 【建议】int default=4096 — 单次 completion 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:472 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_LLM_TIMEOUT_MS = ""   # 【建议】ms default=120000 — 单次 LLM 超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:473 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_LLM_STREAM = ""   # 【建议】bool default=false — 是否流式（只认 true） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:481 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_LLM_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 【已弃用 ADR-0006】凭据 SoT=admin settings；设了只告警 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:921 · 配错: 空/错=相关调用 401 或功能静默失效
$env:TDAI_MEMORY_SYSTEM_USER_ID = "usr-sys-memory-local"   # 【现役】 str default=none — 记忆系统用户 id（隔离主体） · 消费: MemoryCore/src/gateway/metadata-env.ts:38 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_MEMORY_SYSTEM_USER_KEY = "<REPLACE_ME: standalone 记忆系统用户 key>"   # 【现役·需填】 str default=none — 记忆系统用户 key（standalone 鉴权） · 本机现役: 空=standalone 路不启用该系统用户，写面降级 · 消费: MemoryCore/src/adapters/standalone/llm-provider-resolver.ts:54 · 配错: 空=standalone 系统用户路关闭，写面降级（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
$env:TDAI_MEMORY_SYSTEM_USER_NAME = "TDAI System"   # 【现役】 str default=none — 记忆系统用户显示名 · 消费: MemoryCore/src/gateway/metadata-env.ts:39 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：Redis / 扫描器 / COS / 向量库 / openclaw
# $env:REDIS_HOST = ""   # 【建议】str default=127.0.0.1 — Redis 主机 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:643 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:REDIS_PORT = ""   # 【建议】int default=6379 — Redis 端口 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:644 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:REDIS_PASSWORD = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Redis 密码 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:645 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:REDIS_DB = ""   # 【建议】int default=0 — Redis 库号 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:646 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:REDIS_KEY_PREFIX = ""   # 【建议】str default=tdai_memory_v2 — Redis key 前缀（多实例隔离） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:651 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:SHARK_BASE_URL = ""   # 【建议】str default=none — shark 调度服务基址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:657 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CONFIG_VDB_TTL_MS = ""   # 【建议】ms default=300000 — 实例 config 缓存 TTL · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:658 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:CONFIG_COS_BUFFER_MS = ""   # 【建议】ms default=120000 — COS 写入攒批窗口 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:659 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:CONFIG_MAX_INSTANCES = ""   # 【建议】int default=1000 — 实例数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:660 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:SCANNER_INSTANCES = ""   # 【建议】str default=default — 扫描实例名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:666 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:SCANNER_INSTANCES_SHARK_URL = ""   # 【建议】str default=none — 扫描实例 shark 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:667 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:SCANNER_INTERVAL_MS = ""   # 【建议】ms default=500 — 扫描周期 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:668 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:SCANNER_NODE_ID = ""   # 【建议】str default=none — 扫描节点 id · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:669 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:WORKER_POLL_MS = ""   # 【建议】ms default=200 — worker 轮询间隔 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:675 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:WORKER_CONCURRENCY = ""   # 【建议】int default=60 — worker 并发 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:676 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:COS_DOMAIN = ""   # 【建议】str default=none — COS 域名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:682 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_GENERATION_LOG_RETENTION_DAYS = ""   # 【建议】int default=none — COS 生成日志保留天数 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:683 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:COS_SECRET_ID = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — COS 临时密钥 id；空=不启用 COS · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:117 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:COS_SECRET_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — COS 临时密钥 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:122 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:COS_TOKEN = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — COS 临时 token · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:123 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:COS_BUCKET = ""   # 【建议】str default=none — COS bucket · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:154 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_REGION = ""   # 【建议】str default=ap-guangzhou — COS 地域 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:155 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_PREFIX = ""   # 【建议】str default=test_read_cos/ — COS 对象前缀 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:156 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_PATH_PREFIX = ""   # 【建议】str default=none — COS 路径前缀 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:124 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_URL = ""   # 【建议】str default=none — COS 访问域名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:120 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:VDB_ENDPOINT = ""   # 【建议】str default=none — 向量库端点；空=不做向量召回 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:97 · 配错: 非空但不可达=召回超时（实测 144 次里 77 次 504）
# $env:VDB_USER = ""   # 【建议】str default=root — 向量库用户 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:98 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:VDB_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 向量库 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:99 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:VDB_DATABASE = ""   # 【建议】str default=default — 向量库库名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:100 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:VDB_CA_PEM_PATH = ""   # 【建议】path default=none — tcvdb TLS CA 证书路径 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/store/store-pool.ts:345 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LOG_PATH = ""   # 【建议】path default=/data/log/ — 旧版文件日志目录（容器内路径） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/log.ts:24 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OPENCLAW_ROOT = ""   # 【建议】path default=none — openclaw 根目录覆盖 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/clean-context-runner.ts:118 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OPENCLAW_CONFIG_PATH = ""   # 【建议】path default=none — openclaw 配置路径覆盖 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/ensure-hook-policy.ts:144 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OPENCLAW_STATE_DIR = ""   # 【建议】path default=none — openclaw state 目录覆盖 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/ensure-hook-policy.ts:148 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：metadata / 鉴权 / skill / 精排
# $env:TDAI_METADATA_MAX_USERS = ""   # 【建议】int default=none — 单实例用户数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:762 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_MAX_TEAMS = ""   # 【建议】int default=none — 单实例团队数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:766 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_CONFIG_PARAMS_FILE = ""   # 【建议】path default=none — metadata 配置参数文件 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:769 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_METADATA_MONGO_URI = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Mongo 连接串（yaml 注入 env） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:23 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:TDAI_METADATA_MONGO_DB_PREFIX = ""   # 【建议】str default=none — Mongo 库名前缀 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:24 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_METADATA_MONGO_TRANSACTIONS = ""   # 【建议】bool default=none — Mongo 事务开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:25 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_METADATA_STORE_CACHE_MAX = ""   # 【建议】int default=none — metadata store 缓存实例上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:30 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_SQLITE_BASE_DIR = ""   # 【建议】path default=none — metadata sqlite 目录（e2e） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/chat-memory-e2e-helpers.ts:33 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_REQUIRE_USER_BINDING = ""   # 【建议】str default=none — 要求 user_key 绑定（true 开） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:202 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = ""   # 【建议】str default=none — 未知主体处置策略 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:210 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_ADMIN_BYPASS_ENABLED = ""   # 【建议】str default=none — admin 旁路开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:218 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP = ""   # 【建议】str default=none — 要求团队归属校验 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:230 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_TEAM_OWNERSHIP_WHITELIST = ""   # 【建议】str default=none — 团队归属白名单（逗号分隔） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:238 · 配错: 值拼错时该功能静默失效或回落缺省
# 【建议·默认姿态就是「开」】不设 = 开；只有确认要放宽时才取消下面这行注释
# $env:V3_STRICT_ISOLATION = "0"   # 只认 0/false/off/no 为关；未知取值 fail-secure 按开（env-config.ts:184/:187/:189）
   # 【建议】bool default=on — v3 严格隔离（越权即 403） · 消费: MemoryCore/src/utils/env-config.ts:187 · 配错: 误设 0/false/off/no=主动降级严格隔离（缺省即开、未知值按开）
# $env:TDAI_API_TRACE_ENABLED = ""   # 【建议】bool default=false — API 追踪日志 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:166 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_SKILL_ENABLED = ""   # 【建议】bool default=none — 一行强制开启 skill 层 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:616 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_SKILL_WORKER_CONCURRENCY = ""   # 【建议】int default=none — skill worker 并发 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/skill/skill-config.ts:186 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_USER_KEY_MAX_ACTIVE = ""   # 【建议】int default=none — 单主体有效 user_key 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/metadata/service/metadata-service.ts:805 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_THREADS = ""   # 【建议】int default=0 — 精排 onnx 线程数；0=引擎缺省 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/recall/rerank/rerank-worker.mjs:23 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_DOC_CAP = ""   # 【建议】int default=0 — 精排前文档截断字符；0=不截 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/recall/rerank/rerank-worker.mjs:24 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_SCORE_DUMP = ""   # 【建议】path default=none — 精排打分落盘（bench/调试） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/hooks/auto-recall.ts:928 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：观测（OTel / ClickHouse / Kafka / Langfuse / Opik）
# $env:TDAI_OTEL_ENABLED = ""   # 【建议】bool default=false — OTel SDK 总开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:699 · 配错: 只认字符串 true；写 True/1 视为关
# $env:OTEL_EXPORTER_OTLP_ENDPOINT = ""   # 【建议】str default=http://localhost:4317 — OTLP collector 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:700 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OTEL_EXPORTER_OTLP_PROTOCOL = ""   # 【建议】enum(grpc,http/protobuf) default=grpc — OTLP 协议 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:701 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OTEL_SERVICE_NAME = ""   # 【建议】str default=core — service.name 资源属性 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:702 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OTEL_TENANT_ID = ""   # 【建议】str default=none — tps.tenant.id 资源属性 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:704 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OTEL_LOG_EXPORT_INTERVAL = ""   # 【建议】ms default=5 — 日志导出间隔 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:705 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:OTEL_LOG_LEVEL = ""   # 【建议】enum(DEBUG) default=none — 设 DEBUG 打开 CH 调试日志 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/clickhouse-exporter.ts:225 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OTEL_EXPORTER_OTLP_HEADERS = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — OTLP 鉴权头（k=v,k=v） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/otel-sdk-init.ts:388 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:OTEL_RESOURCE_ATTRIBUTES = ""   # 【建议】str default=none — 额外 resource 属性 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/otel-sdk-init.ts:400 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_INSTANCE_ID = ""   # 【建议】str default=none — 实例标识 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/otel-sdk-init.ts:152 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CLICKHOUSE_ENABLED = ""   # 【建议】bool default=false — CH 埋点开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:713 · 配错: 只认字符串 true；写 True/1 视为关
# $env:CLICKHOUSE_ENDPOINT = ""   # 【建议】str default=none — CH HTTP 端点 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:714 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CLICKHOUSE_USERNAME = ""   # 【建议】str default=default — CH 用户 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:715 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CLICKHOUSE_PASSWORD = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — CH 密码 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:716 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:CLICKHOUSE_DATABASE = ""   # 【建议】str default=tdai_eval — CH 库名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:717 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CLICKHOUSE_HTTP_ENDPOINT = ""   # 【建议】str default=http://localhost:8123 — CH 端点（导出器缺省） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/clickhouse-exporter.ts:181 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CLICKHOUSE_USER = ""   # 【建议】str default=default — CH 用户（导出器缺省） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/clickhouse-exporter.ts:184 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KAFKA_METRIC_ENABLED = ""   # 【建议】bool default=none — 指标 Kafka 开关（配 brokers 即开） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:727 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KAFKA_METRIC_BROKERS = ""   # 【建议】str default=none — Kafka brokers（逗号分隔） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:723 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KAFKA_METRIC_TOPIC = ""   # 【建议】str default=memory_monitor — 指标 topic · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:724 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LANGFUSE_ENABLED = ""   # 【建议】bool default=false — Langfuse 开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:735 · 配错: 只认字符串 true；写 True/1 视为关
# $env:LANGFUSE_HOST = ""   # 【建议】str default=none — Langfuse 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:736 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LANGFUSE_PUBLIC_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Langfuse 公钥 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:737 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:LANGFUSE_SECRET_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Langfuse 私钥 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:738 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:OPIK_ENABLED = ""   # 【建议】bool default=false — Opik 追踪开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/offload_server/opik-tracer.ts:74 · 配错: 只认字符串 true；写 True/1 视为关
# $env:OPIK_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Opik key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/offload_server/opik-tracer.ts:81 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:OPIK_URL_OVERRIDE = ""   # 【建议】str default=none — Opik 地址覆盖 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/offload_server/opik-tracer.ts:80 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OPIK_PROJECT_NAME = ""   # 【建议】str default=openclaw-offload-server — Opik project 名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/offload_server/opik-tracer.ts:83 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:OPIK_WORKSPACE = ""   # 【建议】str default=default — Opik workspace · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/offload_server/opik-tracer.ts:82 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryKnowledge（8421）
# 【建议·按服务分块】同名不同值：一份 dot-source 只能给一个值，而这两个服务端口必须不同
#   MemoryPanel    (8123): $env:PORT = "8123"     # 本机未设，走代码缺省 8123（panel-config.ts:66）
#   MemoryKnowledge(8421): $env:PORT = "8421"     # 本机未设，走代码缺省 8421
   # 【建议】int default=none — HTTP 端口（Knowledge 8421 / Panel 8123，两服务分别设） · 消费: MemoryPanel/src/panel/config/panel-config.ts:66 · 配错: 与其他服务撞端口=后启动的进程起不来
# $env:API_PREFIX = ""   # 【建议】str default=/v3 — 路由前缀 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:209 · 配错: 值拼错时该功能静默失效或回落缺省
# 【建议·按服务分块】Panel 现役日志级别由它决定；本机未设，走代码缺省 info
#   MemoryPanel: $env:LOG_LEVEL = "info"      # 排查时临时改 debug（panel-config.ts:61）
   # 【建议】enum(info|debug|warn|error) default=info — 日志级别（Knowledge debug / Panel info） · 消费: MemoryPanel/src/panel/config/panel-config.ts:61 · 配错: 非法值被静默翻成 info
# $env:KNOWLEDGE_PUBLIC_BASE_URL = ""   # 【建议】str default=none — 对外公布基址（生成 service_url） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:210 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_DATA_DIR = ""   # 【建议】path default=./data — 知识资产根目录（相对进程 cwd） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:206 · 配错: 指错=知识库读空/重建
# $env:KNOWLEDGE_DB_PATH = ""   # 【建议】path default=./data/knowledge.db — SQLite 主库路径 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:207 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_SERVICE_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 服务间共享密钥；空=/v3 全放行 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:218 · 配错: 空=/v3 全放行；与 core 不一致=跨进程 401
# $env:KNOWLEDGE_API_URL = ""   # 【建议】str default=http://localhost:8421 — MCP 转发的 knowledge 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/mcp/server.ts:94 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_API_TOKEN = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — MCP 转发 Bearer（=SERVICE_KEY 同值） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/mcp/server.ts:95 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:TMC_CALLBACK_URL = ""   # 【建议】str default=none — 管控回调根地址；空=跳过 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:211 · 配错: 值拼错时该功能静默失效或回落缺省
$env:KNOWLEDGE_RERANK_URL = "http://127.0.0.1:8420/v1/rerank"   # 【现役】 str default=none — core /v1/rerank URL；空=关重排 · 本机现役: 置空即整体关闭 wiki 召回重排（config-first 缺省关，此处为部署级显式开启） · 消费: MemoryKnowledge/src/config.ts:213 · 配错: 错=重排整段超时（800ms 预算），召回变慢
# $env:KNOWLEDGE_RERANK_API_KEY = $env:TDAI_GATEWAY_API_KEY   # 【现役·需填】 str default=none — 调 rerank 的 Bearer（=网关 key） · 本机现役: Bearer 用网关同 key · 消费: MemoryKnowledge/src/config.ts:214 · 配错: 空/错=相关调用 401 或功能静默失效（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:KNOWLEDGE_RERANK_TIMEOUT_MS = ""   # 【建议】ms default=800 — 单次重排超时（clamp 100~30000） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:215 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_MODE = ""   # 【建议】enum(proxy,custom) default=proxy — ingest 用哪条 LLM 通道 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:220 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_PROTOCOL = ""   # 【建议】enum(openai,anthropic) default=openai — 上游协议 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:221 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_PROVIDER = ""   # 【建议】str default=custom — 供应商标签（仅展示） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:222 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_API_KEY = $env:TDAI_LLM_API_KEY   # 【现役·需填】 str default=none — custom 模式上游 key · 本机现役: Knowledge 只读这个名；值同 TDAI_LLM_API_KEY（dotenv 不会覆盖已存在的进程值） · 消费: MemoryKnowledge/src/config.ts:223 · 配错: 空/错=相关调用 401 或功能静默失效（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:LLM_MODEL = ""   # 【建议】str default=Memory-Model — 缺省模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:224 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_BASE_URL = ""   # 【建议】str default=none — 上游 baseUrl（含 /v1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:225 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_MAX_TOKENS = ""   # 【建议】int default=32768 — 单次 completion 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:226 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_TIMEOUT_MS = ""   # 【建议】ms default=1200000 — 单次 LLM 超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:227 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_STREAM = ""   # 【建议】bool default=false — 是否流式（只认 true） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:228 · 配错: 只认字符串 true；写 True/1 视为关
# $env:EMBEDDING_PROVIDER = ""   # 【建议】str default=openai_compatible — 向量协议标签 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:231 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_BASE_URL = ""   # 【建议】str default=none — 向量服务 baseUrl；空=不启用 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:232 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 向量服务 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:233 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:EMBEDDING_MODEL = ""   # 【建议】str default=none — 向量模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:234 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_DIMENSIONS = ""   # 【建议】int default=0 — 向量维度；0=不启用 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:235 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_WIKI_POOL_MAX = ""   # 【建议】int default=300 — wiki 索引只读连接池上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/engines/wiki/index-db.ts:35 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_WIKI_INGEST_CONCURRENCY = ""   # 【建议】int default=3 — 单 wiki 抽取并发（clamp 1~10） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:151 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_LLM_GLOBAL_CONCURRENCY = ""   # 【建议】int default=5 — 全局 LLM 并发（clamp 1~20） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:160 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_AUTO_SYNC_ENABLED = ""   # 【建议】bool default=false — 自动同步开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:53 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN = ""   # 【建议】float default=10 — 扫描周期（分钟，clamp 1~1440） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:54 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT = ""   # 【建议】int default=3 — 同时同步仓库数 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:55 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_SSRF_CHECK = ""   # 【建议】bool default=true — SSRF 私网黑名单（off 可关） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/source-fetcher/git-fetcher.ts:39 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_CLICKHOUSE_ENABLED = ""   # 【建议】bool default=false — Knowledge 侧 CH 埋点开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:191 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_CLICKHOUSE_URL = ""   # 【建议】str default=none — CH HTTP 端点 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:172 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_DATABASE = ""   # 【建议】str default=default — CH 库名（标识符校验） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:178 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_TABLE = ""   # 【建议】str default=tool_call_logs — CH 表名（标识符校验） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:179 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_USER = ""   # 【建议】str default=default — CH 用户 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:195 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_PASSWORD = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — CH 密码 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:196 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS = ""   # 【建议】ms default=5000 — 攒批 flush 间隔（>=100） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:180 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD = ""   # 【建议】int default=50 — 攒够行数 flush（>=1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:181 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_TTL_DAYS = ""   # 【建议】int default=90 — 埋点表 TTL（天） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:182 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS = ""   # 【建议】ms default=5000 — 单次 CH 写入超时（>=100） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:183 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭

# ── MemoryKnowledge：观测
# $env:LANGFUSE_BASE_URL = ""   # 【建议】str default=https://cloud.langfuse.com — Knowledge 侧 Langfuse 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/telemetry.ts:44 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryProxy（8096）
# $env:PROXY_DATA_DIR = ""   # 【建议】path default=none — proxy 资产根（覆盖 storage.fs.fsRoot） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/injection/index.ts:236 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:PROXY_DB_PATH = ""   # 【建议】path default=none — proxy sqlite 路径（缺省 ~/.tdai-memory-proxy/proxy.db） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/db/index.ts:32 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CC_FORM_MODE = ""   # 【建议】enum(tool,text) default=tool — CC 表单下发形态（实验） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/session/form.ts:405 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_KNOWLEDGE_CACHE_TTL_MS = ""   # 【建议】ms default=none — knowledge 结果缓存 TTL；0=关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/knowledge/core-client.ts:29 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_PROXY_ADMIN_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — proxy admin 鉴权 key（代码侧 env 覆盖名） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/config.ts:716 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:PROXY_ADMIN_API_KEY = "admin"   # 【现役】 str default=none — proxy yaml 里的运行时展开名（与上条同值；由 New-TdbRuntimeConfig 渲染） · 本机现役: 经 MemoryProxy/config.yaml 的 ${VAR} 展开生效；代码侧覆盖名是 TDAI_PROXY_ADMIN_API_KEY（config.ts:716）。本机现役值就是 admin，对外暴露前必须换 · 消费: MemoryProxy/config.yaml:395 · 配错: 与 TDAI_PROXY_ADMIN_API_KEY 不一致时以 env 为准，yaml 侧静默失效（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:TDAI_TASK_DRAFT_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — task 草稿上游 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/config.ts:736 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS = ""   # 【建议】ms default=none — 首轮草稿超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/mem-command/task-draft-generator.ts:127 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:PROXY_DEBUG_DUMP_BODY = ""   # 【建议】path default=none — 出站 body 落盘目录（调试） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/handler.ts:344 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:PROXY_DEBUG_DUMP_INBOUND = ""   # 【建议】path default=none — 入站请求落盘目录（调试） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/handler.ts:545 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:PROXY_DEBUG_DUMP_OUTBOUND_MD5 = ""   # 【建议】path default=none — 出站 md5 落盘目录（调试） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/handler.ts:360 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:PROXY_DEBUG_ASSET_REFLECTION = ""   # 【建议】bool default=none — 资产反射调试日志 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/injection/injectors/asset-reflection-injector.ts:94 · 配错: 只认字符串 true；写 True/1 视为关
# $env:OTEL_BSP_MAX_QUEUE_SIZE = ""   # 【建议】int default=none — Langfuse 批处理队列上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/src/langfuse.ts:58 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_WIKI_SYSTEM_USER_ID = ""   # 【建议】str default=none — wiki 系统用户 id（yaml 占位） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/config.yaml:411 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_WIKI_SYSTEM_USER_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — wiki 系统用户 key（yaml 占位） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/config.yaml:413 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:TDAI_WIKI_SYSTEM_USER_NAME = ""   # 【建议】str default=none — wiki 系统用户显示名（yaml 占位） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryProxy/config.yaml:412 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryPanel（8123）
# $env:HOST = ""   # 【建议】str default=0.0.0.0 — Panel 监听地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:65 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LOG_FORMAT = ""   # 【建议】enum(json,pretty) default=json — Panel 日志格式 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:62 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:METADATA_INSTANCES_CONFIG = ""   # 【建议】path default=./config/metadata-instances.json — 实例清单文件（必填，否则实例列表空） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:68 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:METADATA_REMOTE_TIMEOUT_MS = ""   # 【建议】ms default=15000 — 元数据远端超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:69 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:UI_DIST_DIR = ""   # 【建议】path default=./web/dist — 前端静态目录 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:70 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_SERVICE_URL = ""   # 【建议】str default=http://127.0.0.1:8421 — Knowledge 服务地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:76 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_AUTH_TOKEN = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Knowledge 服务 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:77 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:KNOWLEDGE_TIMEOUT_MS = ""   # 【建议】ms default=15000 — Knowledge 调用超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:78 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_LLM_BINDING_SYNC = ""   # 【建议】bool default=true — 启动时确保实例 LLM 绑定 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:81 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_LLM_PROXY_BASE_URL = ""   # 【建议】str default=http://127.0.0.1:8096 — 绑定用 proxy 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:82 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_AGENT_TEMPLATE_DIR = ""   # 【建议】path default=./data/agent-templates — Agent 模板本地目录 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:84 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_PROVIDER_PROXY_BASE_URL = ""   # 【建议】str default=http://127.0.0.1:8096 — LLM Provider 透传根地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:86 · 配错: 值拼错时该功能静默失效或回落缺省
$env:TDAI_RECALL_JOURNAL_DIR = "D:/TDB/data/logs/recall"   # 【现役】 path default=none — 召回 journal 目录（覆盖 TDAI_DATA_DIR 推导） · 本机现役: 不设则由 TDAI_DATA_DIR 派生（Panel BFF 直读） · 消费: MemoryPanel/src/panel/http/routes/chat-memory.ts:64 · 配错: 值拼错时该功能静默失效或回落缺省

# ── dsh-plugin（宿主内运行，不需要单独进程）
# $env:DSH_HOME = ""   # 【建议】path default=none — DSH 家目录（outbox 死信落点）；宿主决定 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: dsh-plugin/src/outbox.ts:96 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_DSH_USER_KEY = "admin"   # 【现役·本机】 str default=none — DSH 客户端 user_key（本机当 x-tdai-user-key 头发给 core）；仓库内 0 个字面读点：插件按 server.userKeyRef 泛化解析（dsh-plugin/src/index.ts:300，缺省 ref=TDAI_USER_KEY，dsh-plugin/src/config.ts:334），插件路径不读本文件：身份取自 ~/.dsh/.credentials.yaml 的 refs.TDAI_USER_KEY / refs.TDAI_GATEWAY_APIKEY（credentials ref 解析，桌面 patch 只写 apiKeyRef 不写 userKeyRef），本变量只对 ops 脚本有意义；故登记在此但排除出 EnvKeys/keys.json（见 env.keys.json.ignored）
