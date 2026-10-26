#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# td-agemem 腾讯云 · Panel 前端重建（MemoryPanel/web → dist）
#
# 为什么必须单独一步：
#   tdai-panel 的后端是 `node --import tsx src/index.ts` 直跑 TS 源码，
#   git pull 后重启即生效；但**前端是 web/dist 静态产物**，而 dist/ 在
#   MemoryPanel/web/.gitignore 里（不上 git）。只 pull 不 build = 页面停在
#   上一次构建的版本。2026-10 事故：dist 停在 10-02，10-16 的「Rerank 拆
#   独立页签」在线上完全看不到，被误判成"配置项消失了"。
#
# 用法：
#   sudo bash deploy/tencent-cloud/native/rebuild-panel-web.sh
#   （root 调用时自动降到 tdai 用户跑 pnpm；非 root 需自身可写 web 目录）
# 环境变量：
#   RUN_USER=tdai   以哪个用户构建（默认 tdai）
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

RUN_USER="${RUN_USER:-tdai}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WEB_DIR="$REPO_ROOT/MemoryPanel/web"
DIST_DIR="$WEB_DIR/dist"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "✗ 找不到 MemoryPanel/web：$WEB_DIR（脚本需在本仓库内运行）" >&2
  exit 1
fi

# 以 RUN_USER 身份执行一条命令（root 且目标用户不同 → 降权）
as_build_user() {
  if [[ "$(id -u)" -eq 0 && "$(id -un)" != "$RUN_USER" ]]; then
    sudo -u "$RUN_USER" bash -c "$1"
  else
    bash -c "$1"
  fi
}

old_mtime=$(stat -c %Y "$DIST_DIR" 2>/dev/null || echo 0)

echo "── 1/3 依赖（缺 node_modules 才装）──"
if [[ -d "$WEB_DIR/node_modules" ]]; then
  echo "已存在 node_modules，跳过安装（要强制刷新：rm -rf '$WEB_DIR/node_modules' 后重跑）"
else
  as_build_user "cd '$WEB_DIR' && pnpm install --no-frozen-lockfile"
fi

echo "── 2/3 构建（tsc && vite build）──"
as_build_user "cd '$WEB_DIR' && pnpm build"

echo "── 3/3 校验产物 ──"
if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "✗ 构建结束但没有 $DIST_DIR/index.html" >&2
  exit 1
fi
asset=$(grep -o 'assets/main-[A-Za-z0-9_-]*\.js' "$DIST_DIR/index.html" | head -1 || true)
if [[ -z "$asset" || ! -f "$DIST_DIR/$asset" ]]; then
  echo "✗ index.html 引用的 '${asset:-<空>}' 不存在，构建不完整" >&2
  exit 1
fi
new_mtime=$(stat -c %Y "$DIST_DIR")
if (( new_mtime <= old_mtime )); then
  echo "⚠ dist 时间戳未变化（本次构建产物与上次相同？）"
fi
echo "✓ 入口 bundle：$asset"
echo "✓ dist 时间：$(stat -c %y "$DIST_DIR/index.html")"
echo
echo "下一步："
echo "  1) 浏览器 Ctrl+Shift+R 硬刷新（旧 index.html / main-*.js 会被缓存，不刷新看不到新页面）"
echo "  2) tdai-panel 无需重启（静态文件每请求读磁盘）；重启也无害"
