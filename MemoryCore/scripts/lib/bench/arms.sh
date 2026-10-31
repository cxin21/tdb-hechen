#!/usr/bin/env bash
# ── bench 档位脚本共享库（issue #159）────────────────────────────────────────────
# 复跑历史档的纪律固化在这里，不要再让每个 run-*.sh 各自手抄一遍旗标。
#
# 方法论（docs/optimization-results.md §15.7 的教训，写成代码）：
#  1) 生产 tdai-gateway.yaml 一直在"后来开"机制：conclusionLayer(09-12)、smallToBig(10-25)、
#     factChannel / candidateK 32 / fusion normalized / validity soft(10-27)、rerank 32/-10.5(10-29)。
#     沙箱库还会继承生产 config-override.json（优先级高于沙箱 yaml）。所以复跑任何历史档，
#     该档 era 里"没开"的机制必须用显式旗标钉回去：--fact-channel-off / --small-to-big-off /
#     --conclusion-layer-off / --validity-mode hard；era 的数值缺省（candidateK、融合模式、rerank
#     池/闸门）也要显式钉，否则「基线档」里混进后来机制，数字不可比且没人能一眼看出来。
#  2) 每档必须带 --expect-config：runner 在灌库**之前**比对生效配置，不符直接 exit 2。
#     断言不成立就不是"跑出数字了"，而是"这一档根本没跑"。
#  3) 每档必须 --report-name = tag，并断言报告 <out>/<tag>.json 存在——报告没落盘 = 白跑（别只看退出码）。
#  4) 路径一律走 STORE_ROOT（缺省系统临时目录下的 tdagemem-bench），禁止写个人家目录（换机器即失效）。
#
# 用法：
#   . "$SCRIPT_DIR/lib/bench/arms.sh"
#   cd "$SCRIPT_DIR/.." || exit 1     # MemoryCore/（相对路径 L 以此为准）
#   arms_init
#   arms_fresh "$BASE" "$STORE"
#   arms_run "$tag" <runner args... 必须含 --expect-config>
#   arms_finish
# 失败一律累加进 FAILED（不复用 runner 退出码），末尾 arms_finish 汇总非 0 退出。

# ── era 口径常量（#159）─────────────────────────────────────────────────────────
# 后来开的生产机制统一关掉：事实通道 / 小到大回捞 / 结论层 / 软失效。
# 复跑历史档时 ${ARMS_OFF_ERA[@]} 一律并进旗标，$ARMS_EXPECT_OFF 并进断言；
# 只允许"本档变量"覆盖其中一项（例如 r136 的 card 档反过来开 smallToBig + conclusionLayer）。
ARMS_OFF_ERA=(--fact-channel-off --small-to-big-off --conclusion-layer-off --validity-mode hard)
ARMS_FUSION_RRF='{"mode":"rrf"}'
ARMS_EXPECT_OFF="recall.factChannel.enabled=false,recall.smallToBig.enabled=false,recall.conclusionLayer.enabled=false,recall.validity.mode=hard"

# 沙箱库根目录：STORE_ROOT 优先，其次系统临时目录下的 tdagemem-bench。
arms_store_root() { printf '%s' "${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"; }

# arms_init：填默认 runner 命令/报告目录/库根目录，清 FAILED。必须在 cd 到 MemoryCore/ 之后调用。
arms_init() {
  : "${B:=node --import tsx scripts/eval-memory-bench.mjs}"
  : "${L:=.eval-data/bench}"
  ARMS_ROOT="$(arms_store_root)"
  export B L ARMS_ROOT
  mkdir -p "$L"
  FAILED="${FAILED:-0}"
  # 源库缺失时置 1：同批后续档一律跳过，避免拿空库跑出 90 题全量灌库（#159）。
  ARMS_SKIP="${ARMS_SKIP:-0}"
}

# arms_fail <msg...>：记一次失败（只记账，不退出，让同批其它档跑完）。
arms_fail() {
  echo "[arms] FAILED $*" >&2
  FAILED=$((FAILED + 1))
}

# arms_fresh <src> <dst>：复制基线库（零重灌）。源库缺失记一次失败并置 ARMS_SKIP，
# 后续 arms_run 直接跳过（否则会对着空目录全量灌库，跑出与档位无关的数字）。
arms_fresh() {
  local src="$1" dst="$2"
  if [ ! -d "$src" ]; then
    arms_fail "缺少源库 $src（本脚本后续档全部跳过）"
    ARMS_SKIP=1
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  cp -r "$src" "$dst"
  echo "[arms] 复制库 $src → $dst"
}

# arms_run <tag> [runner args...]
# 强制：args 里必须有 --expect-config；执行时补 --tag 与 --report-name 都为 tag；
# 非 0 退出或报告缺失都记失败。输出落 <out>/run-<tag>.log，失败时回显末尾便于定位。
arms_run() {
  local tag="$1"
  shift
  if [ "${ARMS_SKIP:-0}" = "1" ]; then
    echo "[arms] skip $tag（源库缺失，已记失败）"
    return 1
  fi
  local a has_expect=0
  for a in "$@"; do
    case "$a" in
      --expect-config | --expect-config=*)
        has_expect=1
        break
        ;;
    esac
  done
  if [ "$has_expect" -ne 1 ]; then
    arms_fail "$tag 缺 --expect-config（#159：每档必须写死生效配置，防止继承生产默认）"
    return 1
  fi
  local log="$L/run-$tag.log"
  echo "[arms] start $tag $(date +%H:%M:%S)"
  # B 是完整命令（含 node 参数）：拆成数组再执行，避免 $B 的二次词分割（路径含空格会炸）。
  read -r -a runner <<< "$B"
  if ! "${runner[@]}" "$@" --tag "$tag" --report-name "$tag" > "$log" 2>&1; then
    arms_fail "$tag runner 退出码非 0（日志 $log）"
    tail -n 20 "$log" >&2 || true
  elif [ ! -f "$L/$tag.json" ]; then
    arms_fail "$tag 报告缺失：$L/$tag.json（报告名必须 = tag）"
  else
    echo "[arms] OK $tag → $L/$tag.json"
  fi
  echo "[arms] done $tag $(date +%H:%M:%S)"
}

# arms_finish：汇总。任何一档失败则整批 exit 1（不再有"全绿"的假象）。
arms_finish() {
  if [ "${FAILED:-0}" -ne 0 ]; then
    echo "[arms] 共 $FAILED 处失败" >&2
    exit 1
  fi
  echo "[arms] OK"
}
