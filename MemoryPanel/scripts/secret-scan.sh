#!/usr/bin/env bash
# secret-scan.sh v2.5 — 仓库级敏感信息扫描（2026-10-02 评审 UR-05/UR-07 整改；2026-10-04 v16-r1 T-01 TARGETS 追加 docs/ MemoryKnowledge/src）
# 变更（v1→v2）：
#   R2 修复：默认 TARGETS 从 Panel 视角扩为仓库根全模块显式表；必需集缺失 exit 2（不再静默扫空）。
#   R3 修复：移除 `\.md:` 全豁免——md 改走高置信规则（1/2/5），宽松规则 3 仅代码/配置。
#   修复 v1 :49 静默跳过：非必需目标缺失 WARN；必需目标缺失 exit 2。
#   实现 v1 只在文案里宣称的 secret-scan-ignore 行内豁免（命中行含该标记即豁免，计数可见）。
#   新增规则 5：ghp_/AKIA/AIza/xox/PEM PRIVATE KEY 高置信形态。
#   gitignored 过滤保留但 loud：gitignored-skip=N 计数可见（tar 镜像外泄面提示）。
#   规则 1 加词前界（防 task-/risk- 内嵌 sk- 假阳性）；-H 强制文件名前缀（单文件目标必需）。
# 用法：仓库根执行 bash MemoryPanel/scripts/secret-scan.sh [--strict] [path...]
# 集成：pre-commit hook / CI build 前置 / 手动。
set -u
STRICT=0
[[ "${1:-}" == "--strict" ]] && { STRICT=1; shift; }

if [[ $# -eq 0 ]]; then
  TARGETS=(MemoryCore/src MemoryCore/scripts MemoryCore/tdai-gateway.yaml MemoryCore/tdai-gateway.standalone.yaml MemoryProxy/src MemoryProxy/config MemoryProxy/scripts MemoryPanel/src MemoryPanel/web/src MemoryPanel/scripts MemoryPanel/tests MemoryPanel/config docker sdk deploy docs MemoryKnowledge/src README.md)
else
  TARGETS=("$@")
fi
REQUIRED=(MemoryCore/src MemoryProxy/src MemoryPanel/src MemoryPanel/web/src sdk)

PLACEHOLDER='xxx|your-|example|REPLACE_|placeholder|KEY_PLACEHOLDER|<[A-Z_]+>|dummy|fake|test-|demo-|sample|bogus|invalid-|knowledge-debug|-debug"|task-draft-generator'
EXEMPT_PATH='node_modules/|/dist/|/build/|\.example\.|\.test\.|__tests__/'
INLINE_MARK='secret-scan-ignore'
if [[ $STRICT -eq 1 ]]; then
  PLACEHOLDER='__STRICT_NO_PLACEHOLDER__'
  EXEMPT_PATH='__STRICT_NO_EXEMPT__'
fi

inline_skipped=0
gitignored_skipped=0
tmp=$(mktemp)
tmp_md=$(mktemp)
trap "rm -f $tmp $tmp_md" EXIT

for t in "${TARGETS[@]}"; do
  if [[ ! -e "$t" ]]; then
    req=0; for r in "${REQUIRED[@]}"; do [[ "$t" == "$r" ]] && req=1; done
    if [[ $req -eq 1 ]]; then
      echo "❌ secret-scan: 必需扫描目标缺失：$t（脚本必须在仓库根执行）"
      exit 2
    fi
    echo "WARN secret-scan: 目标不存在，跳过：$t" >&2
    continue
  fi
  # 规则 1: sk- 家族（词前界：sk- 前不得为字母数字）
  grep -rEnH "(^|[^A-Za-z0-9])sk-[a-zA-Z0-9_-]{15,}" "./$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true
  # 规则 2: Bearer tokens
  grep -rEnH 'Bearer[[:space:]]+[A-Za-z0-9._+/=~-]{15,}' "./$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true
  # 规则 3: JSON 形态 api_key/secret/password/token（宽松；md 行单独豁免=R3 修复）
  grep -rEnH '"(api_key|apiKey|secret|password|token|passwd)"[[:space:]]*:[[:space:]]*"[^"]{8,}"' "./$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" | grep -Ev '"(local|debug|123123)"' >> "$tmp_md" || true
  # 规则 5: 高置信平台形态
  grep -rEnH "ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" "./$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true
done

# R3：宽松规则 3 的 md 行豁免（md 只由高置信规则 1/2/5 覆盖）
grep -Ev '\.md:' "$tmp_md" >> "$tmp" || true

# 路径豁免
final=$(grep -Ev "$EXEMPT_PATH" "$tmp" || true)

# 行内豁免（v1 文案宣称、v2 实装）：命中行含标记即豁免，计数可见
if [[ -n "$final" ]]; then
  inline_skipped=$(grep -c "$INLINE_MARK" <<< "$final" || true)
  final=$(grep -v "$INLINE_MARK" <<< "$final" || true)
fi

# gitignored 过滤（loud：gitignored 不入 commit，但可能随 tar 镜像外泄——计数提示）
# 前置：需对仓库有 git 权限的身份（本仓库=tdai）；git 不可用时命中按未过滤保留并 WARN。
GIT_OK=0
if git rev-parse --show-toplevel >/dev/null 2>&1; then GIT_OK=1; fi
if [[ $GIT_OK -eq 0 && -n "$final" ]]; then
  echo "WARN secret-scan: git 不可用（身份/所有权），gitignored 过滤未执行——命中按未过滤处理" >&2
fi
if [[ $GIT_OK -eq 1 && -n "$final" ]]; then
  repo_root=$(git rev-parse --show-toplevel)
  filtered=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line%%:*}"
    path="${path#./}"
    if git -C "$repo_root" check-ignore -q "$path" 2>/dev/null; then
      gitignored_skipped=$((gitignored_skipped+1))
      continue
    fi
    filtered+="$line"$'\n'
  done <<< "$final"
  final="${filtered%$'\n'}"
fi

# 同一 file:line 被多条规则命中时只报一次（计数=发现处数）
if [[ -n "$final" ]]; then
  final=$(printf '%s\n' "$final" | awk -F: '{k=$1 FS $2; if (!seen[k]++) print}')
fi

if [[ -n "$final" ]]; then
  echo "❌ secret-scan: 命中可能的敏感信息（$(echo "$final" | grep -c . || true) 处）"
  echo
  echo "$final"
  echo
  echo "确认为示例/占位 → 命中行尾加 $INLINE_MARK 注释豁免；真实密钥 → 立即轮换并改 env 注入，禁止豁免。"
  exit 1
fi

echo "✓ secret-scan: 未发现敏感信息（strict=$STRICT inline豁免=${inline_skipped} gitignored-skip=${gitignored_skipped} 目标：${TARGETS[*]}）"
exit 0
