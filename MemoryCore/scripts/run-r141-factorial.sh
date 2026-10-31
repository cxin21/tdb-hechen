#!/bin/bash
# #141（2026-10-28）三因子设计跑批：W1 事实通道 × W2 效期 × W3 结论层 = 13 臂（12 格 + 生产锚点）。
#
# 要回答的问题：单档各自有收益，但**组合是否真的 1+1>2**？历史口径是拿组合档比基座，
# 于是「组合 > 基座」被当成「组合 > 单档」。本脚本把每一格都跑出来，判定交给
# scripts/bench-factorial.mjs（组合臂只跟「单档最好」比，Δ 判对率 95%CI 下界 > 0 才算协同）。
#
# 结构照 run-r138-arms.sh：
#   - 每臂 fresh copy 基线库（只补写差异），--tag/--report-name 钉死为 r141-<arm>；
#   - 末尾非 0 退出（任一步失败或没产出报告都算失败）；
#   - DRY_RUN=1 只打印命令不执行；ARMS="b0 w1w3" 只跑指定臂（空格分隔，缺省 all）。
#
# ⚠ 口径提醒（2026-10-29，#164）：本脚本首跑的档案里，原序加权旋钮（rerank 混合比例）被钉在 0.9，
#   该旋钮与其逻辑已整体移除，重跑只能得到「纯精排」口径——数字预期会与 docs 里当时那张表不同。
#   要复现原读数请 git checkout 8168e1a；历史读数见 docs/optimization-results.md §14（及 §13.5 / §21.1）。
#
# ⚠ 口径钉死（#159 跟票）：除下面三个因子轴外，其余键（fusion / rerank / candidateK / 结论证据帽 / 结论行上限）
#   都显式写进 COMMON 或各 W3 档并逐臂断言生效快照；失效轴也把继承来的小开关关掉（W3_OFF 同时
#   --small-to-big-off，W2_OFF 显式 --validity-mode soft）。生产 yaml 变化时断言会先 exit 2。
#   注意：钉的是**现行**生产缺省（#145 之后的 rerank 32/−10.5、candidateK 32），不是 10-28 首跑时的
#   era 值（当时 rerank 12/−2、candidateK 12），因此与 docs §14 的历史读数不逐位可比。
#
# 用法:
#   bash scripts/run-r141-factorial.sh            # 跑全部 13 臂 + 出判定表
#   DRY_RUN=1 ARMS=b0 bash scripts/run-r141-factorial.sh   # 只看命令（不碰库、不耗配额）
#
# 注意：真跑会消耗 embedding / 判分配额（GEN_LIMIT 默认 90 题 × 13 臂）。单测/联调请用 DRY_RUN。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
# 可移植（#139 第7项）：沙箱库根目录不硬编码 git-bash 路径；STORE_ROOT / TMPDIR 任一可覆盖。
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
BASE="$S/lme90-r137-allon"   # #137 全开档：作为「两两组合」的共同底座（每臂 fresh copy 后只改差异）
GEN="${GEN_LIMIT:-90}"
DRY_RUN="${DRY_RUN:-0}"
ARMS="${ARMS:-all}"

# 每臂都带（因子旗标一律显式写全，不依赖缺省——缺省随生产 yaml 变，会让「关」变成「开」）。
FUSION_NORM='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
COMMON=(
  --dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN"
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 --fact-model MiniMax-M2.7 --embed-interval-ms 1200
  --rerank-child-proc --rerank-doc-cap 192
  --rerank-candidates 32 --rerank-minscore -10.5 --fusion "$FUSION_NORM"
)

# ── 三个因子 ──
# W1 事实通道：开 / 关
W1_ON=(--fact-channel --fact-channel-read-only --fact-channel-weight 0.6)
W1_OFF=(--fact-channel-off)
# W2 效期：硬 / 软 / 关（--validity-off 关掉失效排除 excludeInvalidated，不排也不降权）。
# 关档改的是 recall 根级 excludeInvalidated，不是 validity.mode，所以 expect 里两个键都要写：
# 少了 excludeInvalidated，b0 与 w2s 的 expect 串会一模一样，w2s 的关档退化成静默复制。
W2_HARD=(--validity-mode hard)
W2_SOFT=(--validity-mode soft)
W2_OFF=(--validity-off --validity-mode soft)
# W3 结论层：关 / 传统（#141 原 W3 读数锚点，叠了 W1 关 + validity 关）/ 新分阶段
# W3_OFF 同时显式关 small-to-big（回捞属结论层机制；历史上它是蹭生产缺省开的，口径不干净）。
W3_OFF=(--conclusion-layer-off --small-to-big-off)
# 结论行上限显式钉 2（= 继承值 floor(5/2)=2，读数不变；钉 5 会直接翻倍预算，别照抄 r146c wide 档；不钉的话生产 maxResults 一漂就静默改预算，
# 而它正是 §15.7 自陈的「w3b 不可复现」元凶之一）。
W3_LEGACY=(--conclusion-cards --small-to-big --conclusion-budget-mode additive --conclusion-max-extra 4 --conclusion-cap 2)
# W3_NEW 显式补齐证据帽 4：原 #141 首跑没传，继承了当时的缺省 2（比 w3legacy 少 2 条证据行），
# 属负控臂自身的口径 bug（见 run-r141-ablate.sh 消融 A 的说明），这里拉齐后才与 w3legacy 同帽比较。
W3_NEW=(--conclusion-cards --small-to-big --conclusion-routing intent --conclusion-budget-mode slot --conclusion-slot-cost 1.5 --conclusion-pairing require --conclusion-max-extra 4 --conclusion-cap 2)
# 注：W3_LEGACY 与 W3_NEW 的 expect 串逐字节相同——两臂真正的差异（budget-mode / pairing / slot-cost）
# 不在 19 键快照里，快照区分不了它们；要核对消融是否真换了轴，看 DRY_RUN 打印的命令行。

FAILED=0

fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[r141] 复制库 $1 → $2"; }

# 生效快照断言（#159）：三个轴各一组，臂 = 公共 × W1 × W2 × W3。
EXPECT_BASE="recall.candidateK=32,recall.rerank.enabled=true,recall.rerank.candidates=32,recall.rerank.minScore=-10.5,recall.fusion.mode=normalized"
EXPECT_W1_ON="recall.factChannel.enabled=true,recall.factChannel.weight=0.6"
EXPECT_W1_OFF="recall.factChannel.enabled=false"
EXPECT_W2_HARD="recall.validity.mode=hard,recall.excludeInvalidated=true,recall.excludeInvalidated.effective=hard"
EXPECT_W2_SOFT="recall.validity.mode=soft,recall.excludeInvalidated=true,recall.excludeInvalidated.effective=soft"
# #174 定序已修：显式关优先于 mode——flag=false 派生 "false"（真正关断），不再被 soft 吞成 "soft"。
# 本行随即同步：断言派生值 false。若这里回退成 "soft"，说明 excludeInvalidatedFor 的定序又被改坏
# （旧 bug 会让 --validity-off 在 soft 配置下与 w2s 臂同配置，白跑一档且看不出来）。
EXPECT_W2_OFF="recall.validity.mode=soft,recall.excludeInvalidated=false,recall.excludeInvalidated.effective=false"
EXPECT_W3_OFF="recall.conclusionLayer.enabled=false,recall.smallToBig.enabled=false"
EXPECT_W3_LEGACY="recall.conclusionLayer.enabled=true,recall.conclusionLayer.maxConclusions=2,recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4"
EXPECT_W3_NEW="$EXPECT_W3_LEGACY"

# run_arm <arm> <W1 数组名> <W2 数组名> <W3 数组名> [expect-config]
run_arm() {
  local arm="$1" w1="$2" w2="$3" w3="$4" expect="$5"
  local store="$S/lme90-r141-$arm"
  local -n _f1="$w1"
  local -n _f2="$w2"
  local -n _f3="$w3"
  local -a cmd=( $B "${COMMON[@]}" "${_f1[@]}" "${_f2[@]}" "${_f3[@]}" --store "$store" --tag "r141-$arm" --report-name "r141-$arm" --expect-config "$expect" )
  echo "[r141] start $arm $(date +%H:%M:%S)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[r141] DRY_RUN: rm -rf $store && cp -r $BASE $store"
    printf '[r141] DRY_RUN:'
    printf ' %q' "${cmd[@]}"
    printf '\n'
    return 0
  fi
  fresh "$BASE" "$store" || { echo "[r141] FAILED: $arm 复制库失败"; FAILED=$((FAILED+1)); return 1; }
  # #139 第7项：报告名钉死为 tag（并行跑不会串味），且「没产出报告」也算失败（非 0 链式断言）。
  rm -f "$L/r141-$arm.json"   # 先删旧报告：否则上一轮遗留报告会让 -f 断言假绿
  "${cmd[@]}" || { echo "[r141] FAILED: $arm（eval 非 0）"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/r141-$arm.json" ] || { echo "[r141] FAILED: $arm 未产出报告 $L/r141-$arm.json"; FAILED=$((FAILED+1)); return 1; }
  echo "[r141] done $arm $(date +%H:%M:%S)"
}

ALL_ARMS=(b0 w1 w2h w2s w3 w3legacy w1w2h w1w2s w1w3 w2hw3 w2sw3 alls allh)
selected() {
  [ "$ARMS" = "all" ] && return 0
  case " $ARMS " in *" $1 "*) return 0 ;; esac
  return 1
}

# ── 13 臂（12 格 + 生产锚点 w3legacy）──
# b0 = 基座：W1 关 W2 关 W3 关
run_one() {
  case "$1" in
    b0)        run_arm b0        W1_OFF W2_OFF  W3_OFF    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_OFF,$EXPECT_W3_OFF" ;;
    w1)        run_arm w1        W1_ON  W2_OFF  W3_OFF    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_OFF,$EXPECT_W3_OFF" ;;
    w2h)       run_arm w2h       W1_OFF W2_HARD W3_OFF    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_HARD,$EXPECT_W3_OFF" ;;
    w2s)       run_arm w2s       W1_OFF W2_SOFT W3_OFF    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_SOFT,$EXPECT_W3_OFF" ;;
    w3)        run_arm w3        W1_OFF W2_OFF  W3_NEW    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_OFF,$EXPECT_W3_NEW" ;;
    w3legacy)  run_arm w3legacy  W1_OFF W2_OFF  W3_LEGACY "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_OFF,$EXPECT_W3_LEGACY" ;;
    w1w2h)     run_arm w1w2h     W1_ON  W2_HARD W3_OFF    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_HARD,$EXPECT_W3_OFF" ;;
    w1w2s)     run_arm w1w2s     W1_ON  W2_SOFT W3_OFF    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_SOFT,$EXPECT_W3_OFF" ;;
    w1w3)      run_arm w1w3      W1_ON  W2_OFF  W3_NEW    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_OFF,$EXPECT_W3_NEW" ;;
    w2hw3)     run_arm w2hw3     W1_OFF W2_HARD W3_NEW    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_HARD,$EXPECT_W3_NEW" ;;
    w2sw3)     run_arm w2sw3     W1_OFF W2_SOFT W3_NEW    "$EXPECT_BASE,$EXPECT_W1_OFF,$EXPECT_W2_SOFT,$EXPECT_W3_NEW" ;;
    alls)      run_arm alls      W1_ON  W2_SOFT W3_NEW    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_SOFT,$EXPECT_W3_NEW" ;;
    allh)      run_arm allh      W1_ON  W2_HARD W3_NEW    "$EXPECT_BASE,$EXPECT_W1_ON,$EXPECT_W2_HARD,$EXPECT_W3_NEW" ;;
    *) echo "[r141] 未知臂: $1"; FAILED=$((FAILED+1)); return 1 ;;
  esac
}

# DRY_RUN 只打印命令，不该因为本机还没灌库就退出（联调/评审时常用）。
[ "$DRY_RUN" = "1" ] || [ -d "$BASE" ] || { echo "[r141] 缺少基线库 $BASE（先跑 #137 全开档或用 STORE_ROOT 指定）"; exit 1; }

for arm in "${ALL_ARMS[@]}"; do
  selected "$arm" || continue
  run_one "$arm" || true
done

# ── 自动出「1+1>2」判定表 ──
factorial_step() {
  local base="$L/r141-b0.json"
  local single="r141-w1=$L/r141-w1.json,r141-w2h=$L/r141-w2h.json,r141-w2s=$L/r141-w2s.json,r141-w3=$L/r141-w3.json,r141-w3legacy=$L/r141-w3legacy.json"
  local combo="r141-w1w3=$L/r141-w1w3.json,r141-w2sw3=$L/r141-w2sw3.json,r141-w1w2s=$L/r141-w1w2s.json,r141-w2hw3=$L/r141-w2hw3.json,r141-alls=$L/r141-alls.json,r141-allh=$L/r141-allh.json"
  local -a need=(
    "$base"
    "$L/r141-w1.json" "$L/r141-w2h.json" "$L/r141-w2s.json" "$L/r141-w3.json" "$L/r141-w3legacy.json"
    "$L/r141-w1w3.json" "$L/r141-w2sw3.json" "$L/r141-w1w2s.json" "$L/r141-w2hw3.json" "$L/r141-alls.json" "$L/r141-allh.json"
  )
  for f in "${need[@]}"; do
    [ -f "$f" ] || { echo "[r141] 跳过判定表：缺报告 $f（ARMS 子集模式？）"; return 0; }
  done
  node --import tsx scripts/bench-factorial.mjs \
    --base "$base" \
    --single "$single" \
    --combo "$combo" \
    --floor temporal=turnCov=0 \
    --json "$L/r141-factorial.json" > "$L/r141-factorial.md" || {
      echo "[r141] FAILED: 判定表生成失败（判分器不一致？见上方 stderr）";
      FAILED=$((FAILED+1));
      return 1;
    }
  echo "[r141] 判定表: $L/r141-factorial.md"
  cat "$L/r141-factorial.md"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[r141] DRY_RUN: 跳过判定表（真跑后才出 $L/r141-factorial.md）"
else
  factorial_step || true
fi

[ "$FAILED" -ne 0 ] && { echo "[r141] 有 $FAILED 处失败"; exit 1; }
echo "[r141] OK"
