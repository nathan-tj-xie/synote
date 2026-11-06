## Agent skills

### Issue tracker

Issues 记录在 GitHub Issues（nathan-tj-xie/synote），使用 `gh` CLI。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认的五个标签：needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根目录 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.

### 切片流程

子 agent 实现 → 开 PR 前用 `docs/agents/review.sh` 找独立审查者审查（最多 4 轮）→ 开 PR、自动跑 CI → 外层核对后合并。See `docs/agents/slice-workflow.md`.
