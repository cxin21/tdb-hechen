#!/bin/bash
# issue #134（写入治本）逐项独立档：**每档从 b1-off 基线库（$BASE）复制 + 只补写本档差异**。
#  - w1  = BASE + W1 事实键双写
#  - w2  = BASE + W2 写时 supersede（+validityNow=题目日期）
#  - w3  = BASE + W3 结论卡 + part_of 回捞
#  - w13 = W1 库复制 + W3（叠加档）
#  - combo = W1 库复制 + W2 + W3（全开）
# 门禁链：先跑抽样验收门禁（fact-extract-gate），再跑档，最后 bench-gates 判定。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
G="node --import tsx scripts/fact-extract-gate.mjs"
L=.eval-data/bench
TMP="${TMPDIR:-/tmp}"
BASE="${BASE_STORE:-/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/longmemeval-oracle-mvphl2m1}"
STORE_ROOT="${STORE_ROOT:-$TMP/tdagemem-bench}"
W1STORE="$STORE_ROOT/lme90-w134-w1"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-off --b1 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
FAILED=0
run() {
  local tag="$1"; shift
  echo "[w134] start $tag $(date +%H:%M:%S)"
  $B "$@" --tag "$tag" || { echo "[w134] FAILED: $tag"; FAILED=$((FAILED+1)); }
  echo "[w134] done $tag $(date +%H:%M:%S)"
}
fresh_from() {  # fresh_from <src> <dst>
  rm -rf "$2"
  cp -r "$1" "$2"
  echo "[w134] 复制库 $1 → $2"
}
gate_facts() {
  [ -f "$L/fact-gate.json" ] && return 0
  echo "[w134] 抽取抽样验收门禁..."
  $G --dataset longmemeval --manifest $L/lme-manifest.json --cache $L/facts-cache \
     --sample 40 --threshold 0.9 --concurrency 6 --out $L > $L/run-fact-gate.log 2>&1 || { echo "[w134] 抽样门禁 FAIL"; FAILED=$((FAILED+1)); }
  cp -f "$(ls -t $L/fact-gate-*.json 2>/dev/null | head -1)" "$L/fact-gate.json" 2>/dev/null || true
}
case "${1:-help}" in
  w1) gate_facts; fresh_from "$BASE" "$W1STORE"; run w1 $COMMON --keep --store "$W1STORE" --fact-dual-write ;;
  w2) gate_facts; fresh_from "$BASE" "$STORE_ROOT/lme90-w134-w2"; run w2 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w2" --write-supersede --b2b-validity ;;
  w3) gate_facts; fresh_from "$BASE" "$STORE_ROOT/lme90-w134-w3"; run w3 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w3" --conclusion-cards ;;
  w13) gate_facts; fresh_from "$W1STORE" "$STORE_ROOT/lme90-w134-w13"; run w13 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w13" --conclusion-cards ;;
  combo) gate_facts; fresh_from "$W1STORE" "$STORE_ROOT/lme90-w134-combo"; run w-combo $COMMON --keep --store "$STORE_ROOT/lme90-w134-combo" --write-supersede --b2b-validity --conclusion-cards ;;
  all) for m in w1 w2 w3 w13 combo; do bash "$0" $m; done ;;
  *) echo "用法: $0 {w1|w2|w3|w13|combo|all}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[w134] 有 $FAILED 处失败"; exit 1; fi
echo "[w134] OK"
