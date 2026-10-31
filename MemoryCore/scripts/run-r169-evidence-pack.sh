#!/bin/bash
# #169（2026-10-31）证据包（recall.evidencePack）四档扫参：+0（对照）/ +1 / +2 / +3 行邻接。
#
# 要回答的问题（票面）：「命中行 + 同会话相邻窗」能不能在不改存储、不改召回候选集的前提下，
# 让注入块里带上「答案就在命中行隔壁」的上下文。
#
# 实测依据（D:/TDB/data/vectors.db，3514 行 / 975 session，只读统计）：
#   - 每 session 行数 p50=1 / p90=2 / p99=83；864/975 是单行 session（这些题四档应当零差异）
#   - 同 session 相邻行 |Δt| ≤30min 占 78.3%，>120min 占 11%
#   - 相邻行 scene_name 不同占 40.8% ⇒ 纯位置邻接会把别的话题拖进来，时间窗是硬约束
#
# 口径（防自我污染，Lead m00790 硬要求）：
#   - pack 行只进注入块，不进 memoryLines/候选集 ⇒ turnCov/sessionCov 由 seed 行决定，不被扩行刷高；
#   - 报告里 injectionAdjacency 单列 adjacencyLines/skippedWindow/skippedCap，并与覆盖率分开读；
#   - +0 档必须与改动前逐位一致（代码里 enabled=false 时整段不进，有单测钉死）。
#
# 用法: bash scripts/run-r169-evidence-pack.sh [all|x0|x1|x2|x3]
#      DRY_RUN=1 … 只打印每档命令行（不建库、不调模型、不写报告），用于验证脚本本身可执行。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
BASE="${EP_BASE:-$S/lme90-r137-allon}"   # 与 r138 同源基线库（写面已就绪）
GEN="${GEN_LIMIT:-90}"
FUSION='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
# 读侧档：--no-write-steps 不动库（证据包本身零写入）
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit $GEN \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-channel --fact-channel-read-only --fact-channel-weight 0.6 \
  --conclusion-cards --small-to-big --validity-mode soft \
  --fact-model MiniMax-M2.7 --embed-interval-ms 1200 \
  --rerank-child-proc --rerank-doc-cap 192 --store $BASE --no-write-steps"
FAILED=0
DRY_RUN="${DRY_RUN:-0}"
run() {
  local tag="$1"; shift
  echo "[r169] start $tag $(date +%H:%M:%S)"
  if [ "$DRY_RUN" = "1" ]; then
    # 干跑：只回显命令行（含 --evidence-pack / --expect-config 两个 #169 新旗标），不碰库与模型
    printf '[r169] DRY_RUN %s:' "$tag"; printf ' %q' $B "$@" --tag "$tag" --report-name "$tag"; printf '\n'
    return 0
  fi
  $B "$@" --tag "$tag" --report-name "$tag" || { echo "[r169] FAILED: $tag"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/$tag.json" ] || { echo "[r169] FAILED: $tag 未产出报告 $L/$tag.json"; FAILED=$((FAILED+1)); return 1; }
  # 报告必须带 #169 口径段——缺字段就说明旗标没生效（静默降级是这堆票的老病）
  grep -q '"injectionAdjacency"' "$L/$tag.json" || { echo "[r169] FAILED: $tag 报告缺 injectionAdjacency"; FAILED=$((FAILED+1)); return 1; }
  echo "[r169] done $tag $(date +%H:%M:%S)"
}
if [ ! -d "$BASE" ] && [ "$DRY_RUN" != "1" ]; then
  echo "[r169] 缺少基线库 $BASE（先跑 run-r138-arms.sh 建库，或设 EP_BASE）"; exit 1
fi
case "${1:-all}" in
  x0) run r169-x0 $COMMON --fusion "$FUSION" --evidence-pack 0 --expect-config "recall.evidencePack.enabled=false" ;;
  x1) run r169-x1 $COMMON --fusion "$FUSION" --evidence-pack 1 --expect-config "recall.evidencePack.enabled=true,recall.evidencePack.adjacent=1" ;;
  x2) run r169-x2 $COMMON --fusion "$FUSION" --evidence-pack 2 --expect-config "recall.evidencePack.enabled=true,recall.evidencePack.adjacent=2" ;;
  x3) run r169-x3 $COMMON --fusion "$FUSION" --evidence-pack 3 --expect-config "recall.evidencePack.enabled=true,recall.evidencePack.adjacent=3" ;;
  all) for m in x0 x1 x2 x3; do bash "$0" $m || FAILED=$((FAILED+1)); done ;;
  *) echo "用法: $0 {x0|x1|x2|x3|all}"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[r169] 有 $FAILED 处失败"; exit 1; }
echo "[r169] OK"
