#!/bin/bash
# #142 采样计划（锚定 rfix-deep105 库，纯读侧重跑；--no-write-steps 保证库不被改写）。
#
# 为什么要「显式钉住 --rerank-blend」：生产 MemoryCore/tdai-gateway.yaml 在 #137-F 之后
# 自带 rerank.blend=0.9，而 bench 以生产 yaml 为底，不传该旗标就会静默继承 0.9——
# 2026-10-28 23:44 的 r142-deep105-norm 就是这样被污染的（本意纯 normalized，实际
# normalized+α0.9）。此后每条采样命令都显式给 blend，报告里 effectiveConfig 才是干净的。
#
# 已知观测（同 judge MiniMax-M3.1-Flash，同一 deep105 库，90 题）：
#   weighted  α=0   （rfix-deep105，16:20 跑，当时生产 yaml 无 blend）  判对 82.2%
#   weighted  α=0.9 （r142-deep105-blend09）                            判对 76.7%  Δ-5.6pp
#   normalized α=0.9（r142-deep105-norm，被污染的档）                    判对 74.4%  Δ-7.8pp
# 假设检验：坐标搜索预计 blend 0→0.9 +6.13pp（4 对样本）→ 实测显著反向，假设否掉；
# normalized 在 α=0 下的净效应仍未测（= 本脚本的 norm0 档）。
#
# 用法: bash scripts/run-r142-sampling.sh [blend09|norm09|norm0|all]
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
SRC="$S/lme90-fix-deep105"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 \
  --b1 --candidate-k 32 --present-temporal --no-write-steps --rerank-candidates 32 --rerank-minscore -10.5"
FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FNORM='{"mode":"normalized","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FAILED=0
[ -d "$SRC" ] || { echo "[r142] 缺少 deep105 库 $SRC"; exit 1; }
run() { local tag="$1"; shift; echo "[r142] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" --report-name "$tag" || { echo "[r142] FAILED $tag"; FAILED=$((FAILED+1)); return 1; }; [ -f "$L/$tag.json" ] || { echo "[r142] FAILED: 未产出 $L/$tag.json"; FAILED=$((FAILED+1)); }; echo "[r142] done $tag $(date +%H:%M:%S)"; }
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r142] 复制库 $SRC → $2"; }
## 对照档：deep105 配置在当前代码上的重跑（16:20 的 rfix-deep105 早于 #137/#138/#141 的读侧改动，
## 直接拿它当基线会把「代码演进」算进旋钮效应；本档给 Δ 一个同时点基线）。
base0() {
  fresh "$SRC" "$S/lme90-r142-deep105-base0"
  run r142-deep105-base0 $COMMON --store "$S/lme90-r142-deep105-base0" --fusion "$FDEF" --rerank-blend 0 \
    --expect-config "recall.rerank.candidates=32,recall.rerank.minScore=-10.5,recall.rerank.blend=0,recall.fusion.mode=weighted"
}
# 每档都带 --expect-config：生效值与档名不符时在灌库前 exit 2，避免「写着 α=0、实际继承 0.9」白跑一档。
GUARD="recall.rerank.candidates=32,recall.rerank.minScore=-10.5"
blend09() {
  fresh "$SRC" "$S/lme90-r142-deep105-blend09"
  run r142-deep105-blend09 $COMMON --store "$S/lme90-r142-deep105-blend09" --fusion "$FDEF" --rerank-blend 0.9 \
    --expect-config "$GUARD,recall.rerank.blend=0.9,recall.fusion.mode=weighted"
}
norm09() {
  fresh "$SRC" "$S/lme90-r142-deep105-norm"
  run r142-deep105-norm $COMMON --store "$S/lme90-r142-deep105-norm" --fusion "$FNORM" --rerank-blend 0.9 \
    --expect-config "$GUARD,recall.rerank.blend=0.9,recall.fusion.mode=normalized"
}
norm0() {
  fresh "$SRC" "$S/lme90-r142-deep105-norm0"
  run r142-deep105-norm0 $COMMON --store "$S/lme90-r142-deep105-norm0" --fusion "$FNORM" --rerank-blend 0 \
    --expect-config "$GUARD,recall.rerank.blend=0,recall.fusion.mode=normalized"
}
case "${1:-norm0}" in
  base0) base0 ;;
  blend09) blend09 ;;
  norm09) norm09 ;;
  norm0) norm0 ;;
  all) base0; blend09; norm09; norm0 ;;
  *) echo "用法: $0 [base0|blend09|norm09|norm0|all]"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[r142] 有 $FAILED 处失败"; exit 1; }
echo "[r142] OK"
