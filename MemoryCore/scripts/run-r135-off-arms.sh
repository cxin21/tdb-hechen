#!/bin/bash
# #135 全开档（rerank-off 基线）：R1 candidateK + R2 加权融合 + R3 查询时间感知，逐项消融。
# 基线 = b1off-mm（lme90-mm-b1off：rerank 关断 + --b1，turnCov@5 79.5%），复制库跑档零重灌。
# 用法: bash scripts/run-r135-off-arms.sh [allon|ablate|one <extra-args...>]
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMPROOT="${TMPDIR:-/tmp}/tdagemem-bench"
BASE="/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/lme90-mm-b1off"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --b1 --rerank-off"
FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FAILED=0
run() { local tag="$1"; shift; echo "[r135] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" || { echo "[r135] FAILED $tag"; FAILED=$((FAILED+1)); }; echo "[r135] done $tag $(date +%H:%M:%S)"; }
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r135] 复制库 $1 → $2"; }
allon() { fresh "$BASE" "$TMPROOT/lme90-r135-allon"; run r135-allon $COMMON --store "$TMPROOT/lme90-r135-allon" --candidate-k 32 --present-temporal --fusion "$FDEF"; }
case "${1:-allon}" in
  allon) allon ;;
  ablate)
    allon
    fresh "$BASE" "$TMPROOT/lme90-r135-r1"; run r135-r1 $COMMON --store "$TMPROOT/lme90-r135-r1" --candidate-k 32
    fresh "$BASE" "$TMPROOT/lme90-r135-r3"; run r135-r3 $COMMON --store "$TMPROOT/lme90-r135-r3" --present-temporal
    fresh "$BASE" "$TMPROOT/lme90-r135-fus"; run r135-fus $COMMON --store "$TMPROOT/lme90-r135-fus" --fusion "$FDEF"
    ;;
  one) shift; fresh "$BASE" "$TMPROOT/lme90-r135-one"; run r135-one $COMMON --store "$TMPROOT/lme90-r135-one" "$@" ;;
  *) echo "用法: $0 [allon|ablate|one <args>]"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[r135] 有 $FAILED 处失败"; exit 1; }
echo "[r135] OK — 配对: node scripts/fit-fusion-weights.mjs compare --base .eval-data/bench/longmemeval-oracle-2026-10-27T05-35-29.json --arm allon=<result.json>"