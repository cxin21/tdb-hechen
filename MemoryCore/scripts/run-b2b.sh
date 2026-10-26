#!/usr/bin/env bash
# B2-b 三个变量独立 A/B（bench/recall-opt S5）：复用基线沙箱库（零重灌），一次一变量。
# T5 MMR（λ0.7） / T6 validityNow=题目日期 / T7 向量门槛 0.3→0.15
set -u
cd "$(dirname "$0")/.."   # MemoryCore/
STORE="${1:?用法: run-b2b.sh <storeDir>}"
shift || true
LOGDIR=.eval-data/bench
run_tier() {
  local tag="$1"; shift
  echo "=== [B2-b] tier=${tag} start $(date +%H:%M:%S) ==="
  node --import tsx scripts/eval-memory-bench.mjs \
    --dataset longmemeval --manifest .eval-data/bench/lme-manifest.json \
    --store "$STORE" --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 \
    --tag "$tag" "$@" > "$LOGDIR/run-${tag}.log" 2>&1
  echo "=== [B2-b] tier=${tag} exit=$? $(date +%H:%M:%S) ==="
}
# 先 2 题冒烟（新旗标端到端验证，不进比较）
echo "=== [B2-b] smoke 2 cases ==="
node --import tsx scripts/eval-memory-bench.mjs \
  --dataset longmemeval --manifest .eval-data/bench/lme-manifest.json \
  --store "$STORE" --keep --pace 150 --limit 2 --recall-ks 1,3,5,10 \
  --tag b2b-smoke --mmr --b2b-validity --emb-threshold 0.15 \
  > "$LOGDIR/run-b2b-smoke.log" 2>&1
echo "=== [B2-b] smoke exit=$? $(date +%H:%M:%S) ==="
# T5 MMR 去近重复
run_tier b2b-mmr --mmr
# T6 validityNow=题目日期
run_tier b2b-validity --b2b-validity
# T7 向量余弦门槛放宽
run_tier b2b-eth015 --emb-threshold 0.15
echo "=== [B2-b] all tiers done $(date +%H:%M:%S) ==="
