#!/usr/bin/env bash
# 单独拉起 memory-core（内核 gateway，端口 8420），首次启动自动 init-admin +
# 把生成的 user_key 持久化到 .admin-key 供 proxy / claude-code 使用。
#
# 用法：
#   ./start-memory-core.sh
#
# 数据持久化到 named volume（默认 tdai-memory-core-data，可在 .env 改 MEMORY_CORE_VOLUME）。
# 重复执行会先移除旧容器再启新的，volume 数据保留 —— admin user_key 也随之保留。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
# ── 参数（必须在 source _lib 之前解析：--render-only 要能在无 docker 的机器上跑）──
# --render-only / --dry-run：只渲染 gateway 配置并打印，不起容器、不碰网络。
#   这是「配置真源可验证」的出口：CI 与排障都用它核对 base.yaml 渲染结果。
RENDER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --render-only|--dry-run) RENDER_ONLY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "[error] 未知参数：${arg}（支持 --render-only / --dry-run / --help）" >&2; exit 1 ;;
  esac
done
export TDAI_SKIP_DOCKER_PROBE="$RENDER_ONLY"

source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME


# ── Gateway 内部管理凭据 ─────────────────────────────────────────
# 用 ${VAR-default}（不是 :-default）：允许 .env 里显式设为空字符串来关闭 Bearer gate。
#
# 当前 memory-core 的 Bearer gate 与 proxy auth 存在**已知不兼容**：proxy 调
# /v3/meta/auth/verify 时不带 Bearer（源码遗漏，见 MemoryProxy/src/auth.ts），
# 所以 proxy 启用 auth 时必须把 MEMORY_CORE_GATEWAY_API_KEY 留空。默认已置空。
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# admin user_key 持久化位置（宿主机侧；volume 数据被清后需一并删掉此文件）
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY 非空 —— proxy 的 sessionInit/auth 目前会因缺 Bearer 而失败。"
  warn "本地体验请把 .env 里的 MEMORY_CORE_GATEWAY_API_KEY 留空。"
fi

# 可选 Bearer 头必须用数组，不能写成 ${VAR:+-H "Authorization: ..."} 直接展开：
# 那种写法整体未加引号，内层引号不生效，会被分词成 -H / Authorization: / Bearer / <key>
# 四个 token（curl 把后两个当 URL）—— 配了 key 时两处 curl 必失败。
AUTH_HEADER=()
if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}")
fi

CONTAINER=tdai-memory-core
NETWORK=tdai-memory-stack

# 网络与镜像准备。--render-only 分支要能脱 docker 运行（CI/排障），故整段受 RENDER_ONLY 门控。
if [[ "$RENDER_ONLY" -eq 0 ]]; then
  # 创建共享网络（幂等）
  if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
    info "创建 docker 网络 $NETWORK"
    $DOCKER network create "$NETWORK" >/dev/null
  fi

  pull_image "$MEMORY_CORE_IMAGE"
  rm_container_if_exists "$CONTAINER"
fi

# ── 渲染 gateway config.yaml，挂到容器 /data/config/tdai-gateway.yaml ──
# 唯一真源 = 本目录 tdai-gateway.base.yaml（完整生产档，每个决策键带 evidence 标记）。
# 历史教训：本脚本曾内联 heredoc 拼 yaml，脚本里没写的键在生产就是【代码缺省】——
# 代码缺省一改，生产静默跟着变（#145/#173 的病根）。现在脚本只做两件事：
#   cp base → 对 .env 里存在的值做单键占位符替换；不渲染新键，也不删键。
# 键清单与证据等级见 docs/ops/production-profile.md；三套真源的关系见该文件 §0。
BASE_CONFIG="$SCRIPT_DIR/tdai-gateway.base.yaml"
[[ -f "$BASE_CONFIG" ]] || die "缺少 $BASE_CONFIG —— 生产配置真源不在，拒绝用隐式代码缺省启动。"

CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/tdai-gateway.yaml"

# render_key <占位符> <值>：替换 base 里全部同名占位符。
# sed 元字符转义：值里出现 \\ & | 时不转义会破坏替换（API key/baseUrl 常见 & 与 |）。
render_key() {
  local ph="$1" val="$2" esc
  esc="${val//\\/\\\\}"
  esc="${esc//&/\\&}"
  esc="${esc//|/\\|}"
  sed -i "s|${ph}|${esc}|g" "$CORE_CONFIG_FILE"
}

info "渲染 gateway config → ${CORE_CONFIG_FILE}（base=$(basename "$BASE_CONFIG")）"
cp "$BASE_CONFIG" "$CORE_CONFIG_FILE"

# ── LLM（必填；模型/端点错了记忆流水线整体静默 0 条，故 loud 警告）──
MEMORY_LLM_BASE_URL="${MEMORY_LLM_BASE_URL:-}"
MEMORY_LLM_MODEL="${MEMORY_LLM_MODEL:-}"
MEMORY_LLM_API_KEY="${MEMORY_LLM_API_KEY-}"
[[ -n "$MEMORY_LLM_BASE_URL" ]] || warn "MEMORY_LLM_BASE_URL 为空 —— 抽取/结论层/扩展门的 LLM 调用会全失败。"
[[ -n "$MEMORY_LLM_MODEL" ]] || warn "MEMORY_LLM_MODEL 为空 —— 同上。"
if [[ "$MEMORY_LLM_BASE_URL" == *REPLACE_ME* || "$MEMORY_LLM_MODEL" == *REPLACE_ME* ]]; then
  warn "MEMORY_LLM_* 仍是模板占位值（REPLACE_ME）——启动后 LLM 调用会失败。"
fi
render_key "__MEMORY_LLM_BASE_URL__" "$MEMORY_LLM_BASE_URL"
render_key "__MEMORY_LLM_API_KEY__" "$MEMORY_LLM_API_KEY"
render_key "__MEMORY_LLM_MODEL__" "$MEMORY_LLM_MODEL"

# ── promptMode（缺省 chat；本仓与上游同为 chat —— ADR-0018 铁律 5 修正版）──
MEMORY_PROMPT_MODE="${MEMORY_PROMPT_MODE:-chat}"
case "$MEMORY_PROMPT_MODE" in
  chat|code) ;;
  *) warn "MEMORY_PROMPT_MODE=$MEMORY_PROMPT_MODE 非法（只认 chat|code）—— 回落 chat。"; MEMORY_PROMPT_MODE=chat ;;
esac
render_key "__MEMORY_PROMPT_MODE__" "$MEMORY_PROMPT_MODE"

# ── embedding：向量召回的唯一开关。未配 = 纯词法路，必须 loud（不是静默降级）──
MEMORY_EMBEDDING_PROVIDER="${MEMORY_EMBEDDING_PROVIDER:-none}"
MEMORY_EMBEDDING_BASE_URL="${MEMORY_EMBEDDING_BASE_URL:-}"
MEMORY_EMBEDDING_API_KEY="${MEMORY_EMBEDDING_API_KEY-}"
MEMORY_EMBEDDING_MODEL="${MEMORY_EMBEDDING_MODEL:-}"
MEMORY_EMBEDDING_DIMENSIONS="${MEMORY_EMBEDDING_DIMENSIONS:-0}"
if [[ "$MEMORY_EMBEDDING_PROVIDER" != "none" ]]; then
  if [[ -z "$MEMORY_EMBEDDING_BASE_URL" || -z "$MEMORY_EMBEDDING_MODEL" || "$MEMORY_EMBEDDING_DIMENSIONS" == "0" ]]; then
    warn "embedding 想开（provider=${MEMORY_EMBEDDING_PROVIDER}）但 baseUrl/model/dimensions 不全 —— 回落 provider=none。"
    MEMORY_EMBEDDING_PROVIDER=none
  fi
fi
if [[ "$MEMORY_EMBEDDING_PROVIDER" == "none" ]]; then
  MEMORY_EMBEDDING_BASE_URL=""; MEMORY_EMBEDDING_API_KEY=""; MEMORY_EMBEDDING_MODEL=""; MEMORY_EMBEDDING_DIMENSIONS=0
  warn "embedding.provider=none —— 混合检索降级为纯词法（bm25）：candidateK/fusion/rerank/smallToBig 的实测档覆盖面变窄。"
  warn "要开向量路：.env 补齐 MEMORY_EMBEDDING_PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS 后重启。"
fi
render_key "__MEMORY_EMBEDDING_PROVIDER__" "$MEMORY_EMBEDDING_PROVIDER"
render_key "__MEMORY_EMBEDDING_BASE_URL__" "$MEMORY_EMBEDDING_BASE_URL"
render_key "__MEMORY_EMBEDDING_API_KEY__" "$MEMORY_EMBEDDING_API_KEY"
render_key "__MEMORY_EMBEDDING_MODEL__" "$MEMORY_EMBEDDING_MODEL"
render_key "__MEMORY_EMBEDDING_DIMENSIONS__" "$MEMORY_EMBEDDING_DIMENSIONS"

# ── 渲染自检：占位符必须全消。残留 = base 加了键但脚本没喂值（配置会带字面量进运行时）──
leftover="$(grep -o '__MEMORY_[A-Z_]*__' "$CORE_CONFIG_FILE" | sort -u || true)"
if [[ -n "$leftover" ]]; then
  die "渲染后仍有未替换占位符：$(echo "$leftover" | tr '\n' ' ')。检查 base.yaml 与本脚本的键对应关系。"
fi

if [[ "$RENDER_ONLY" -eq 1 ]]; then
  info "--render-only：只渲染，不起容器。渲染结果如下 →"
  cat "$CORE_CONFIG_FILE"
  exit 0
fi

info "启动 memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  -p "${MEMORY_CORE_PORT}:8420" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  "$MEMORY_CORE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-core 已启动 → http://localhost:${MEMORY_CORE_PORT}/"

# ── Admin user 生命周期 ─────────────────────────────────────────
# 首次启动：init-admin 时**传入我们生成的随机 user_key**，返回体里读回来存文件。
# 重启且已初始化（409）：优先读 .admin-key；若 volume 是新造的但 .admin-key 是
#   旧的，无法恢复（volume/key 必须同步；提示用户清理）。
#
# init-admin 接口尊重传入的 user_key（见 MemoryCore/src/metadata/store/sqlite-adapter.ts
# defaultKeyValue = input.default_key_value ?? generateUserKey()）；只要 volume 空、
# 我们传固定 key，就能拿到自己指定的 key。首次启动时脚本生成一把 32 字节随机
# base32url —— 每台机器/每次 purge 都是独立 key，不会撞车。

generate_user_key() {
  # sk-mem-<32 chars A-Za-z0-9>，与 metadata/utils/user-key.ts 的格式一致
  # 用 openssl（可移植；tr 过滤 base64 里的 +/= 到 32 位）
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # 兜底：读足够多的 urandom 保证过滤后 >=32
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$("$CURL" -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-tdai-service-id: default" \
    "${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"}" \
    "http://localhost:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "初始化 admin user（username=${MEMORY_CORE_ADMIN_USERNAME}, key 持久化 → ${ADMIN_KEY_FILE}）..."

# 生成随机 key（首次 init-admin 用；若之前有 file 就复用）
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  复用已保存的 admin key（.admin-key 已存在）"
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$("$CURL" -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  "${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"}" \
  -H "x-tdai-service-id: default" \
  "http://localhost:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "admin user 已创建"
    # 落盘 key（把宿主机 file 的权限收紧）
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  admin user_key 已保存到 $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "admin user 已存在（跳过 init-admin，用 $ADMIN_KEY_FILE 里的 key）"
    else
      warn "admin user 已存在，但 $ADMIN_KEY_FILE 缺失，无法恢复 user_key。"
      warn "选项 A: 清理 volume 重建 —— ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "选项 B: 手动创建新 admin user_key（需要旧 key 或 gateway apiKey）"
    fi
    ;;
  *)
    warn "init-admin 返回 HTTP=${init_resp}，可能需要手动排查："
    cat /tmp/init-admin.$$ 2>/dev/null; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# ── 校验 admin key 可用 ─────────────────────────────────────────
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # 只在末尾做脱敏输出：整串路径 masked，让终端历史里不留全值
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "admin user_key 校验通过（auth/verify 200）—— $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "admin user_key 校验失败（auth/verify 非 200）。检查 $ADMIN_KEY_FILE 与 volume 是否匹配。"
  fi
fi
