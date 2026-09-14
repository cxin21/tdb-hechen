#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# td-agemem 腾讯云 · 系统初始化（Ubuntu 22.04/24.04，root 或 sudo）
# 见同目录 ../DEPLOY.md 完整手册。执行一次即可。
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

echo "── 1/5 编译工具链（better-sqlite3 / node-pty 原生模块需要）──"
apt-get update
apt-get install -y --no-install-recommends build-essential python3 curl git ca-certificates caddy

echo "── 2/5 Node 22（NodeSource）──"
if command -v node >/dev/null 2>&1 && [[ "$(node -v | cut -c2-3)" == "22" ]]; then
  echo "node 22 已在位: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "── 3/5 pnpm（corepack）──"
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v

echo "── 4/5 运行用户（非 root 跑服务）──"
id -u tdai >/dev/null 2>&1 || useradd -r -m -d /opt/tdai -s /usr/sbin/nologin tdai

echo "── 5/5 目录骨架 ──"
mkdir -p /opt/tdai/etc /opt/tdai/data
chown -R tdai:tdai /opt/tdai

echo "完成。下一步见 ../DEPLOY.md §3（拉代码 + 装依赖 + 配置落盘）。"
