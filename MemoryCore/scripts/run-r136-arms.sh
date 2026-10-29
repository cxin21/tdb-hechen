#!/bin/bash
# issue #136（双时态属性契约 + 软失效）配对档：**每档从 b1-off 基线库（$BASE）复制 + 只补写本档差异**。
#  - card-soft = BASE + W2 supersede（cardinality 门 ON）+ 读侧软失效（recall.validity.mode=soft）
#  - card-hard = BASE + W2 supersede（cardinality 门 ON）+ 读侧硬失效（逐位现状，隔离"软失效"贡献）
#  - nogate-soft = BASE + W2 supersede（门 OFF，= #136 前"谓词一变就失效"）+ 软失效（隔离 cardinality 贡献）
# 配对基线 = b1off-mm（.eval-data/bench/longmemeval-oracle-2026-10-27T05-35-29.json，同 manifest/同 judge）。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMP="${TMPDIR:-/tmp}"
BASE="${BASE_STORE:-/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/lme90-mm-b1off}"
STORE_ROOT="${STORE_ROOT:-$TMP/tdagemem-bench}"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-off --b1 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
FAILED=0
run() {
  local tag="$1"; shift
  echo "[r136] start $tag $(date +%H:%M:%S)"
  $B "$@" --tag "$tag" || { echo "[r136] FAILED: $tag"; FAILED=$((FAILED+1)); }
  echo "[r136] done $tag $(date +%H:%M:%S)"
}
fresh_from() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r136] 复制库 $1 → $2"; }
case "${1:-help}" in
  card-soft)   fresh_from "$BASE" "$STORE_ROOT/lme90-r136-card-soft";   run r136-card-soft   $COMMON --keep --store "$STORE_ROOT/lme90-r136-card-soft"   --write-supersede --b2b-validity --validity-mode soft ;;
  card-soft-final) fresh_from "$BASE" "$STORE_ROOT/lme90-r136-card-soft"; run r136-cardsoft3 $COMMON --keep --store "$STORE_ROOT/lme90-r136-card-soft" --write-supersede --b2b-validity --validity-mode soft ;;
  allon)       fresh_from "$STORE_ROOT/lme90-w134-w1" "$STORE_ROOT/lme90-r136-allon"; run r136-allon $COMMON --keep --store "$STORE_ROOT/lme90-r136-allon" --write-supersede --b2b-validity --validity-mode soft --conclusion-cards --conclusion-max-extra 4 ;;
  newb)        fresh_from "$BASE" "$STORE_ROOT/lme90-r136-newb"; run r136-newb $COMMON --keep --store "$STORE_ROOT/lme90-r136-newb" --write-supersede --b2b-validity --validity-mode soft --conclusion-cards --conclusion-max-extra 4 ;;
  card-hard)   fresh_from "$BASE" "$STORE_ROOT/lme90-r136-card-hard";   run r136-card-hard   $COMMON --keep --store "$STORE_ROOT/lme90-r136-card-hard"   --write-supersede --b2b-validity --validity-mode hard ;;
  nogate-soft) fresh_from "$BASE" "$STORE_ROOT/lme90-r136-nogate-soft"; run r136-nogatesoft $COMMON --keep --store "$STORE_ROOT/lme90-r136-nogate-soft" --write-supersede --b2b-validity --validity-mode soft --supersede-cardinality off ;;
  all) for m in card-soft card-hard nogate-soft; do bash "$0" $m; done ;;
  *) echo "用法: $0 {card-soft|card-soft-final|card-hard|nogate-soft|allon|all}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[r136] 有 $FAILED 处失败"; exit 1; fi
echo "[r136] OK"
