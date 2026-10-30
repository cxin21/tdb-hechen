#!/bin/bash
# issue #146（W2b 事实级双时态）配对档：只有写入粒度不同，其余键位相同。
#  - b1off              = 整行写入基线（--rerank-off --b1，仓位同 #136 的 b1-off 基线）
#  - b1off-factrows     = 同基线 + --fact-rows（一条事实一行 + fact_key 精确失效）
#  - deep               = 深池基线（candidates 32 / minScore -10.5 / candidateK 32，#135 验收前提）
#  - deep-factrows      = 深池 + --fact-rows
#  - b1off-factrows-dedupe10 = 诊断档：事实行 + 行预算放大到 10 + 按父 turn 折叠（验证槽位饥饿）
# 每档全新灌库（--fact-rows 不允许复用 --store）；facts-cache 共享，故只有第一档付抽取成本。
# 配对：同 manifest / 同 judge，n=90。报告名钉死为 lme90-r146-<tag>，compare 直接吃。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
CORE="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
# 生成/判分走 scm-flash（MiniMax 402 已停）：--prod-data 指向凭据 shim 目录，bench 凭据优先级
# override > yaml > env，故 shim 的 config-override.json 会盖住 prod 的 MiniMax 配置。
# ⚠ shim 内含真实 apiKey，只在本机用，绝不入库。
PROD="--prod-data $L/llm-shim-scm"
B1="--rerank-off --b1"
# 深池档必须带 --rerank-child-proc：本机 onnx 精排在 32 候选下会原生崩溃（2026-10-29 实测：
# 灌库完成、首题精排 warn 后整档静默退出、无报告），子进程隔离是 #135 起就沿用过的崩溃防护。
DEEP="--rerank-candidates 32 --rerank-minscore -10.5 --candidate-k 32 --rerank-child-proc"
DEDUPE="--recall-max-results 10 --dedupe-hits-by-turn"
FAILED=0
LOG=$L/logs
mkdir -p "$LOG"
# 每臂独立日志：既 tee 到作业输出（我这边 tail 作业），也落文件（作业被 kill 也能续读进度）。
# 教训：只靠 `| tail -200` 会把进度缓冲吞掉，看着像"卡死"，误杀过一个 16 分钟的正常臂。
run() {
  local tag="$1"; shift
  echo "[r146] start $tag $(date +%H:%M:%S)"
  ( $B "$@" --tag "$tag" --report-name "lme90-r146-$tag" 2>&1 | tee "$LOG/$tag.log" | tail -3 ) || { echo "[r146] FAILED: $tag"; FAILED=$((FAILED+1)); }
  echo "[r146] done $tag $(date +%H:%M:%S) → $LOG/$tag.log"
}
case "${1:-help}" in
  b1off)          run r146-b1off          $CORE $B1 ;;
  b1off-factrows) run r146-b1off-factrows $CORE $B1 --fact-rows ;;
  deep)           run r146-deep           $CORE $DEEP ;;
  deep-factrows)  run r146-deep-factrows  $CORE $DEEP --fact-rows ;;
  b1off-factrows-dedupe10) run r146-b1off-factrows-dedupe10 $CORE $B1 --fact-rows $DEDUPE ;;
  # v2 口径（行 content = 父 turn 原文 + 读侧按 fact_of 折叠，见 ADR-0015 决定 2）：读侧零成本，预期与整行档逐位持平。
  v2base)         run r146v2-base      $CORE $B1 $PROD --keep ;;
  v2factrows)     run r146v2-factrows  $CORE $B1 $PROD --keep --fact-rows ;;
  v2all)          bash "$0" v2base; bash "$0" v2factrows ;;
  # 深池档（#135 验收前提：candidates 32 / minScore −10.5 / candidateK 32），#146 验收③按此口径。
  v2deep)         run r146v2-deep      $CORE $DEEP $PROD --keep ;;
  v2deep-factrows) run r146v2-deep-factrows $CORE $DEEP $PROD --keep --fact-rows ;;
  v2deepall)      bash "$0" v2deep; bash "$0" v2deep-factrows ;;
  #166 验收③：新代码深池回归档（后缀 2 = #166 代码下重跑，对照既有 v2deep-factrows 读数 71.7%/58.9%）
  v2deep-factrows2) run r146v2-deep-factrows2 $CORE $DEEP $PROD --keep --fact-rows ;;
  #167 验收⑤：facts-v4 深池配对档（只换抽取缓存为 v4，其余键位与 v2deep-factrows2 逐位相同）
  # 注意：v4 缓存由 scm-flash 抽取，缓存校验按 model 命中；CORE 里的 MiniMax-M2.7 会整批失效并走已欠费的 MiniMax 端点，
  # 故本臂把 fact-model 换成 scm-flash（与缓存/判分/生成同一个 shim 模型）。缓存全命中时 fact-model 只参与缓存校验，
  # 不产生抽取调用，因此行为变量仍只有一个（facts-v3 缓存 → facts-v4 缓存）；日志与报告里要按 scm-flash 记。
  v2deep-factrows-v4)
    CORE_V4="${CORE/--fact-model MiniMax-M2.7/--fact-model scm-flash}"
    CORE_V4="${CORE_V4/--embed-interval-ms 1200/--embed-interval-ms 3000}"
    # CORE 是拼出来的字符串，替换失败会静默 no-op 并拿欠费的 MiniMax 端点跑出无效读数；这里显式拦一道。
    case "$CORE_V4" in
      *"--fact-model scm-flash"*"--embed-interval-ms 3000"*) ;;
      *) echo "[abort] CORE 替换失败（fact-model 或 embed-interval），v4 配对档拒绝运行" >&2; exit 2 ;;
    esac
    # 北极星 embedding（doubao-embedding-vision）在 1.2s 间隔下会连续 429；本臂单独放慢到 3s，
    # 只影响灌库速度，不影响任何被测逻辑。其余臂保持 1.2s 不变。
    run r146v2-deep-factrows-v4 $CORE_V4 $DEEP $PROD --keep --fact-rows --fact-cache $L/facts-cache-v4 ;;
  #166 验收④：IDF 稀释隔离档——同一份新代码下配对：控制档重跑 vs FTS 面只留 fact_index=0（l1_vec 不动，纯 BM25 df 变量）
  v2factrows2)    run r146v2-factrows2  $CORE $B1 $PROD --keep --fact-rows ;;
  v2factrows-prune) run r146v2-factrows-prune $CORE $B1 $PROD --keep --fact-rows --prune-fact-sibling-index ;;
  # 控制档复跑：首跑（v2factrows2）在 recall 段整段 strategy=error，当时无留痕；换 tag 复跑取证
  v2factrows3)    run r146v2-factrows3  $CORE $B1 $PROD --keep --fact-rows ;;
  idf)            bash "$0" v2factrows2; bash "$0" v2factrows-prune ;;
  all) for m in b1off b1off-factrows deep deep-factrows; do bash "$0" $m; done ;;
  *) echo "用法: $0 {b1off|b1off-factrows|deep|deep-factrows|b1off-factrows-dedupe10|v2base|v2factrows|v2all|v2deep|v2deep-factrows|v2deepall|v2deep-factrows2|v2deep-factrows-v4|v2factrows2|v2factrows-prune|v2factrows3|idf|all}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[r146] 有 $FAILED 处失败"; exit 1; fi
echo "[r146] OK"
