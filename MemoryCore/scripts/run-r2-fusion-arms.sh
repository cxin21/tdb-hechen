#!/usr/bin/env bash
# #135 R2/E1：加权融合 LME90 档位跑批（配对 vs 既有 b0base-mm RRF 基线）。
# 每档 = 基线库复制 + recall.fusion 沙箱 yaml 注入（--fusion JSON）。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 基线 rerank 12/−2；未声明的 factChannel / smallToBig / conclusionLayer 与 validity soft
#    显式关；candidateK 逐档显式写（本档变量是 fusion，别让生产 candidateK 32 混进来）。
#  - 每档 --expect-config 断言 fusion.mode + candidateK + 关掉的三轴；--report-name = tag
#    且报告必须落盘；路径走 STORE_ROOT，不写个人家目录。
# 用法: bash scripts/run-r2-fusion-arms.sh [default|grid|one <json> <tag>]
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/longmemeval-oracle-mvphl2m1}"
[ -d "$BASE" ] || { echo "[r2] 缺少基线库 $BASE（先跑 run-mm-baselines.sh 或指定 BASE_STORE）"; exit 1; }

OFF_ERA=("${ARMS_OFF_ERA[@]}")
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --rerank-child-proc --rerank-candidates 12 --rerank-minscore -2 "${OFF_ERA[@]}")
EXPECT_OFF="recall.rerank.enabled=true,recall.rerank.candidates=12,recall.rerank.minScore=-2"
EXPECT_OFF="$EXPECT_OFF,$ARMS_EXPECT_OFF"

FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FREC='{"mode":"weighted","dense":0.3,"bm25":0.3,"recency":0.3,"validity":0.1,"recencyHalfLifeDays":14}'
FVAL='{"mode":"weighted","dense":0.3,"bm25":0.3,"recency":0.1,"validity":0.3,"recencyHalfLifeDays":30}'
case "${1:-default}" in
  default)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-wdef"
    arms_run r2-wdef "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-wdef" --candidate-k 15 --fusion "$FDEF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=weighted"
    ;;
  grid)
    for pair in "wdef:$FDEF" "wrec:$FREC" "wval:$FVAL"; do
      tag="${pair%%:*}"; json="${pair#*:}"
      arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-$tag"
      arms_run "r2-$tag" "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-$tag" --candidate-k 15 --fusion "$json" \
        --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=weighted"
    done
    ;;
  # #135 全开档：candidateK=32 + weighted fusion wdef + presentTemporal（R1+R2+R3 同时开）
  allon)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-allon"
    arms_run r2-allon "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-allon" --candidate-k 32 --present-temporal --fusion "$FDEF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=32,recall.fusion.mode=weighted"
    ;;
  # #135 全开 + 消融：allon(R1+R2+R3) → r1only(candidateK) → r3only(presentTemporal)
  ablate)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-allon"
    arms_run r2-allon "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-allon" --candidate-k 32 --present-temporal --fusion "$FDEF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=32,recall.fusion.mode=weighted"
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-r1only"
    arms_run r2-r1only "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-r1only" --candidate-k 32 --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=32,recall.fusion.mode=rrf"
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-r3only"
    arms_run r2-r3only "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-r3only" --candidate-k 15 --present-temporal --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.candidateK=15,recall.fusion.mode=rrf"
    ;;
  one)
    shift
    [ "$#" -ge 2 ] || { echo "用法: $0 one <fusion-json> <tag>"; exit 2; }
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r2-$2"
    # one 是逃生口：只钉住三轴关闭与 candidateK，融合模式交给调用者（否则 normalized 等会误判 exit 2）
    arms_run "r2-$2" "${COMMON[@]}" --store "$ARMS_ROOT/lme90-r2-$2" --candidate-k 15 --fusion "$1" \
      --expect-config "$EXPECT_OFF,recall.candidateK=15"
    ;;
  *) echo "用法: $0 [default|grid|one <json> <tag>]"; exit 2 ;;
esac
arms_finish
echo "[r2] 汇总: node scripts/fit-fusion-weights.mjs compare --base <b0base.json> --arm r2-wdef=<arm.json>"
