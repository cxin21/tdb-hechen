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
# 关于 proxy：MemoryProxy（8096）已按 ADR-0020 整包退场（模板与源码包同步删除）；本文件不再含 PROXY_* 变量，原 proxy-config 运行时渲染机制一并作废。
#
# 维护纪律：键与 config/templates/env.keys.json 一一对应，改一边必须改另一边（scripts/check-config-templates.mjs 会核）。

param([switch]$ListKeys)

$ErrorActionPreference = "Stop"
$script:EnvKeys = @('TDAI_GATEWAY_PORT', 'TDAI_GATEWAY_HOST', 'TDAI_GATEWAY_APIKEY', 'TDAI_GATEWAY_API_KEY', 'TDAI_GATEWAY_CONFIG', 'TDAI_DATA_DIR', 'TDAI_CORS_ORIGINS', 'TDAI_DEPLOY_MODE', 'MEMORY_LOG_LEVEL', 'MEMORY_MAX_BODY_BYTES', 'STORE_MODE', 'STATE_BACKEND', 'MEMORY_TENCENTDB_ROOT', 'TDB_INJECTION_GUARD_MODE', 'TDAI_LLM_BASE_URL', 'TDAI_LLM_MODEL', 'TDAI_LLM_MAX_TOKENS', 'TDAI_LLM_TIMEOUT_MS', 'TDAI_LLM_STREAM', 'TDAI_LLM_API_KEY', 'TDAI_MEMORY_SYSTEM_USER_ID', 'TDAI_MEMORY_SYSTEM_USER_KEY', 'TDAI_MEMORY_SYSTEM_USER_NAME', 'SHARK_BASE_URL', 'CONFIG_VDB_TTL_MS', 'CONFIG_COS_BUFFER_MS', 'CONFIG_MAX_INSTANCES', 'SCANNER_INSTANCES', 'SCANNER_INSTANCES_SHARK_URL', 'SCANNER_INTERVAL_MS', 'SCANNER_NODE_ID', 'WORKER_POLL_MS', 'WORKER_CONCURRENCY', 'COS_DOMAIN', 'COS_GENERATION_LOG_RETENTION_DAYS', 'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_TOKEN', 'COS_BUCKET', 'COS_REGION', 'COS_PREFIX', 'COS_PATH_PREFIX', 'COS_URL', 'VDB_ENDPOINT', 'VDB_USER', 'VDB_API_KEY', 'VDB_DATABASE', 'LOG_PATH', 'TDAI_METADATA_MAX_USERS', 'TDAI_METADATA_MAX_TEAMS', 'TDAI_METADATA_CONFIG_PARAMS_FILE', 'TDAI_METADATA_MONGO_URI', 'TDAI_METADATA_MONGO_DB_PREFIX', 'TDAI_METADATA_STORE_CACHE_MAX', 'TDAI_METADATA_SQLITE_BASE_DIR', 'MEMORY_AUTH_REQUIRE_USER_BINDING', 'MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY', 'MEMORY_AUTH_ADMIN_BYPASS_ENABLED', 'MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP', 'MEMORY_AUTH_TEAM_OWNERSHIP_WHITELIST', 'V3_STRICT_ISOLATION', 'TDAI_API_TRACE_ENABLED', 'TDAI_SKILL_ENABLED', 'TDAI_SKILL_WORKER_CONCURRENCY', 'TDAI_USER_KEY_MAX_ACTIVE', 'RERANK_THREADS', 'RERANK_DOC_CAP', 'RERANK_SCORE_DUMP', 'TDAI_INSTANCE_ID', 'LANGFUSE_SECRET_KEY', 'PORT', 'API_PREFIX', 'LOG_LEVEL', 'KNOWLEDGE_PUBLIC_BASE_URL', 'KNOWLEDGE_DATA_DIR', 'KNOWLEDGE_DB_PATH', 'KNOWLEDGE_SERVICE_KEY', 'TMC_CALLBACK_URL', 'KNOWLEDGE_RERANK_URL', 'KNOWLEDGE_RERANK_API_KEY', 'KNOWLEDGE_RERANK_TIMEOUT_MS', 'LLM_MODE', 'LLM_PROTOCOL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS', 'LLM_STREAM', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'KNOWLEDGE_WIKI_POOL_MAX', 'KNOWLEDGE_WIKI_INGEST_CONCURRENCY', 'KNOWLEDGE_LLM_GLOBAL_CONCURRENCY', 'KNOWLEDGE_AUTO_SYNC_ENABLED', 'KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN', 'KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT', 'KNOWLEDGE_SSRF_CHECK', 'KNOWLEDGE_CLICKHOUSE_ENABLED', 'KNOWLEDGE_CLICKHOUSE_URL', 'KNOWLEDGE_CLICKHOUSE_DATABASE', 'KNOWLEDGE_CLICKHOUSE_TABLE', 'KNOWLEDGE_CLICKHOUSE_USER', 'KNOWLEDGE_CLICKHOUSE_PASSWORD', 'KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS', 'KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD', 'KNOWLEDGE_CLICKHOUSE_TTL_DAYS', 'KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS', 'LANGFUSE_BASE_URL', 'HOST', 'LOG_FORMAT', 'METADATA_INSTANCES_CONFIG', 'METADATA_REMOTE_TIMEOUT_MS', 'UI_DIST_DIR', 'KNOWLEDGE_SERVICE_URL', 'KNOWLEDGE_AUTH_TOKEN', 'KNOWLEDGE_TIMEOUT_MS', 'TDAI_AGENT_TEMPLATE_DIR', 'TDAI_RECALL_JOURNAL_DIR', 'DSH_HOME')
if ($ListKeys) {
  foreach ($n in $script:EnvKeys) {
    $v = [Environment]::GetEnvironmentVariable($n)
    $state = if ([string]::IsNullOrEmpty($v)) { "unset" } else { "SET" }
    Write-Output ($n.PadRight(42) + " " + $state)
  }
  return
}

# ── MemoryCore：进程与服务
# $env:TDAI_GATEWAY_PORT = ""   # 【建议】int default=8420 — core HTTP 监听端口 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:255 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_GATEWAY_HOST = ""   # 【建议】str default=127.0.0.1 — 监听地址；对外服务改 0.0.0.0 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:256 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_GATEWAY_APIKEY = $env:TDAI_GATEWAY_API_KEY   # 【现役·需填】 str default=none — 网关 Bearer（core/panel/knowledge 同源）；空=不校验 · 本机现役: core 优先读本键（无下划线），兼容存量 TDAI_GATEWAY_API_KEY，双名同设时本键优先 · 消费: MemoryCore/src/gateway/config.ts:266 · 配错: 本键与 TDAI_GATEWAY_API_KEY 设成不同值 → 用旧名的调用方（如 dsh-plugin 客户端）401；空=core 不校验鉴权（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:TDAI_GATEWAY_API_KEY = "<REPLACE_ME: 从凭据库取真值>"   # 【现役·需填】 str default=none — 网关 Bearer 的存量别名；同设时无下划线优先 · 本机现役: core 端鉴权读这一对：TDAI_GATEWAY_APIKEY 优先、本键兜底（同一行 config.ts:445） · 消费: MemoryCore/src/gateway/config.ts:266 · 配错: 空=core 不校验鉴权（任何客户端可读写记忆）（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:TDAI_GATEWAY_CONFIG = ""   # 【建议】path default=none — 显式指定 gateway yaml 路径 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:620 · 配错: 值拼错时该功能静默失效或回落缺省
$env:TDAI_DATA_DIR = "D:/TDB/data"   # 【现役】 path default=D:/TDB/data — core 数据根（metadata/journal/yml 都在其下） · 本机现役: dataDir 单一真源（panel/core 同源锚）；改它=换整棵数据目录 · 消费: MemoryCore/src/gateway/config.ts:450 · 配错: 指错=读不到既有记忆，且可能在旧目录继续写
# $env:TDAI_CORS_ORIGINS = ""   # 【建议】list<str> default=none — 逗号分隔 CORS 白名单；空=不放行 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:769 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_DEPLOY_MODE = ""   # 【建议】enum(standalone) default=none — 部署形态；Wave 2 后只剩 standalone（service 档整组退场：Redis 状态后端/TCVDB/Mongo 已删，写非 standalone 启动即抛错，docs/adr/0021） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:440 · 配错: 值拼错时该功能静默失效或回落缺省
$env:MEMORY_LOG_LEVEL = "info"   # 【现役】 enum(debug,info,warn,error) default=debug — console 日志级别；产线设 info 收敛 journald · 本机现役: 本机现役=debug、代码缺省=debug；模板取 info 收敛 journald，排查时临时改 debug · 消费: MemoryCore/src/utils/env-config.ts:64 · 配错: 非法值回落 debug；产线 debug 刷爆 journald
# $env:MEMORY_MAX_BODY_BYTES = ""   # 【建议】int default=1048576 — 请求体上限；超限 413 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:79 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:STORE_MODE = ""   # 【建议】enum(sqlite) default=none — 强制存储后端；Wave 3 后只剩 sqlite（tcvdb 后端整组退场，写 tcvdb 启动即抛 RetiredStoreBackendError，docs/adr/0021） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/server.ts:2026 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:STATE_BACKEND = ""   # 【建议】enum(local) default=none — 定时扫描器状态后端；Wave 2 后只剩 local（redis 状态后端退场，写非 local 启动即抛错，docs/adr/0021） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:451 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_TENCENTDB_ROOT = ""   # 【建议】path default=none — 数据目录根（历史命名保留）：new= {root}/memory-tdai，缺省 ~/.memory-tencentdb；legacy ~/memory-tdai 有数据时仍优先并打 DEPRECATED · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:651 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDB_INJECTION_GUARD_MODE = ""   # 【建议】enum(off,warn,block) default=none — 注入护栏档位；空=代码缺省档 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/injection-guard.ts:205 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：LLM 与记忆系统用户
# $env:TDAI_LLM_BASE_URL = ""   # 【建议】str default=https://api.openai.com/v1 — LLM baseUrl（含 /v1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:286 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_LLM_MODEL = ""   # 【建议】str default=gpt-4o — 缺省模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:290 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_LLM_MAX_TOKENS = ""   # 【建议】int default=4096 — 单次 completion 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:291 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_LLM_TIMEOUT_MS = ""   # 【建议】ms default=120000 — 单次 LLM 超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:292 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_LLM_STREAM = ""   # 【建议】bool default=false — 是否流式（只认 true） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:297 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_LLM_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 【已弃用 ADR-0006】凭据 SoT=admin settings；设了只告警 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:700 · 配错: 空/错=相关调用 401 或功能静默失效
$env:TDAI_MEMORY_SYSTEM_USER_ID = "usr-sys-memory-local"   # 【现役】 str default=none — 记忆系统用户 id（隔离主体） · 消费: MemoryCore/src/gateway/metadata-env.ts:38 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_MEMORY_SYSTEM_USER_KEY = "<REPLACE_ME: standalone 记忆系统用户 key>"   # 【现役·需填】 str default=none — 记忆系统用户 key（standalone 鉴权） · 本机现役: 空=standalone 路不启用该系统用户，写面降级 · 消费: MemoryCore/src/metadata/system-user.ts:48 · 配错: 空=standalone 系统用户路关闭，写面降级（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
$env:TDAI_MEMORY_SYSTEM_USER_NAME = "TDAI System"   # 【现役】 str default=none — 记忆系统用户显示名 · 消费: MemoryCore/src/gateway/metadata-env.ts:39 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：扫描器 / COS / 向量库
# $env:SHARK_BASE_URL = ""   # 【建议】str default=none — shark 调度服务基址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:467 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:CONFIG_VDB_TTL_MS = ""   # 【建议】ms default=300000 — 实例 config 缓存 TTL · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:468 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:CONFIG_COS_BUFFER_MS = ""   # 【建议】ms default=120000 — COS 写入攒批窗口 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:469 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:CONFIG_MAX_INSTANCES = ""   # 【建议】int default=1000 — 实例数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:470 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:SCANNER_INSTANCES = ""   # 【建议】str default=default — 扫描实例名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:476 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:SCANNER_INSTANCES_SHARK_URL = ""   # 【建议】str default=none — 扫描实例 shark 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:477 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:SCANNER_INTERVAL_MS = ""   # 【建议】ms default=500 — 扫描周期 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:478 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:SCANNER_NODE_ID = ""   # 【建议】str default=none — 扫描节点 id · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:479 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:WORKER_POLL_MS = ""   # 【建议】ms default=200 — worker 轮询间隔 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:485 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:WORKER_CONCURRENCY = ""   # 【建议】int default=60 — worker 并发 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:486 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:COS_DOMAIN = ""   # 【建议】str default=none — COS 域名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:492 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:COS_GENERATION_LOG_RETENTION_DAYS = ""   # 【建议】int default=none — COS 生成日志保留天数 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:493 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
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
# $env:LOG_PATH = ""   # 【建议】path default=/data/log/ — 旧版文件日志目录（容器内路径） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/report/log.ts:24 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：metadata / 鉴权 / skill / 精排
# $env:TDAI_METADATA_MAX_USERS = ""   # 【建议】int default=none — 单实例用户数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:563 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_MAX_TEAMS = ""   # 【建议】int default=none — 单实例团队数上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:567 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_CONFIG_PARAMS_FILE = ""   # 【建议】path default=none — metadata 配置参数文件 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:570 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_METADATA_MONGO_URI = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Mongo 连接串（Mongo 元数据后端已退场：设成非空即启动抛 RetiredMetadataBackendError，docs/adr/0021） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/metadata/store/factory.ts:61 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:TDAI_METADATA_MONGO_DB_PREFIX = ""   # 【建议】str default=none — 库/目录名前缀（不再涉及 Mongo 后端，仅决定 {prefix}_{instance_id} 命名） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:23 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_METADATA_STORE_CACHE_MAX = ""   # 【建议】int default=none — metadata store 缓存实例上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/metadata-env.ts:26 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_METADATA_SQLITE_BASE_DIR = ""   # 【建议】path default=none — metadata sqlite 目录（e2e） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/scripts/start-e2e-gateway.ts:21 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_REQUIRE_USER_BINDING = ""   # 【建议】str default=none — 要求 user_key 绑定（true 开） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:202 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_UNKNOWN_PRINCIPAL_POLICY = ""   # 【建议】str default=none — 未知主体处置策略 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:210 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_ADMIN_BYPASS_ENABLED = ""   # 【建议】str default=none — admin 旁路开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:218 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_REQUIRE_TEAM_OWNERSHIP = ""   # 【建议】str default=none — 要求团队归属校验 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:230 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:MEMORY_AUTH_TEAM_OWNERSHIP_WHITELIST = ""   # 【建议】str default=none — 团队归属白名单（逗号分隔） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:238 · 配错: 值拼错时该功能静默失效或回落缺省
# 【建议·默认姿态就是「开」】不设 = 开；只有确认要放宽时才取消下面这行注释
# $env:V3_STRICT_ISOLATION = "0"   # 只认 0/false/off/no 为关；未知取值 fail-secure 按开（env-config.ts:184/:187/:189）
   # 【建议】bool default=on — v3 严格隔离（越权即 403） · 消费: MemoryCore/src/utils/env-config.ts:187 · 配错: 误设 0/false/off/no=主动降级严格隔离（缺省即开、未知值按开）
# $env:TDAI_API_TRACE_ENABLED = ""   # 【建议】bool default=false — API 追踪日志 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/utils/env-config.ts:166 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_SKILL_ENABLED = ""   # 【建议】bool default=none — 一行强制开启 skill 层 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:426 · 配错: 只认字符串 true；写 True/1 视为关
# $env:TDAI_SKILL_WORKER_CONCURRENCY = ""   # 【建议】int default=none — skill worker 并发 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/skill/skill-config.ts:172 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_USER_KEY_MAX_ACTIVE = ""   # 【建议】int default=none — 单主体有效 user_key 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/metadata/service/metadata-service.ts:805 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_THREADS = ""   # 【建议】int default=0 — 精排 onnx 线程数；0=引擎缺省 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/recall/rerank/rerank-worker.mjs:23 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_DOC_CAP = ""   # 【建议】int default=0 — 精排前文档截断字符；0=不截 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/recall/rerank/rerank-worker.mjs:24 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:RERANK_SCORE_DUMP = ""   # 【建议】path default=none — 精排打分落盘（bench/调试） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/core/hooks/auto-recall.ts:928 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryCore：观测（OTel / ClickHouse / Kafka 已退场，只剩 Langfuse 私钥）
# $env:TDAI_INSTANCE_ID = ""   # 【建议】str default=none — 实例标识 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryCore/src/gateway/config.ts:462 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LANGFUSE_SECRET_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Langfuse 私钥 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/telemetry.ts:28 · 配错: 空/错=相关调用 401 或功能静默失效

# ── MemoryKnowledge（8421）
# 【建议·按服务分块】同名不同值：一份 dot-source 只能给一个值，而这两个服务端口必须不同
#   MemoryPanel    (8123): $env:PORT = "8123"     # 本机未设，走代码缺省 8123（panel-config.ts:66）
#   MemoryKnowledge(8421): $env:PORT = "8421"     # 本机未设，走代码缺省 8421
   # 【建议】int default=none — HTTP 端口（Knowledge 8421 / Panel 8123，两服务分别设） · 消费: MemoryPanel/src/panel/config/panel-config.ts:66 · 配错: 与其他服务撞端口=后启动的进程起不来
# $env:API_PREFIX = ""   # 【建议】str default=/v3 — 路由前缀 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:224 · 配错: 值拼错时该功能静默失效或回落缺省
# 【建议·按服务分块】Panel 现役日志级别由它决定；本机未设，走代码缺省 info
#   MemoryPanel: $env:LOG_LEVEL = "info"      # 排查时临时改 debug（panel-config.ts:61）
   # 【建议】enum(info|debug|warn|error) default=info — 日志级别（Knowledge debug / Panel info） · 消费: MemoryPanel/src/panel/config/panel-config.ts:61 · 配错: 非法值被静默翻成 info
# $env:KNOWLEDGE_PUBLIC_BASE_URL = ""   # 【建议】str default=none — 对外公布基址（生成 service_url） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:225 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_DATA_DIR = ""   # 【建议】path default=./data — 知识资产根目录（相对进程 cwd） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:221 · 配错: 指错=知识库读空/重建
# $env:KNOWLEDGE_DB_PATH = ""   # 【建议】path default=./data/knowledge.db — SQLite 主库路径 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:222 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_SERVICE_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 服务间共享密钥；空=/v3 全放行 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:233 · 配错: 空=/v3 全放行；与 core 不一致=跨进程 401
# $env:TMC_CALLBACK_URL = ""   # 【建议】str default=none — 管控回调根地址；空=跳过 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:226 · 配错: 值拼错时该功能静默失效或回落缺省
$env:KNOWLEDGE_RERANK_URL = "http://127.0.0.1:8420/v1/rerank"   # 【现役】 str default=none — core /v1/rerank URL；空=关重排 · 本机现役: 置空即整体关闭 wiki 召回重排（config-first 缺省关，此处为部署级显式开启） · 消费: MemoryKnowledge/src/config.ts:213 · 配错: 错=重排整段超时（800ms 预算），召回变慢
# $env:KNOWLEDGE_RERANK_API_KEY = $env:TDAI_GATEWAY_API_KEY   # 【现役·需填】 str default=none — 调 rerank 的 Bearer（=网关 key） · 本机现役: Bearer 用网关同 key · 消费: MemoryKnowledge/src/config.ts:229 · 配错: 空/错=相关调用 401 或功能静默失效（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:KNOWLEDGE_RERANK_TIMEOUT_MS = ""   # 【建议】ms default=800 — 单次重排超时（clamp 100~30000） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:230 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_MODE = ""   # 【建议】enum(custom) default=custom — Knowledge 全局 LLM 路由模式；Wave 3 后只剩 custom（直连 LLM_BASE_URL + LLM_API_KEY），残留 proxy/byo 启动即抛错 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:173 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_PROTOCOL = ""   # 【建议】enum(openai,anthropic) default=openai — 上游协议 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:239 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_PROVIDER = ""   # 【建议】str default=custom — 供应商标签（仅展示） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:240 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_API_KEY = $env:TDAI_LLM_API_KEY   # 【现役·需填】 str default=none — custom 模式上游 key · 本机现役: Knowledge 只读这个名；值同 TDAI_LLM_API_KEY（dotenv 不会覆盖已存在的进程值） · 消费: MemoryKnowledge/src/config.ts:241 · 配错: 空/错=相关调用 401 或功能静默失效（密钥：未注释的 <REPLACE_ME> 等于把口令交给任何读者，故默认注释；替换后去掉行首 #）
# $env:LLM_MODEL = ""   # 【建议】str default=Memory-Model — 缺省模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:242 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_BASE_URL = ""   # 【建议】str default=none — 上游 baseUrl（含 /v1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:243 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LLM_MAX_TOKENS = ""   # 【建议】int default=32768 — 单次 completion 上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:244 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_TIMEOUT_MS = ""   # 【建议】ms default=1200000 — 单次 LLM 超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:245 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:LLM_STREAM = ""   # 【建议】bool default=false — 是否流式（只认 true） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:246 · 配错: 只认字符串 true；写 True/1 视为关
# $env:EMBEDDING_PROVIDER = ""   # 【建议】str default=openai_compatible — 向量协议标签 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:249 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_BASE_URL = ""   # 【建议】str default=none — 向量服务 baseUrl；空=不启用 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:250 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_API_KEY = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — 向量服务 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:251 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:EMBEDDING_MODEL = ""   # 【建议】str default=none — 向量模型名 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:252 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:EMBEDDING_DIMENSIONS = ""   # 【建议】int default=0 — 向量维度；0=不启用 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:253 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_WIKI_POOL_MAX = ""   # 【建议】int default=300 — wiki 索引只读连接池上限 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/engines/wiki/index-db.ts:35 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_WIKI_INGEST_CONCURRENCY = ""   # 【建议】int default=3 — 单 wiki 抽取并发（clamp 1~10） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:148 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_LLM_GLOBAL_CONCURRENCY = ""   # 【建议】int default=5 — 全局 LLM 并发（clamp 1~20） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:157 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_AUTO_SYNC_ENABLED = ""   # 【建议】bool default=false — 自动同步开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:53 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN = ""   # 【建议】float default=10 — 扫描周期（分钟，clamp 1~1440） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:54 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT = ""   # 【建议】int default=3 — 同时同步仓库数 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/store/auto-sync-scheduler.ts:55 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_SSRF_CHECK = ""   # 【建议】bool default=true — SSRF 私网黑名单（off 可关） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/source-fetcher/git-fetcher.ts:39 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_CLICKHOUSE_ENABLED = ""   # 【建议】bool default=false — Knowledge 侧 CH 埋点开关 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:206 · 配错: 只认字符串 true；写 True/1 视为关
# $env:KNOWLEDGE_CLICKHOUSE_URL = ""   # 【建议】str default=none — CH HTTP 端点 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:187 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_DATABASE = ""   # 【建议】str default=default — CH 库名（标识符校验） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:193 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_TABLE = ""   # 【建议】str default=tool_call_logs — CH 表名（标识符校验） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:194 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_USER = ""   # 【建议】str default=default — CH 用户 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:210 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_CLICKHOUSE_PASSWORD = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — CH 密码 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:211 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS = ""   # 【建议】ms default=5000 — 攒批 flush 间隔（>=100） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:195 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD = ""   # 【建议】int default=50 — 攒够行数 flush（>=1） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:196 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_TTL_DAYS = ""   # 【建议】int default=90 — 埋点表 TTL（天） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:197 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS = ""   # 【建议】ms default=5000 — 单次 CH 写入超时（>=100） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/config.ts:198 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭

# ── MemoryKnowledge：观测
# $env:LANGFUSE_BASE_URL = ""   # 【建议】str default=https://cloud.langfuse.com — Knowledge 侧 Langfuse 地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryKnowledge/src/telemetry.ts:44 · 配错: 值拼错时该功能静默失效或回落缺省

# ── MemoryPanel（8123）
# $env:HOST = ""   # 【建议】str default=0.0.0.0 — Panel 监听地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:45 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:LOG_FORMAT = ""   # 【建议】enum(json,pretty) default=json — Panel 日志格式 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:42 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:METADATA_INSTANCES_CONFIG = ""   # 【建议】path default=./config/metadata-instances.json — 实例清单文件（必填，否则实例列表空） · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:48 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:METADATA_REMOTE_TIMEOUT_MS = ""   # 【建议】ms default=15000 — 元数据远端超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:49 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:UI_DIST_DIR = ""   # 【建议】path default=./web/dist — 前端静态目录 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:50 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_SERVICE_URL = ""   # 【建议】str default=http://127.0.0.1:8421 — Knowledge 服务地址 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:56 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:KNOWLEDGE_AUTH_TOKEN = <REPLACE_ME: 需要时填真值>   # 【建议】str default=none — Knowledge 服务 key · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:57 · 配错: 空/错=相关调用 401 或功能静默失效
# $env:KNOWLEDGE_TIMEOUT_MS = ""   # 【建议】ms default=15000 — Knowledge 调用超时 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:58 · 配错: 非数字被静默忽略（回落缺省）；设 0 常等于关闭
# $env:TDAI_AGENT_TEMPLATE_DIR = ""   # 【建议】path default=./data/agent-templates — Agent 模板本地目录 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: MemoryPanel/src/panel/config/panel-config.ts:60 · 配错: 值拼错时该功能静默失效或回落缺省
$env:TDAI_RECALL_JOURNAL_DIR = "D:/TDB/data/logs/recall"   # 【现役】 path default=none — 召回 journal 目录（覆盖 TDAI_DATA_DIR 推导） · 本机现役: 不设则由 TDAI_DATA_DIR 派生（Panel BFF 直读） · 消费: MemoryPanel/src/panel/http/routes/chat-memory.ts:64 · 配错: 值拼错时该功能静默失效或回落缺省

# ── dsh-plugin（宿主内运行，不需要单独进程）
# $env:DSH_HOME = ""   # 【建议】path default=none — DSH 家目录（outbox 死信落点）；宿主决定 · 本机未设，走代码缺省/yaml；需要时去掉行首 # · 消费: dsh-plugin/src/outbox.ts:96 · 配错: 值拼错时该功能静默失效或回落缺省
# $env:TDAI_DSH_USER_KEY = "admin"   # 【现役·本机】 str default=none — DSH 客户端 user_key（本机当 x-tdai-user-key 头发给 core）；仓库内 0 个字面读点：插件按 server.userKeyRef 泛化解析（dsh-plugin/src/index.ts:300，缺省 ref=TDAI_USER_KEY，dsh-plugin/src/config.ts:334），插件路径不读本文件：身份取自 ~/.dsh/.credentials.yaml 的 refs.TDAI_USER_KEY / refs.TDAI_GATEWAY_APIKEY（credentials ref 解析，桌面 patch 只写 apiKeyRef 不写 userKeyRef），本变量只对 ops 脚本有意义；故登记在此但排除出 EnvKeys/keys.json（见 env.keys.json.ignored）
