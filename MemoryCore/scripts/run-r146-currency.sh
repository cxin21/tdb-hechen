#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
CORE="--dataset longmemeval --manifest .eval-data/bench/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
PROD="--prod-data .eval-data/bench/llm-shim-scm"
S=C:/Users/Administrator/AppData/Local/Temp/tdagemem-bench
LOG=.eval-data/bench/logs
mkdir -p "$LOG"
run() { local tag="$1"; shift; echo "[cur] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" --report-name "lme90-r146-$tag" 2>&1 | tee "$LOG/$tag.log" | tail -2; echo "[cur] done $tag $(date +%H:%M:%S)"; }
run r146c-base $CORE $DEEP $PROD --store $S/longmemeval-oracle-mvtavhl6 --no-write-steps --currency-prompt
run r146c-mask $CORE $DEEP $PROD --store $S/longmemeval-oracle-mvuh32ed --no-write-steps --fact-rows --currency-prompt
echo "[cur] ALL DONE"
