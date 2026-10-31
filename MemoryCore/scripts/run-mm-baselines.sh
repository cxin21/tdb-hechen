#!/usr/bin/env bash
# #134 基线重跑（MiniMax 判分对齐）：b1-off 与 b0-base。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 基线 candidateK 15、fusion rrf；后来开的 factChannel / smallToBig / conclusionLayer
#    与 validity soft 一律显式关；rerank 两档分别是"关"与"12/−2"。
#  - 每档 --expect-config 断言生效配置，--report-name = tag 且报告必须落盘。
#  - 基线库路径走 BASE_STORE 或 STORE_ROOT（缺省系统临时目录下的 tdagemem-bench）。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/longmemeval-oracle-mvphl2m1}"
ERA=(--candidate-k 15 --fusion "$ARMS_FUSION_RRF" "${ARMS_OFF_ERA[@]}")
EXPECT="recall.candidateK=15,recall.fusion.mode=rrf"
EXPECT="$EXPECT,$ARMS_EXPECT_OFF"
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 "${ERA[@]}")

arms_fresh "$BASE" "$ARMS_ROOT/lme90-mm-b1off"
arms_fresh "$BASE" "$ARMS_ROOT/lme90-mm-b0base"

arms_run b1off-mm "${COMMON[@]}" --store "$ARMS_ROOT/lme90-mm-b1off" --rerank-off --b1 \
  --expect-config "$EXPECT,recall.rerank.enabled=false"
arms_run b0base-mm "${COMMON[@]}" --store "$ARMS_ROOT/lme90-mm-b0base" --rerank-child-proc --rerank-candidates 12 --rerank-minscore -2 \
  --expect-config "$EXPECT,recall.rerank.enabled=true,recall.rerank.candidates=12,recall.rerank.minScore=-2"
arms_finish
