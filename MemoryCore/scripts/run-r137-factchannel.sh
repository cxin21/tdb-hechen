#!/bin/bash
# #137（W1/C 事实键平行通道）配对档：原文键主索引 l1_vec 不动 + 事实短语键另写 l1_fact_vec，
# 召回侧按沙箱 yaml 的 recall.factChannel 融合（权重缺省 0.6）。
#  - control = b1off 基线库复制 + --fact-extract（只读事实缓存，不写通道）→ 配对控制组
#  - fc      = control + --fact-channel（分阶段写入：只对有事实的 turn 补写通道向量，零重灌）
#  - fc-norm = fc + --fusion normalized（dense 0.5 / bm25 0.2 / fact 0.3；#137 读侧融合新模式）
# 配对前提：同 manifest / 同 judge / 同 --gen-limit 90；每档从 BASE 复制库 → --store 复用零重灌。
# 事实抽取走 .eval-data/bench/facts-cache（--fact-model 必须与缓存同模型，否则重抽 = 全量 LLM 账单）。
#  fc-ro   = 在 fc 已灌好的库上**只重跑读侧**（--fact-channel-read-only，零 embedding 外呼）——
#            迭代融合权重/模式用；读侧代码有修复时要靠它把旧写库重新量一遍。
# 用法: bash scripts/run-r137-factchannel.sh {control|fc|fc-ro|fc-norm|all|one <extra-args...>}
# 先解析脚本绝对目录再 cd：all 模式要递归调用自身，相对 $0 会在 cd 后失效。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMP="${TMPDIR:-/tmp}"
BASE="${BASE_STORE:-/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/lme90-mm-b1off}"
# STORE_ROOT 缺省 = BASE 的父目录（别再拿 $TMP 猜——Windows 的 TEMP 与 /tmp 不是一个地方，
# 曾导致 fc-ro 找不到刚写好的库）
STORE_ROOT="${STORE_ROOT:-$(dirname "$BASE")}"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-off --b1 --candidate-k 32 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
FC="--fact-channel --fact-channel-weight 0.6 --fact-max-facts 5"
FCNORM='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
FAILED=0
run() {
  local tag="$1"; shift
  echo "[r137] start $tag $(date +%H:%M:%S)"
  $B "$@" --tag "$tag" || { echo "[r137] FAILED: $tag"; FAILED=$((FAILED+1)); }
  echo "[r137] done $tag $(date +%H:%M:%S)"
}
fresh_from() {
  [ -d "$1" ] || { echo "[r137] 缺少源库 $1（先跑 bash scripts/run-r135-off-arms.sh allon，或用 BASE_STORE 指定）"; exit 1; }
  mkdir -p "$(dirname "$2")"
  rm -rf "$2"
  cp -r "$1" "$2"
  echo "[r137] 复制库 $1 → $2"
}
case "${1:-help}" in
  control)
    fresh_from "$BASE" "$STORE_ROOT/lme90-r137-control"
    run r137-control $COMMON --store "$STORE_ROOT/lme90-r137-control"
    ;;
  fc)
    fresh_from "$BASE" "$STORE_ROOT/lme90-r137-fc"
    run r137-fc $COMMON --store "$STORE_ROOT/lme90-r137-fc" $FC
    ;;
  # fc-ro：复用 fc 写好的库，只重跑读侧（读侧代码改动后重测的正确姿势，零外呼）
  fc-ro)
    [ -d "$STORE_ROOT/lme90-r137-fc" ] || { echo "[r137] 缺 $STORE_ROOT/lme90-r137-fc（先跑 fc 档）"; exit 1; }
    run r137-fc-ro $COMMON --store "$STORE_ROOT/lme90-r137-fc" $FC --fact-channel-read-only
    ;;
  # fc-norm 与 fc 同写侧（都从 BASE 复制 + 分阶段写通道向量），只差读侧融合模式；
  # 通道表写入幂等，三档彼此独立、无运行顺序依赖。
  fc-norm)
    fresh_from "$BASE" "$STORE_ROOT/lme90-r137-fc-norm"
    run r137-fc-norm $COMMON --store "$STORE_ROOT/lme90-r137-fc-norm" $FC --fusion "$FCNORM"
    ;;
  all)
    for m in control fc fc-ro fc-norm; do
      bash "$SCRIPT_DIR/$(basename "$0")" "$m" || FAILED=$((FAILED+1))
    done
    ;;
  one)
    shift
    fresh_from "$BASE" "$STORE_ROOT/lme90-r137-one"
    run r137-one $COMMON --store "$STORE_ROOT/lme90-r137-one" "$@"
    ;;
  *)
    echo "用法: $0 {control|fc|fc-ro|fc-norm|all|one <extra-args...>}"
    exit 2
    ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[r137] 有 $FAILED 处失败"; exit 1; fi
echo "[r137] OK — 配对比较: node scripts/bench-compare.mjs <control.json> <fc.json>"
