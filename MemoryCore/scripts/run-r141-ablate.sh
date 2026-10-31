#!/bin/bash
# #141（2026-10-28）消融跑批：主因子表（run-r141-factorial.sh）显示新 W3 分阶段（intent+slot+pairing）
# 判对 80.0%、turnCov 77.8%，**低于**旧档 w3legacy（additive×4）83.3% / 86.1%。
# 差异有三处（预算模式 / 成对约束 / 意图预算），本脚本逐个隔离，回答「是哪一处拖的」，
# 而不是笼统判定「新的不行、回退旧的」。
#
# ⚠ 口径提醒（2026-10-29，#164）：本脚本首跑的档案里，原序加权旋钮（rerank 混合比例）被钉在 0.9，
#   该旋钮与其逻辑已整体移除，重跑只能得到「纯精排」口径——数字预期会与 docs 里当时那张表不同。
#   要复现原读数请 git checkout 8168e1a；历史读数见 docs/optimization-results.md §14（及 §13.5 / §21.1）。
#
# ⚠ 口径钉死（#159 跟票）：本脚本历史上依赖**当时**的生产缺省（fusion normalized / smallToBig on /
#   factChannel on / validity soft；rerank 当时是 12/−2，不是现在的 32/−10.5）。生产 yaml 会变，缺省一变
#   「基线臂」就悄悄换了口径，因此现在每条命令都显式写全这些键，并由 --expect-config 断言生效快照——
#   口径不符直接 exit 2。注意钉的是**现行**值（#145 之后 rerank 32/−10.5），故与 docs 的历史读数
#   不再逐位可比（原读数的 rerank 是 12/−2）。
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

FUSION_NORM='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
COMMON=(
  --dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN"
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-model MiniMax-M2.7 --embed-interval-ms 1200
  --rerank-child-proc --rerank-doc-cap 192
  --rerank-candidates 32 --rerank-minscore -10.5 --fusion "$FUSION_NORM"
)
W1_OFF=(--fact-channel-off)
# --validity-off 只关 excludeInvalidated；mode 仍显式钉 soft（否则快照里跟着生产 yaml 走）。
# 派生值也进 expect（#174）：mode=soft 会盖住 flag=false，只看声明的 false 会误以为这档真的关了；
# 实测派生值仍是 "soft"，即本消融的 W2 轴其实是「软失效」，不是「关」。
W2_OFF=(--validity-off --validity-mode soft)
# 消融 A：新分阶段 + maxExtra 4 —— 主表 w3 臂没传 --conclusion-max-extra，继承了沙箱库的 2，
# 与 w3legacy（显式 4）不是同一口径（实测 w3 s2b.cap=2 / legacy cap=4，每题少 2 条证据行）。
# 这是**负控臂自身的口径 bug**，不是机制结论：本臂把证据帽拉齐到 4，才是「新分阶段 vs 旧档」的公平比较。
W3_X4=(--conclusion-cards --small-to-big --conclusion-routing intent --conclusion-budget-mode slot --conclusion-slot-cost 1.5 --conclusion-pairing require --conclusion-max-extra 4 --conclusion-cap 2)
# 消融 C：W1 事实通道 + 新分阶段（cap 4）——「三机制叠加」在公平口径下的组合臂
W1_ON=(--fact-channel --fact-channel-read-only --fact-channel-weight 0.6)
# 消融 B：只换「路由」——intent + additive×4，其余与旧档一致（不成对、不 slot）→ 隔离意图预算的净效应
# 注：W3_X4 与 W3_ROUTEONLY 的 expect 串逐字节相同——budget-mode / pairing / slot-cost 不在 19 键快照里，
# 「只换路由」的对照前提靠 DRY_RUN 打印的命令行人工核对（快照现 19 键，加派生 effective 键）；结论行上限两臂都显式钉 2（= 继承值 floor(5/2)）。
W3_ROUTEONLY=(--conclusion-cards --small-to-big --conclusion-routing intent --conclusion-budget-mode additive --conclusion-max-extra 4 --conclusion-cap 2)

FAILED=0
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r141a] 复制库 $1 → $2"; }

# 生效快照断言（#159）：先钉公共口径，再按臂追加 W1 一轴。
EXPECT_BASE="recall.candidateK=32,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-10.5,recall.fusion.mode=normalized,recall.validity.mode=soft,recall.excludeInvalidated=false,recall.excludeInvalidated.effective=soft,recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4,recall.conclusionLayer.enabled=true,recall.conclusionLayer.maxConclusions=2"
EXPECT_W1_OFF="recall.factChannel.enabled=false"
EXPECT_W1_ON="recall.factChannel.enabled=true,recall.factChannel.weight=0.6"

# run_arm <arm> <W3 数组名> <W1 数组名> <expect-config>
run_arm() {
  local arm="$1" w3="$2" w1="$3" expect="$4"
  local store="$S/lme90-r141-$arm"
  local -n _f3="$w3"
  local -n _f1="$w1"
  local -a cmd=( $B "${COMMON[@]}" "${_f1[@]}" "${W2_OFF[@]}" "${_f3[@]}" --store "$store" --tag "r141-$arm" --report-name "r141-$arm" --expect-config "$expect" )
  echo "[r141a] start $arm $(date +%H:%M:%S)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[r141a] DRY_RUN: rm -rf $store && cp -r $BASE $store"
    printf '[r141a] DRY_RUN:'; printf ' %q' "${cmd[@]}"; printf '\n'
    return 0
  fi
  fresh "$BASE" "$store" || { echo "[r141a] FAILED: $arm 复制库失败"; FAILED=$((FAILED+1)); return 1; }
  rm -f "$L/r141-$arm.json"   # 先删旧报告：否则上一轮遗留报告会让 -f 断言假绿
  "${cmd[@]}" || { echo "[r141a] FAILED: $arm（eval 非 0）"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/r141-$arm.json" ] || { echo "[r141a] FAILED: $arm 未产出报告"; FAILED=$((FAILED+1)); return 1; }
  echo "[r141a] done $arm $(date +%H:%M:%S)"
}

selected() { [ "$ARMS" = "all" ] && return 0; case " $ARMS " in *" $1 "*) return 0 ;; esac; return 1; }

run_one() {
  case "$1" in
    w3x4)          run_arm w3x4          W3_X4         W1_OFF "$EXPECT_BASE,$EXPECT_W1_OFF" ;;
    w1w3x4)        run_arm w1w3x4        W3_X4         W1_ON  "$EXPECT_BASE,$EXPECT_W1_ON" ;;
    w3routeonly)   run_arm w3routeonly   W3_ROUTEONLY  W1_OFF "$EXPECT_BASE,$EXPECT_W1_OFF" ;;
    *) echo "[r141a] 未知臂: $1"; FAILED=$((FAILED+1)) ;;
  esac
}

echo "[r141a] 消融跑批（W1 关 / W2 关，单进程）$(date +%H:%M:%S)"
for arm in w3x4 w3routeonly w1w3x4; do
  selected "$arm" && run_one "$arm"
done
echo "[r141a] 结束 $(date +%H:%M:%S) FAILED=$FAILED"
exit $FAILED