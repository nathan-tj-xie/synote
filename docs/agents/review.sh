# 用法：zsh docs/agents/review.sh <仓库目录> <输出文件> <完成信号文件> <这次改动的说明>
# 审查当前分支相对 origin/main 的改动；omp 没给出 VERDICT（比如额度用完）就换 claude。不用 codex
REPO=$1; OUT=$2; DONE=$3
P="使用 ~/.agents/skills/code-review 这个 skill，审查当前分支相对 origin/main 的改动（$4）。只读，不要改文件。最后单独输出一行：VERDICT: PASS 或 VERDICT: CHANGES_REQUESTED，并在其上列出必须修改的问题。"
rm -f "$DONE"
(cd "$REPO" && omp -p --no-session "$P" 2>&1 | tee "$OUT")
grep -q '^VERDICT:' "$OUT" || (cd "$REPO" && claude -p --permission-mode plan "$P" 2>&1 | tee "$OUT")
touch "$DONE"
