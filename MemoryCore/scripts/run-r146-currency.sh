#!/bin/bash
# #146 币值口径诊断档（2026-10-31 补 expect-config 与路径口径，#159 跟票）。
# 两档共用同一批沙箱库：base = 原文整行（mvtavhl6）、mask = 事实行屏蔽（mvuh32ed）。
# 沙箱库根不硬编码：STORE_ROOT / TMPDIR 任一可覆盖。
cd "$(dirname "$0")/.." || exit 1
# 管道退出码默认取最后一段（tail），会把 runner 的 exit 2 吞成成功——必须开 pipefail。
set -o pipefail
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
CORE="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit ${GEN_LIMIT:-90} --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
PROD="--prod-data $L/llm-shim-scm"
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
# 生效快照断言：**只钉本脚本显式控制的轴**（candidateK + rerank 三项），其余轴沿用生产值、不校验，
# 故这档读数只在这几条轴内部可比；这四键漂了才 exit 2，别把它当成全量口径守护。
EXPECT="recall.candidateK=32,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-10.5"
LOG=$L/logs
mkdir -p "$LOG"
FAILED=0
run() {
  local tag="$1"; shift
  local report="$L/lme90-r146-$tag.json"
  rm -f "$report"   # 先删旧报告：否则上一轮遗留报告会让 -f 断言假绿
  echo "[cur] start $tag $(date +%H:%M:%S)"
  $B "$@" --tag "$tag" --report-name "lme90-r146-$tag" --expect-config "$EXPECT" 2>&1 | tee "$LOG/$tag.log" | tail -2 \
    || { echo "[cur] FAILED: $tag（eval 非 0）"; FAILED=$((FAILED+1)); return 1; }
  # 退出码 0 不等于跑完：报告没落盘同样算失败（口径不符时 runner 会先 exit 2）。
  [ -f "$report" ] || { echo "[cur] FAILED: $tag 未产出报告 $report"; FAILED=$((FAILED+1)); return 1; }
  echo "[cur] done $tag $(date +%H:%M:%S)"
}
run r146c-base $CORE $DEEP $PROD --store "$S/longmemeval-oracle-mvtavhl6" --no-write-steps --currency-prompt
run r146c-mask $CORE $DEEP $PROD --store "$S/longmemeval-oracle-mvuh32ed" --no-write-steps --fact-rows --currency-prompt
if [ "$FAILED" -ne 0 ]; then echo "[cur] 有 $FAILED 处失败"; exit 1; fi
echo "[cur] ALL DONE"
