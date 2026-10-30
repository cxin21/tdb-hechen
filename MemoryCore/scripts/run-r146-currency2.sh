#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
CORE="--dataset longmemeval --manifest .eval-data/bench/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
PROD="--prod-data .eval-data/bench/llm-shim-scm"
S=C:/Users/Administrator/AppData/Local/Temp/tdagemem-bench/longmemeval-oracle-mvtavhl6
LOG=.eval-data/bench/logs
run() { local tag="$1"; shift; echo "[cur2] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" --report-name "lme90-r146-$tag" 2>&1 | tee "$LOG/$tag.log" | tail -2; echo "[cur2] done $tag $(date +%H:%M:%S)"; }
# E4：槽位预算（maxResults 10）—— 旧提示，隔离"多给证据"这一杠杆
run r146c-wide   $CORE $DEEP $PROD --store $S --no-write-steps --recall-max-results 10
# E5：偏好题口径 —— 旧提示 + 仅偏好段
run r146c-pref   $CORE $DEEP $PROD --store $S --no-write-steps --pref-prompt
# E6：组合最优候选（宽证据 + 币值 + 偏好）
run r146c-best   $CORE $DEEP $PROD --store $S --no-write-steps --recall-max-results 10 --currency-prompt --pref-prompt
echo "[cur2] ALL DONE"
