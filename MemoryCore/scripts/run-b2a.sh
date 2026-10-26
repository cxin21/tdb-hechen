#!/usr/bin/env bash
# B2-a 精排三档 A/B（bench/recall-opt S3）：复用基线沙箱库（零重灌），一次一变量。
# T0 基线 = b0-base（minScore -2.0, candidates 12, 沙箱 yaml 默认档）
set -u
cd "$(dirname "$0")/.."   # MemoryCore/
STORE="${1:?用法: run-b2a.sh <storeDir>}"
shift || true
LOGDIR=.eval-data/bench
run_tier() {
  local tag="$1"; shift
  echo "=== [B2-a] tier=${tag} start $(date +%H:%M:%S) ==="
  node --import tsx scripts/eval-memory-bench.mjs \
    --dataset longmemeval --manifest .eval-data/bench/lme-manifest.json \
    --store "$STORE" --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 \
    --tag "$tag" "$@" > "$LOGDIR/run-${tag}.log" 2>&1
  echo "=== [B2-a] tier=${tag} exit=$? $(date +%H:%M:%S) ==="
}
# T1 池效应隔离：candidates 12→32，minScore 不动
run_tier b2a-pool32 --rerank-candidates 32
# T2 闸门收紧：minScore 0（只留正相关对），池 32
run_tier b2a-ms0 --rerank-minscore 0 --rerank-candidates 32
# T3 闸门放空：minScore -10.5（近关=只挡全无关），池 32
run_tier b2a-ms105 --rerank-minscore -10.5 --rerank-candidates 32
# T4 关闸对照：rerank.enabled=false（纯 RRF 序），池 32
run_tier b2a-off --rerank-off --rerank-candidates 32
echo "=== [B2-a] all tiers done $(date +%H:%M:%S) ==="
