#!/usr/bin/env bash
# #135 R4/精排修复：rerank 保持开启，只修「剪枝过度 + 深池」两个使用问题。
# 前提结论（b0base-mm 复盘）：kept=1 的 27 题（30%）关掉 rerank 可 +35.2pp；kept>=4 的 38 题 rerank 是 -1.3pp（中性）
# -> 问题不在 rerank 本身，而在 minScore=-2/candidates=12 把证据剪到 1-2 行。
# 基线 = b0base（rerank 开）复制库，全开 R1/R2/R3 之后叠加精排修复档。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 口径 candidateK 32 + weighted fusion；未声明的 factChannel / smallToBig /
#    conclusionLayer 与 validity soft 显式关，不让生产 yaml 混进基线。
#  - 每档 --expect-config 连 rerank 池/闸门一起断言（本档改的就是这两个数），
#    --report-name = tag 且报告必须落盘；路径走 STORE_ROOT。
# 用法: bash scripts/run-r135-rerankfix-arms.sh [all|deep105|filter7|filter7deep|deep4|one <extra>]
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/lme90-mm-b0base}"
[ -d "$BASE" ] || { echo "[fix] 缺少基线库 $BASE（先跑 run-mm-baselines.sh b0base-mm 或指定 BASE_STORE）"; exit 1; }

FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
OFF_ERA=("${ARMS_OFF_ERA[@]}")
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --b1 --candidate-k 32 --present-temporal "${OFF_ERA[@]}")
EXPECT="recall.candidateK=32,recall.fusion.mode=weighted,recall.rerank.enabled=true"

deep105() { arms_fresh "$BASE" "$ARMS_ROOT/lme90-fix-deep105"; arms_run rfix-deep105 "${COMMON[@]}" --store "$ARMS_ROOT/lme90-fix-deep105" --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -10.5 --expect-config "$EXPECT,recall.rerank.candidates=32,recall.rerank.minScore=-10.5"; }
deep4()   { arms_fresh "$BASE" "$ARMS_ROOT/lme90-fix-deep4";   arms_run rfix-deep4   "${COMMON[@]}" --store "$ARMS_ROOT/lme90-fix-deep4"   --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -4    --expect-config "$EXPECT,recall.rerank.candidates=32,recall.rerank.minScore=-4"; }
filter7() { arms_fresh "$BASE" "$ARMS_ROOT/lme90-fix-filter7"; arms_run rfix-filter7 "${COMMON[@]}" --store "$ARMS_ROOT/lme90-fix-filter7" --fusion "$FDEF" --rerank-filter-only -7 --rerank-candidates 12 --rerank-minscore -2 --expect-config "$EXPECT,recall.rerank.candidates=12,recall.rerank.minScore=-2"; }
# src 侧 R4（rerank.mode=filter）真实生效档：深池 32 + floor -7 + 保原序。
# 注意：旧的 filter7 只走 bench host 侧 --rerank-filter-only，需 --rerank-child-proc 才生效；本档直接测 src 配置。
filter7deep() { arms_fresh "$BASE" "$ARMS_ROOT/lme90-fix-filter7deep"; arms_run rfix-filter7deep "${COMMON[@]}" --store "$ARMS_ROOT/lme90-fix-filter7deep" --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -7 --rerank-mode filter --expect-config "$EXPECT,recall.rerank.candidates=32,recall.rerank.minScore=-7,recall.rerank.mode=filter"; }
case "${1:-all}" in
  all) deep105; filter7; deep4 ;;
  filter7deep) filter7deep ;;
  deep105) deep105 ;;
  deep4) deep4 ;;
  filter7) filter7 ;;
  one)
    shift
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-fix-one"
    arms_run rfix-one "${COMMON[@]}" --store "$ARMS_ROOT/lme90-fix-one" --fusion "$FDEF" --expect-config "$EXPECT" "$@"
    ;;
  *) echo "用法: $0 [all|deep105|filter7|deep4|one <args>]"; exit 2 ;;
esac
arms_finish
