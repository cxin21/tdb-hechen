#!/usr/bin/env bash
# #135 全开档（rerank-off 基线）：R1 candidateK + R2 加权融合 + R3 查询时间感知，逐项消融。
# 基线 = b1off-mm（lme90-mm-b1off：rerank 关断 + --b1），复制库跑档零重灌。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - 本档 era 未声明的机制一律显式关：--fact-channel-off / --small-to-big-off /
#    --conclusion-layer-off / --validity-mode hard；candidateK 与 fusion 逐档显式写，
#    不让生产 yaml（factChannel on、candidateK 32、fusion normalized、validity soft）混进来。
#  - 每档 --expect-config 断言（含本档各自开的那一轴），--report-name = tag 且报告必须落盘。
#  - 路径走 STORE_ROOT，不写个人家目录。
# 用法: bash scripts/run-r135-off-arms.sh [allon|ablate|one <extra-args...>]
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/lme90-mm-b1off}"
[ -d "$BASE" ] || { echo "[r135] 缺少基线库 $BASE（先跑 run-mm-baselines.sh b1off-mm 或指定 BASE_STORE）"; exit 1; }

FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
OFF_ERA=("${ARMS_OFF_ERA[@]}")
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --b1 --rerank-off "${OFF_ERA[@]}")
EXPECT_OFF="recall.rerank.enabled=false"
EXPECT_OFF="$EXPECT_OFF,$ARMS_EXPECT_OFF"

allon() {
  arms_fresh "$BASE" "$ARMS_ROOT/lme90-r135-allon"
  arms_run r135-allon "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r135-allon" --candidate-k 32 --present-temporal --fusion "$FDEF" \
    --expect-config "$EXPECT_OFF,recall.candidateK=32,recall.fusion.mode=weighted"
}
case "${1:-allon}" in
  allon) allon ;;
  ablate)
    allon
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r135-r1"
    arms_run r135-r1 "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r135-r1" --candidate-k 32 --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=32,recall.fusion.mode=rrf"
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r135-r3"
    arms_run r135-r3 "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r135-r3" --candidate-k 15 --present-temporal --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=rrf"
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r135-fus"
    arms_run r135-fus "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r135-fus" --candidate-k 15 --fusion "$FDEF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=weighted"
    ;;
  one)
    shift
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r135-one"
    arms_run r135-one "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r135-one" --candidate-k 15 --fusion "$ARMS_FUSION_RRF" --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=rrf" "$@"
    ;;
  *) echo "用法: $0 [allon|ablate|one <args>]"; exit 2 ;;
esac
arms_finish
echo "[r135] 配对: node scripts/fit-fusion-weights.mjs compare --base .eval-data/bench/<b1off-mm.json> --arm allon=<arm.json>"
