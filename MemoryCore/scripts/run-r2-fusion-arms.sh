#!/bin/bash
# #135 R2/E1：加权融合 LME90 档位跑批（配对 vs 既有 b0base-mm RRF 基线）。
# 每档 = 基线库复制 + recall.fusion 沙箱 yaml 注入（--fusion JSON）。
# 用法: bash scripts/run-r2-fusion-arms.sh [default|grid|one <json> <tag>]
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMPROOT="${TMPDIR:-/tmp}/tdagemem-bench"
BASE="/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/longmemeval-oracle-mvphl2m1"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-child-proc"
FAILED=0
run() { local tag="$1"; shift; echo "[r2] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" || { echo "[r2] FAILED $tag"; FAILED=$((FAILED+1)); }; echo "[r2] done $tag $(date +%H:%M:%S)"; }
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r2] 复制库 $1 → $2"; }
FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FREC='{"mode":"weighted","dense":0.3,"bm25":0.3,"recency":0.3,"validity":0.1,"recencyHalfLifeDays":14}'
FVAL='{"mode":"weighted","dense":0.3,"bm25":0.3,"recency":0.1,"validity":0.3,"recencyHalfLifeDays":30}'
case "${1:-default}" in
  default)
    fresh "$BASE" "$TMPROOT/lme90-r2-wdef"
    run r2-wdef $COMMON --store "$TMPROOT/lme90-r2-wdef" --fusion "$FDEF"
    ;;
  grid)
    for pair in "wdef:$FDEF" "wrec:$FREC" "wval:$FVAL"; do
      tag="${pair%%:*}"; json="${pair#*:}"
      fresh "$BASE" "$TMPROOT/lme90-r2-$tag"
      run "r2-$tag" $COMMON --store "$TMPROOT/lme90-r2-$tag" --fusion "$json"
    done
    ;;
  # #135 全开档：candidateK=32 + weighted fusion wdef + presentTemporal（R1+R2+R3 同时开）
  allon)
    fresh "$BASE" "$TMPROOT/lme90-r2-allon"
    run r2-allon $COMMON --store "$TMPROOT/lme90-r2-allon" --candidate-k 32 --present-temporal --fusion "$FDEF"
    ;;
  # #135 全开 + 消融：allon(R1+R2+R3) → r1only(candidateK) → r3only(presentTemporal)
  ablate)
    fresh "$BASE" "$TMPROOT/lme90-r2-allon"
    run r2-allon $COMMON --store "$TMPROOT/lme90-r2-allon" --candidate-k 32 --present-temporal --fusion "$FDEF"
    fresh "$BASE" "$TMPROOT/lme90-r2-r1only"
    run r2-r1only $COMMON --store "$TMPROOT/lme90-r2-r1only" --candidate-k 32
    fresh "$BASE" "$TMPROOT/lme90-r2-r3only"
    run r2-r3only $COMMON --store "$TMPROOT/lme90-r2-r3only" --present-temporal
    ;;
  one) fresh "$BASE" "$TMPROOT/lme90-r2-$3"; run "r2-$3" $COMMON --store "$TMPROOT/lme90-r2-$3" --fusion "$2" ;;
  *) echo "用法: $0 [default|grid|one <json> <tag>]"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[r2] 有 $FAILED 处失败"; exit 1; }
echo "[r2] OK — 汇总: node scripts/fit-fusion-weights.mjs --base <b0base.json> --arm r2-wdef=<arm.json>"