# 用法：zsh docs/agents/review.sh <仓库目录> <输出文件> <完成信号文件> <这次改动的说明> [通知的 rex block]
# 审查当前分支相对 origin/main 的改动，用交互模式的 claude（不用 -p），在 pane 里看得到完整过程。不用 codex、omp。
# 审查者自己把结论写进输出文件、touch 信号文件，并用 rex 通知发起审查的 agent；pane 由发起者读完后关掉
REPO=$1; OUT=$2; DONE=$3; NOTIFY=$5
mkdir -p "${OUT:h}" "${DONE:h}" # 输出目录可能已被清掉（如会话的 scratchpad）
rm -f "$DONE" "$OUT"
N=''
[[ -n $NOTIFY ]] && N="最后执行 rex block send -b $NOTIFY '审查完成：<你的 VERDICT 行>，输出在 $OUT'，再执行 rex block send-key -b $NOTIFY enter。"
P="使用 ~/.agents/skills/code-review 这个 skill，审查当前分支相对 origin/main 的改动（$4）。只读：除了下面要写的输出文件，不要改任何文件。最后单独输出一行：VERDICT: PASS 或 VERDICT: CHANGES_REQUESTED，并在其上列出必须修改的问题。审查结束后，用 Write 工具把完整的审查结论（含最后的 VERDICT 行）写到 $OUT，再执行 touch $DONE。$N"
cd "$REPO" && exec claude --permission-mode auto -n review "$P"
