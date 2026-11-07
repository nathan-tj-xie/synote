# #58 视觉对比

macOS 深色主题，1280×800 CSS 像素；窄窗 900×650。使用真实 Electron、独立临时 userData 和确定性的中文笔记/Git fixture。所有截图已实际查看，未用 DOM 注入伪造界面。

改前：`532fd05`（合并 #65 后的 main，与此前 `1ad8309` 的文件树完全相同）。改后：`aa9fcf471ce5b103656d5ddc98437330d2547800`。这里只提交 15 组主要界面，完整 21 组保留在本机 `/tmp/synote-58-visual`。

欢迎页为没有最近笔记库的真实空状态。Git 错误来自无 remote 的临时仓库 push；冲突来自真实本地分支合并。合并截图先等待 Git 状态就绪，再从冲突列表打开笔记并等待三个 CodeLens 操作可见。未改任何产品行为来制造截图。

## 重现

先在目标 worktree 构建应用，然后从仓库根目录运行：

```sh
SYNOTE_WORKTREE="$PWD" SYNOTE_CAPTURE_PHASE=recapture node docs/visual/58/capture.cjs
```

输出位于脚本旁的 `recapture/`，默认不会覆盖提交的 before/after。脚本从目标 worktree 读取 Playwright，临时数据留在 `/tmp/synote-58-fixture-*`。它不在 e2e 测试发现目录，不访问真实笔记库，不运行项目测试。

选中行强调文字对比度为 4.60:1；正文、次级文字和操作按钮文字对比度均超过 6.4:1。

最终本机验证：typecheck/build 通过，Vitest 663 passed / 1 skipped，Electron e2e 单 worker 81 passed / 1 skipped。首次 e2e 仅因固定旧错误色的断言失败，已同步新色值并全量重跑。

## 验证边界

- 原有 Vitest 公共接口测试覆盖笔记/Git/索引等逻辑回归，不断言 CSS 实现。
- 原有 Electron e2e 覆盖编辑、键盘、焦点、双链、嵌入块、diff/冲突和 Git 流程；视觉质量由这些截图复核。
- 固定虚拟列表行高及 estimateSize 保持原值；CM6 与普通/冲突/删除 Monaco 编辑器从同一组 token 获取字体、字号、行距。
- 保留所有交互处理函数、快捷键、可访问名称和文案。原生文件选择器和系统标题栏不属于 renderer 重设计。
- 窄窗核对侧栏、合并操作、编辑区域和浮层；人工长时间写作验收由 #59 负责。

| 界面 | 改前 | 改后 |
| --- | --- | --- |
| 01-welcome | ![改前](before/01-welcome.png) | ![改后](after/01-welcome.png) |
| 02-manuscript | ![改前](before/02-manuscript.png) | ![改后](after/02-manuscript.png) |
| 03-command-palette | ![改前](before/03-command-palette.png) | ![改后](after/03-command-palette.png) |
| 05-search | ![改前](before/05-search.png) | ![改后](after/05-search.png) |
| 06-rename | ![改前](before/06-rename.png) | ![改后](after/06-rename.png) |
| 07-orphans | ![改前](before/07-orphans.png) | ![改后](after/07-orphans.png) |
| 08-history | ![改前](before/08-history.png) | ![改后](after/08-history.png) |
| 10-worktree-diff | ![改前](before/10-worktree-diff.png) | ![改后](after/10-worktree-diff.png) |
| 11-git | ![改前](before/11-git.png) | ![改后](after/11-git.png) |
| 11b-git-error | ![改前](before/11b-git-error.png) | ![改后](after/11b-git-error.png) |
| 13-mermaid-editor | ![改前](before/13-mermaid-editor.png) | ![改后](after/13-mermaid-editor.png) |
| 15-inline-math | ![改前](before/15-inline-math.png) | ![改后](after/15-inline-math.png) |
| 17-merge | ![改前](before/17-merge.png) | ![改后](after/17-merge.png) |
| 18-abort-merge | ![改前](before/18-abort-merge.png) | ![改后](after/18-abort-merge.png) |
| 19-narrow-merge | ![改前](before/19-narrow-merge.png) | ![改后](after/19-narrow-merge.png) |
