#!/bin/bash
# issue #146（W2b 事实级双时态）配对档：只有写入粒度不同，其余键位相同。
#  - b1off            = 整行写入基线（--rerank-off --b1，仓位同 #136 的 b1-off 基线）
#  - b1off-factrows   = 同基线 + --fact-rows（一条事实一行 + fact_key 精确失效）
#  - deep             = 深池基线（candidates 32 / minScore -10.5 / candidateK 32，#135 验收前提）
#  - deep-factrows    = 深池 + --fact-rows
# 每档全新灌库（--fact-rows 不允许复用 --store）；facts-cache 共享，故只有第一档付抽取成本。
# 配对：同 manifest / 同 judge，n=90。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
CORE="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
B1="--rerank-off --b1"
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32"
FAILED=0
LOG=$L/logs
mkdir -p "$LOG"
# 每臂独立日志：既 tee 到作业输出（我这边 tail 作业），也落文件（作业被 kill 也能续读进度）。
# 教训：上一版只 `| tail -200`，进度被 tail 缓冲吞掉，看着像"卡死"，误杀了一个 16 分钟的正常臂。
run() {
  local tag="$1"; shift
  echo "[r146] start $tag $(date +%H:%M:%S)"
  ( $B "$@" --tag "$tag" 2>&1 | tee "$LOG/$tag.log" | tail -3 ) || { echo "[r146] FAILED: $tag"; FAILED=$((FAILED+1)); }
  echo "[r146] done $tag $(date +%H:%M:%S) → $LOG/$tag.log"
}
case "${1:-help}" in
  b1off)          run r146-b1off          $CORE $B1 ;;
  b1off-factrows) run r146-b1off-factrows $CORE $B1 --fact-rows ;;
  deep)           run r146-deep           $CORE $DEEP ;;
  deep-factrows)  run r146-deep-factrows  $CORE $DEEP --fact-rows ;;
  all) for m in b1off b1off-factrows deep deep-factrows; do bash "$0" $m; done ;;
  *) echo "用法: $0 {b1off|b1off-factrows|deep|deep-factrows|all}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[r146] 有 $FAILED 处失败"; exit 1; fi
echo "[r146] OK"
