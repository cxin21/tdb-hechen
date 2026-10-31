#!/usr/bin/env bash
# B1 读侧四件套 A/B（bench/recall-opt S4）：复用基线沙箱库（零重灌），只开 --b1。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - 本档 era（9–10 月 b0-base 基线）：rerank 12/−2、candidateK 15、fusion rrf；
#    生产后来开的 factChannel / smallToBig / conclusionLayer 与 validity soft 一律显式关——
#    不关就会继承生产 tdai-gateway.yaml，基线档混进后来机制，数字不可比。
#  - --expect-config 在灌库前比对生效配置（不符 exit 2）；--report-name = tag，报告落盘才算跑完。
#  - 路径走 STORE_ROOT（缺省系统临时目录下的 tdagemem-bench），不写个人家目录。
# 用法: bash scripts/run-b1.sh [storeDir] [额外 runner 参数...]
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

STORE="${1:-$ARMS_ROOT/lme90-mm-b0base}"
if [ "$#" -gt 0 ]; then shift; fi
[ -d "$STORE" ] || { echo "[b1] 缺少沙箱库 $STORE（本档复用已灌库；先跑 run-mm-baselines.sh 或传入 storeDir）"; exit 1; }

# era 口径（显式钉，别让生产 yaml / override 混进来）
ERA=(--candidate-k 15 --fusion "$ARMS_FUSION_RRF" "${ARMS_OFF_ERA[@]}")
EXPECT="recall.rerank.enabled=true,recall.rerank.candidates=12,recall.rerank.minScore=-2"
EXPECT="$EXPECT,recall.candidateK=15,recall.fusion.mode=rrf"
EXPECT="$EXPECT,$ARMS_EXPECT_OFF"

echo "=== [B1] tier=b1 start $(date +%H:%M:%S) store=$STORE ==="
arms_run b1 \
  --dataset longmemeval --manifest "$L/lme-manifest.json" \
  --store "$STORE" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 \
  --rerank-child-proc --rerank-candidates 12 --rerank-minscore -2 \
  --b1 "${ERA[@]}" --expect-config "$EXPECT" "$@"
arms_finish
