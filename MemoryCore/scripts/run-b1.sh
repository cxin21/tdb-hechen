#!/usr/bin/env bash
# B1 读侧四件套 A/B（bench/recall-opt S4）：复用基线沙箱库（零重灌），只开 --b1。
# 对照 = B2-a 最优档（由 S3 结论决定，默认先对 b0-base 纯净对照；胜出档对照用参数指定额外跑）。
set -u
cd "$(dirname "$0")/.."   # MemoryCore/
STORE="${1:?用法: run-b1.sh <storeDir> [额外runner参数...]}"
shift || true
LOGDIR=.eval-data/bench
echo "=== [B1] tier=b1 start $(date +%H:%M:%S) ==="
node --import tsx scripts/eval-memory-bench.mjs \
  --dataset longmemeval --manifest .eval-data/bench/lme-manifest.json \
  --store "$STORE" --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-child-proc --rerank-child-proc \
  --tag b1 --b1 "$@" > "$LOGDIR/run-b1.log" 2>&1
echo "=== [B1] tier=b1 exit=$? $(date +%H:%M:%S) ==="
