#!/bin/bash
# #138（2026-10-28）W3 预算归属 × maxExtraLines 扫参（结论层与经验层的槽位竞争修复验证）。
#
# 背景（生产 journal + bench 复核，见 docs/optimization-results.md §14）：
#   - 生产 2485 条召回：结论层命中 49.6%，其中经验层 ≤1 行 98.4%；smallToBig 回捞触发率 0.2%；
#   - bench 同型：W3×4 下 36.7% 的题经验层 ≤1 行，single-session-assistant cov −13.3pp；
#   - 根因不是「结论卡无用」，而是①上下文行与结论行共同挤经验层配额（零和替换）、
#     ②回捞证据按 store 返回序选，常把前情行排在承载答案的轮次之前。
#
# 本脚本只扫读侧三旋钮（不改写侧、不改 yaml 生产）：
#   budget=additive（上下文行不挤经验层保底）× maxExtraLines ∈ {2,4,6}
#   另跑 shared（逐位现状）+ 新排序档做对照。
#
# 用法: bash scripts/run-r138-arms.sh [all|add2|add4|add6|shared4|shared4-legacy]
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
# 可移植（#139 第7项）：沙箱库根目录不再硬编码 git-bash 路径；STORE_ROOT / TMPDIR 任一可覆盖。
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
BASE="$S/lme90-r137-allon"   # #137 全开档：事实通道 + W2 契约 + W3 结论卡 + soft + deep 候选池
GEN="${GEN_LIMIT:-90}"
FUSION='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit $GEN \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-channel --fact-channel-read-only --fact-channel-weight 0.6 \
  --conclusion-cards --small-to-big --validity-mode soft \
  --fact-model MiniMax-M2.7 --embed-interval-ms 1200 --rerank-blend 0.9 \
  --rerank-child-proc --rerank-doc-cap 192"
FAILED=0
run() {
  local tag="$1"; shift
  echo "[r138] start $tag $(date +%H:%M:%S)"
  # #139 第7项：报告名钉死为 tag（并行跑不会串味），且「没产出报告」也算失败（非 0 链式断言）。
  $B "$@" --tag "$tag" --report-name "$tag" || { echo "[r138] FAILED: $tag"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/$tag.json" ] || { echo "[r138] FAILED: $tag 未产出报告 $L/$tag.json"; FAILED=$((FAILED+1)); return 1; }
  echo "[r138] done $tag $(date +%H:%M:%S)"
}
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r138] 复制库 $1 → $2"; }
[ -d "$BASE" ] || { echo "[r138] 缺少基线库 $BASE"; exit 1; }
case "${1:-all}" in
  # #135 第1项：每档都带 --expect-config 断言沙箱 yaml 真的生效（生产 config-override.json 会覆盖它）。
  add2) fresh "$BASE" "$S/lme90-r138-add2"; run r138-add-x2 $COMMON --fusion "$FUSION" --store "$S/lme90-r138-add2" --conclusion-budget-mode additive --conclusion-max-extra 2 --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=additive,recall.smallToBig.maxExtraLines=2" ;;
  add4) fresh "$BASE" "$S/lme90-r138-add4"; run r138-add-x4 $COMMON --fusion "$FUSION" --store "$S/lme90-r138-add4" --conclusion-budget-mode additive --conclusion-max-extra 4 --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=additive,recall.smallToBig.maxExtraLines=4" ;;
  add6) fresh "$BASE" "$S/lme90-r138-add6"; run r138-add-x6 $COMMON --fusion "$FUSION" --store "$S/lme90-r138-add6" --conclusion-budget-mode additive --conclusion-max-extra 6 --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=additive,recall.smallToBig.maxExtraLines=6" ;;
  shared4) fresh "$BASE" "$S/lme90-r138-shared4"; run r138-shared-x4 $COMMON --fusion "$FUSION" --store "$S/lme90-r138-shared4" --conclusion-budget-mode shared --conclusion-max-extra 4 --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=shared,recall.smallToBig.maxExtraLines=4" ;;
  shared4-legacy) fresh "$BASE" "$S/lme90-r138-shared4-legacy"; run r138-shared-x4-legacy $COMMON --fusion "$FUSION" --store "$S/lme90-r138-shared4-legacy" --conclusion-budget-mode shared --conclusion-max-extra 4 --conclusion-legacy-rank --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=shared" ;;
  add4-route) fresh "$BASE" "$S/lme90-r138-add4-route"; run r138-add-x4-route $COMMON --fusion "$FUSION" --store "$S/lme90-r138-add4-route" --conclusion-budget-mode additive --conclusion-max-extra 4 --conclusion-routing assistant-recall --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.budget=additive" ;;
  all) for m in add2 add4 add6; do bash "$0" $m || FAILED=$((FAILED+1)); done ;;
  *) echo "用法: $0 {add2|add4|add6|add4-route|shared4|shared4-legacy|all}"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[r138] 有 $FAILED 处失败"; exit 1; }
echo "[r138] OK"