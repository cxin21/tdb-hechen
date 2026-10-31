#!/usr/bin/env bash
# B2-a 精排三档 A/B（bench/recall-opt S3）：复用基线沙箱库（零重灌），一次一变量。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 基线 = b0-base（rerank candidates 12、minScore -2、candidateK 15、fusion rrf）；
#    生产后来开的 factChannel / smallToBig / conclusionLayer 与 validity soft 一律显式关，
#    否则「基线档」里混进后来机制。
#  - 每档 --expect-config 断言生效配置（含本档改的那个变量），--report-name = tag 且报告必须落盘。
#  - 路径走 STORE_ROOT，不写个人家目录。
# 用法: bash scripts/run-b2a.sh [storeDir]
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

STORE="${1:-$ARMS_ROOT/lme90-mm-b0base}"
[ -d "$STORE" ] || { echo "[b2] 缺少沙箱库 $STORE（本档复用已灌库；先跑 run-mm-baselines.sh 或传入 storeDir）"; exit 1; }
if [ "$#" -gt 0 ]; then shift; fi

ERA=(--candidate-k 15 --fusion "$ARMS_FUSION_RRF" "${ARMS_OFF_ERA[@]}")
EXPECT_ERA="recall.candidateK=15,recall.fusion.mode=rrf"
EXPECT_ERA="$EXPECT_ERA,$ARMS_EXPECT_OFF"
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --store "$STORE" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --rerank-child-proc "${ERA[@]}")

echo "=== [B2-a] start $(date +%H:%M:%S) store=$STORE ==="
# T1 池效应隔离：candidates 12→32，minScore 不动（era -2）
arms_run b2a-pool32 "${COMMON[@]}" --rerank-candidates 32 --rerank-minscore -2 \
  --expect-config "$EXPECT_ERA,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-2" "$@"
# T2 闸门收紧：minScore 0（只留正相关对），池 32
arms_run b2a-ms0 "${COMMON[@]}" --rerank-candidates 32 --rerank-minscore 0 \
  --expect-config "$EXPECT_ERA,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=0" "$@"
# T3 闸门放空：minScore -10.5（近关=只挡全无关），池 32
arms_run b2a-ms105 "${COMMON[@]}" --rerank-candidates 32 --rerank-minscore -10.5 \
  --expect-config "$EXPECT_ERA,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-10.5" "$@"
# T4 关闸对照：rerank.enabled=false（纯 RRF 序），池 32
arms_run b2a-off "${COMMON[@]}" --rerank-off --rerank-candidates 32 \
  --expect-config "$EXPECT_ERA,recall.rerank.enabled=false,recall.rerank.candidates=32" "$@"
echo "=== [B2-a] all tiers done $(date +%H:%M:%S) ==="
arms_finish
