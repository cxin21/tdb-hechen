#!/bin/bash
# #141（2026-10-28）消融跑批：主因子表（run-r141-factorial.sh）显示新 W3 分阶段（intent+slot+pairing）
# 判对 80.0%、turnCov 77.8%，**低于**旧档 w3legacy（additive×4）83.3% / 86.1%。
# 差异有三处（预算模式 / 成对约束 / 意图预算），本脚本逐个隔离，回答「是哪一处拖的」，
# 而不是笼统判定「新的不行、回退旧的」。
#
# 用法：
#   ARMS="w3add4 w3nopair" bash scripts/run-r141-ablate.sh
#   DRY_RUN=1 ARMS="w3add4" bash scripts/run-r141-ablate.sh
#
# 注意：与 run-r141-factorial.sh 同禁并发（豆包 embedding 账号级 RPM），必须等主跑批结束。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
BASE="$S/lme90-r137-allon"
GEN="${GEN_LIMIT:-90}"
DRY_RUN="${DRY_RUN:-0}"
ARMS="${ARMS:-all}"

COMMON=(
  --dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN"
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-model MiniMax-M2.7 --embed-interval-ms 1200
  --rerank-blend 0.9 --rerank-child-proc --rerank-doc-cap 192
)
W1_OFF=(--fact-channel-off)
W2_OFF=(--validity-off)
# 消融 A：新分阶段 + maxExtra 4 —— 主表 w3 臂没传 --conclusion-max-extra，继承了沙箱库的 2，
# 与 w3legacy（显式 4）不是同一口径（实测 w3 s2b.cap=2 / legacy cap=4，每题少 2 条证据行）。
# 这是**负控臂自身的口径 bug**，不是机制结论：本臂把证据帽拉齐到 4，才是「新分阶段 vs 旧档」的公平比较。
W3_X4=(--conclusion-cards --small-to-big --conclusion-routing intent --conclusion-budget-mode slot --conclusion-slot-cost 1.5 --conclusion-pairing require --conclusion-max-extra 4)
# 消融 C：W1 事实通道 + 新分阶段（cap 4）——「三机制叠加」在公平口径下的组合臂
W1_ON=(--fact-channel --fact-channel-read-only --fact-channel-weight 0.6)
# 消融 B：只换「路由」——intent + additive×4，其余与旧档一致（不成对、不 slot）→ 隔离意图预算的净效应
W3_ROUTEONLY=(--conclusion-cards --small-to-big --conclusion-routing intent --conclusion-budget-mode additive --conclusion-max-extra 4)

FAILED=0
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r141a] 复制库 $1 → $2"; }

# run_arm <arm> <W3 数组名> [W1 数组名]
run_arm() {
  local arm="$1" w3="$2" w1="${3:-W1_OFF}"
  local store="$S/lme90-r141-$arm"
  local -n _f3="$w3"
  local -n _f1="$w1"
  local -a cmd=( $B "${COMMON[@]}" "${_f1[@]}" "${W2_OFF[@]}" "${_f3[@]}" --store "$store" --tag "r141-$arm" --report-name "r141-$arm" )
  echo "[r141a] start $arm $(date +%H:%M:%S)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[r141a] DRY_RUN: rm -rf $store && cp -r $BASE $store"
    printf '[r141a] DRY_RUN:'; printf ' %q' "${cmd[@]}"; printf '\n'
    return 0
  fi
  fresh "$BASE" "$store" || { echo "[r141a] FAILED: $arm 复制库失败"; FAILED=$((FAILED+1)); return 1; }
  "${cmd[@]}" || { echo "[r141a] FAILED: $arm（eval 非 0）"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/r141-$arm.json" ] || { echo "[r141a] FAILED: $arm 未产出报告"; FAILED=$((FAILED+1)); return 1; }
  echo "[r141a] done $arm $(date +%H:%M:%S)"
}

selected() { [ "$ARMS" = "all" ] && return 0; case " $ARMS " in *" $1 "*) return 0 ;; esac; return 1; }

run_one() {
  case "$1" in
    w3x4)          run_arm w3x4          W3_X4 ;;
    w1w3x4)        run_arm w1w3x4        W3_X4 W1_ON ;;
    w3routeonly)   run_arm w3routeonly   W3_ROUTEONLY ;;
    *) echo "[r141a] 未知臂: $1"; FAILED=$((FAILED+1)) ;;
  esac
}

echo "[r141a] 消融跑批（W1 关 / W2 关，单进程）$(date +%H:%M:%S)"
for arm in w3x4 w3routeonly w1w3x4; do
  selected "$arm" && run_one "$arm"
done
echo "[r141a] 结束 $(date +%H:%M:%S) FAILED=$FAILED"
exit $FAILED