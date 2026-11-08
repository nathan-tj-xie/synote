# 用法：zsh docs/agents/review.sh <仓库目录> <输出文件> <完成信号文件> <这次改动的说明> [通知的 rex block]
# 审查当前分支相对 origin/main 的改动，用 claude。不用 codex、omp
REPO=$1; OUT=$2; DONE=$3; NOTIFY=$5
P="使用 ~/.agents/skills/code-review 这个 skill，审查当前分支相对 origin/main 的改动（$4）。只读，不要改文件。最后单独输出一行：VERDICT: PASS 或 VERDICT: CHANGES_REQUESTED，并在其上列出必须修改的问题。"
mkdir -p "${OUT:h}" "${DONE:h}" # 输出目录可能已被清掉（如会话的 scratchpad）
rm -f "$DONE"
# 流式输出：pane 里实时显示回复和工具调用；最终结论另存到 $OUT
(cd "$REPO" && claude -p --permission-mode plan --output-format stream-json --verbose "$P" </dev/null 2>&1 | tee "$OUT.jsonl" |
  jq -rR --unbuffered 'fromjson? // {type:"raw",line:.} | if .type=="raw" then .line elif .type=="assistant" then (.message.content[] | if .type=="text" then .text elif .type=="tool_use" then "→ \(.name) \(.input|tostring|.[0:200])" else empty end) else empty end')
jq -rR 'fromjson? | select(.type=="result") | .result' "$OUT.jsonl" > "$OUT"
touch "$DONE"
# 跑完主动告诉发起审查的 agent（它的 rex block），不让它靠轮询信号文件
if [[ -n $NOTIFY ]]; then
  v=$(grep '^VERDICT:' "$OUT" | tail -1)
  rex block send -b "$NOTIFY" "审查完成：${v:-没有 VERDICT 行}，输出在 $OUT"
  rex block send-key -b "$NOTIFY" enter
fi
