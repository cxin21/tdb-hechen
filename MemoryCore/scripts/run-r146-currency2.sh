#!/bin/bash
# #146 币值/宽证据/偏好三档诊断（2026-10-31 补 expect-config 与路径口径，#159 跟票）。
# 三档都复用 mvtavhl6 库（--no-write-steps 只读召回），故只有提示/预算变量在动。
cd "$(dirname "$0")/.." || exit 1
# 管道退出码默认取最后一段（tail），会把 runner 的 exit 2 吞成成功——必须开 pipefail。
set -o pipefail
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
CORE="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit ${GEN_LIMIT:-90} --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
PROD="--prod-data $L/llm-shim-scm"
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}/longmemeval-oracle-mvtavhl6"
# 生效快照断言：candidateK/rerank 来自 DEEP；宽证据档额外断言 maxResults=10。
EXPECT="recall.candidateK=32,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-10.5"
EXPECT_WIDE="$EXPECT,recall.maxResults=10"
LOG=$L/logs
mkdir -p "$LOG"
FAILED=0
run() {
  local tag="$1" expect="$2"; shift 2
  local report="$L/lme90-r146-$tag.json"
  rm -f "$report"   # 先删旧报告：否则上一轮遗留报告会让 -f 断言假绿
  echo "[cur2] start $tag $(date +%H:%M:%S)"
  $B "$@" --tag "$tag" --report-name "lme90-r146-$tag" --expect-config "$expect" 2>&1 | tee "$LOG/$tag.log" | tail -2 \
    || { echo "[cur2] FAILED: $tag（eval 非 0）"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$report" ] || { echo "[cur2] FAILED: $tag 未产出报告 $report"; FAILED=$((FAILED+1)); return 1; }
  echo "[cur2] done $tag $(date +%H:%M:%S)"
}
# E4：槽位预算（maxResults 10）—— 旧提示，隔离"多给证据"这一杠杆
run r146c-wide "$EXPECT_WIDE" $CORE $DEEP $PROD --store "$S" --no-write-steps --recall-max-results 10
# E5：偏好题口径 —— 旧提示 + 仅偏好段
run r146c-pref "$EXPECT" $CORE $DEEP $PROD --store "$S" --no-write-steps --pref-prompt
# E6：组合最优候选（宽证据 + 币值 + 偏好）
run r146c-best "$EXPECT_WIDE" $CORE $DEEP $PROD --store "$S" --no-write-steps --recall-max-results 10 --currency-prompt --pref-prompt
if [ "$FAILED" -ne 0 ]; then echo "[cur2] 有 $FAILED 处失败"; exit 1; fi
echo "[cur2] ALL DONE"
