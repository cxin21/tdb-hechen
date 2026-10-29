#!/bin/bash
# #134 基线重跑（MiniMax 判分对齐）：b1-off 与 b0-base
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMPROOT="${TMPDIR:-/tmp}/tdagemem-bench"
BASE="/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/longmemeval-oracle-mvphl2m1"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10"
FAILED=0
run() { local tag="$1"; shift; echo "[mm] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" || { echo "[mm] FAILED $tag"; FAILED=1; }; echo "[mm] done $tag $(date +%H:%M:%S)"; }
rm -rf "$TMPROOT/lme90-mm-b1off" "$TMPROOT/lme90-mm-b0base"
cp -r "$BASE" "$TMPROOT/lme90-mm-b1off"
cp -r "$BASE" "$TMPROOT/lme90-mm-b0base"
run b1off-mm $COMMON --store "$TMPROOT/lme90-mm-b1off" --rerank-off --b1
run b0base-mm $COMMON --store "$TMPROOT/lme90-mm-b0base" --rerank-child-proc
[ "$FAILED" -ne 0 ] && exit 1
echo "[mm] OK"
