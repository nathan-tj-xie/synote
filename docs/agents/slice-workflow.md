# 切片的实现流程

一个实现切片（`ready-for-agent`）由一个子 agent 从头做到开 PR，外层只管派活和合并。

## 子 agent

1. 从最新的 `main` 开 `feat/*` 分支，用 `tdd` 技能（Skill 工具）测试先行地实现，跑通 `pnpm typecheck`、`pnpm test`、`pnpm build && pnpm e2e`。和技能原文不同的几点：
   - **测哪些接口由子 agent 自己定，不问用户**：动手前从 issue 的需求和验收里推出要测的接口，每个写一句能抓到什么、漏掉什么，记进 PR 描述。
   - **红 → 绿主要在 vitest 这层循环**：解析规则、写回逻辑这类纯逻辑，一个测试一个实现地推进；e2e 每轮要构建，太慢，只把 issue 验收里的用户流程先写成失败的用例，最后一起变绿。
   - 交互上没人想到的边界情况 TDD 覆盖不到，仍然靠下一步的独立审查兜底。
2. **开 PR 之前先审查**：在当前 Rex 窗口里 `rex split -s $REX_SESSION -b $REX_BLOCK --split=below --focus=false --keep-open -- zsh docs/agents/review.sh <仓库> <输出文件> <信号文件> "<改动说明>"` 新开一个 pane，起一个独立的审查者（omp，额度用完时脚本会自动换 claude；不用 codex）；等信号文件出现后读输出，读完就 `rex block close` 关掉这个 pane。
3. 结论是 `VERDICT: CHANGES_REQUESTED` 就逐条修，修完 commit，再审查。审查意见不能跳过，也不能改动审查要求；认为某条是误报的，要在 PR 描述里写明理由。
4. **最多审查 4 轮**。第 4 轮还没通过就停下，向外层汇报卡在哪里。这种情况多半是方案本身有问题，不要继续一处处补边界情况。
5. 通过后 push，用 `gh pr create --base main` 开 PR，描述里写 `Closes #N`，并附上最后一轮审查输出的路径和它审的 commit。
6. PR 上的 CI 自动跑。失败了就照报错修：只改测试或环境的，修完直接 push；改了功能代码的，先再审查一轮再 push。
7. 不合并 PR。

## 外层

- 合并之前核对三件事：CI 全绿；最后一轮审查输出里有 `VERDICT: PASS`；那一轮审的 commit 就是 PR 的 HEAD（之后只允许有不改功能代码的 CI 修复）。
- `gh pr merge --squash --delete-branch` 合并，确认 issue 已经关闭，关掉子 agent 的 pane，然后选下一个切片（blocked-by 为 0、标签是 `ready-for-agent`）。

## 人工验收

需要人眼判断观感、手感的内容，单独建 `ready-for-human` 的 issue，blocked-by 对应的实现切片。实现切片合并进 main 之后，再录这些内容的视频（功能对不对由 e2e 断言，不录），视频列在那个 issue 里，然后通知用户审查。
