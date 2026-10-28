#!/bin/bash
# #139（2026-10-28）第5项：W3 写/读开关拆分的归因档。
#
# 背景：旧实现 --conclusion-cards 一个开关同时打开两件事——
#   ① 写入面：蒸馏结论卡（work_fact）+ part_of 证据链落库；
#   ② 读侧回捞：recall.smallToBig（结论卡带出源证据行）。
# 因此 w3b 相对 b1-off 的 +10pp 无法拆归因（到底是"卡本身有用"还是"回捞把证据找回来了"）。
#
# 现在拆成两个独立开关，本脚本在**同一个库**上跑两档，只改读侧配置（零重灌、零写侧外呼）：
#   w3-write-only : --conclusion-cards（写面向后兼容；库里已有结论卡）      → smallToBig 关
#   w3-read       : --conclusion-cards --small-to-big --small-to-big-max-extra 4 → smallToBig 开
#
# 两档都带 --expect-config 断言（#135 第1项）：生产 data/config-override.json 里的
# rerank/smallToBig 会覆盖沙箱 yaml，不校验就会白跑一档。
#
# 缺省 retrieval-only（GEN_LIMIT=0）——只比召回覆盖率，零生成/判分外呼，几分钟出表；
# 要判对指标（genCorrect）用 GEN_LIMIT=90（成本 ≈ 两档 × 90 题）。
#
# 用法:
#   bash scripts/run-139-w3split.sh [both|write|read|gates]
#   STORE=/tmp/tdagemem-bench/lme90-r137-allon GEN_LIMIT=90 bash scripts/run-139-w3split.sh both
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
G="node --import tsx scripts/bench-gates.mjs"
L=.eval-data/bench
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
# 缺省库：r138-add4（#137 全开基线 + 结论卡已落库 + smallToBig 4 行），本机现成，免重灌。
STORE="${STORE:-$S/lme90-r138-add4}"
GEN="${GEN_LIMIT:-0}"
FUSION='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit $GEN \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-channel --fact-channel-read-only \
  --fact-channel-weight 0.6 --conclusion-cards --validity-mode soft --fact-model MiniMax-M2.7 \
  --embed-interval-ms 1200 --rerank-blend 0.9 --rerank-child-proc --rerank-doc-cap 192 \
  --no-write-steps"
FAILED=0
if [ ! -d "$STORE" ]; then
  echo "[139] 缺少沙箱库 $STORE（用 STORE=<path> 指定；需已灌库且含结论卡）"
  exit 1
fi
run() {  # run <tag> [args...] —— 报告名钉死为 tag，不做"全局最新"猜测（并行跑会串味）
  local tag="$1"; shift
  echo "[139] start $tag $(date +%H:%M:%S)"
  if ! $B "$@" --tag "$tag" --report-name "$tag"; then
    echo "[139] FAILED: $tag"
    FAILED=$((FAILED + 1))
    return 1
  fi
  if [ ! -f "$L/$tag.json" ]; then
    echo "[139] FAILED: $tag 未产出报告（$L/$tag.json）"
    FAILED=$((FAILED + 1))
    return 1
  fi
  echo "[139] done $tag（报告 → $L/$tag.json）$(date +%H:%M:%S)"
}
do_write() {
  # --small-to-big-off 必须有：复用库继承了上一档 yaml 的 smallToBig.enabled=true，
  # 只「不加 --small-to-big」等于没关（--expect-config 会立刻抓出来）。
  run 139-w3-write-only $COMMON \
    --fusion "$FUSION" --store "$STORE" --keep --small-to-big-off \
    --expect-config "recall.smallToBig.enabled=false"
}
do_control() {
  # 无卡基线：连结论层注入一起关（--conclusion-layer-off），环比「卡没用」还是「卡挤掉了预算」。
  run 139-w3-control $COMMON \
    --fusion "$FUSION" --store "$STORE" --keep --small-to-big-off --conclusion-layer-off \
    --expect-config "recall.smallToBig.enabled=false,recall.conclusionLayer.enabled=false"
}
do_read() {
  run 139-w3-read $COMMON \
    --fusion "$FUSION" --store "$STORE" --keep --small-to-big --small-to-big-max-extra 4 \
    --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4"
}
case "${1:-both}" in
  write) do_write ;;
  read) do_read ;;
  control) do_control ;;
  both) do_write; do_read ;;
  all) do_control; do_write; do_read ;;
  gates)   # 归因表：两档配对门禁（门禁1/2 需要 genCorrect 才有意义，retrieval-only 时只读覆盖率）
    if [ ! -f "$L/139-w3-write-only.json" ] || [ ! -f "$L/139-w3-read.json" ]; then
      echo "[139] 先跑 both 生成两档报告"
      exit 1
    fi
    # control→write-only：卡本身有没有用（无卡基线 vs 有卡无回捞）。
    # 缺报告只报 SKIP；报告在则门禁 FAIL 必须累加，不能被 || true 吞成 exit 0（假绿）。
    if [ -f "$L/139-w3-control.json" ]; then
      $G "$L/139-w3-control.json" "$L/139-w3-write-only.json" || FAILED=$((FAILED + 1))
    else
      echo "[139] SKIP control 配对：缺 $L/139-w3-control.json（先跑 $0 control）"
    fi
    $G "$L/139-w3-write-only.json" "$L/139-w3-read.json" || FAILED=$((FAILED + 1))
    ;;
  *) echo "用法: $0 {all|both|control|write|read|gates}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[139] 有 $FAILED 处失败"; exit 1; fi
echo "[139] OK"
