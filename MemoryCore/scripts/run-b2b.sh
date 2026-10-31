#!/usr/bin/env bash
# B2-b 三个变量独立 A/B（bench/recall-opt S5）：复用基线沙箱库（零重灌），一次一变量。
# T5 MMR（λ0.7） / T6 validityNow=题目日期 / T7 向量门槛 0.3→0.15
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 基线 rerank 12/−2、candidateK 15、fusion rrf；后来开的 factChannel / smallToBig /
#    conclusionLayer 与 validity soft 一律显式关。
#  - MMR / emb-threshold / b2b-validity 不在生效配置快照里（只进沙箱 yaml），
#    所以断言覆盖的是本档没动的其余轴 —— 它们自己只能靠日志与 --expect-config 之外的日志核对。
#  - 每档 --report-name = tag 且报告必须落盘；路径走 STORE_ROOT。
# 用法: bash scripts/run-b2b.sh [storeDir]
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
EXPECT="recall.candidateK=15,recall.fusion.mode=rrf"
EXPECT="$EXPECT,$ARMS_EXPECT_OFF"
EXPECT="$EXPECT,recall.rerank.enabled=true,recall.rerank.candidates=12,recall.rerank.minScore=-2"
COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --store "$STORE" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --rerank-child-proc --rerank-candidates 12 --rerank-minscore -2 "${ERA[@]}")

# 先 2 题冒烟（新旗标端到端验证，不进比较）
echo "=== [B2-b] smoke 2 cases $(date +%H:%M:%S) ==="
arms_run b2b-smoke --dataset longmemeval --manifest "$L/lme-manifest.json" --store "$STORE" --keep --pace 150 --limit 2 --recall-ks 1,3,5,10 \
  --rerank-child-proc --rerank-candidates 12 --rerank-minscore -2 "${ERA[@]}" --mmr --b2b-validity --emb-threshold 0.15 \
  --expect-config "$EXPECT"
# T5 MMR 去近重复
arms_run b2b-mmr "${COMMON[@]}" --mmr --expect-config "$EXPECT"
# T6 validityNow=题目日期
arms_run b2b-validity "${COMMON[@]}" --b2b-validity --expect-config "$EXPECT"
# T7 向量余弦门槛放宽
arms_run b2b-eth015 "${COMMON[@]}" --emb-threshold 0.15 --expect-config "$EXPECT"
echo "=== [B2-b] all tiers done $(date +%H:%M:%S) ==="
arms_finish
