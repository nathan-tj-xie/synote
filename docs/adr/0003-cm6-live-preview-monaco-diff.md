# 日常编辑用 CodeMirror 6 实时预览，diff 用 Monaco diff editor

日常编辑使用 CodeMirror 6，自己写实时预览扩展；所有 Diff 编辑场景都使用 Monaco diff editor（冲突解决用基于 Monaco 的三栏合并编辑器，见下文 #70）。原因：在"源码即真相"的前提下，只有 CM6 能实现 Obsidian 式实时预览（ProseMirror 系会改写 Markdown 源码，污染 git diff）；Monaco diff 的体验和 VSCode 同源，支持移动检测，diff 算法也更好，用户在原型（#6）里对比 `@codemirror/merge` 后选了 Monaco。

## Considered Options

- CM6 + `@codemirror/merge`（一套编辑器）：主题、键位天然统一，但 diff 打磨度不如 Monaco；原型对比后被否决。
- 嵌入 VSCode workbench（`@codingame/monaco-vscode-api`）以获得三方 merge editor：相当于换底座，否决。

## Consequences

- 两套编辑器要共用设计 token、字体和"命令 → 键位"表；CM6 使用 `@replit/codemirror-vscode-keymap`，让键位贴近 Monaco。
- Monaco 懒加载，只在进入 diff 视图时加载（原型实测挂载约 370 ms，首次约 1.1 s）。
- Monaco 和 `@codemirror/merge` 都没有三方合并。冲突视图改为移植 VS Code 的三栏合并编辑器（#70，推翻 #9 决定 1 的单编辑器 + 冲突标记）：`src/vs/workbench/contrib/mergeEditor/browser/` 的模型层照搬、视图层照着用 standalone Monaco 重写，放在 `src/renderer/src/merge/`，保留 MIT 版权头和来源 commit。它引用 `monaco-editor` 包里的非公开内部模块（observable、diff 算法、TextModel 等），所以 `monaco-editor` 锁定精确版本（当前 `0.57.0`），升级时要跑合并编辑器的单测和 e2e 回归；ESM 包经过 tree-shaking，缺的方法在 `merge/` 里按上游补齐。
- 嵌入块（Mermaid 块、KaTeX 公式）在正文中始终显示渲染结果，不会原地切换成代码：Mermaid 块和块级公式点击后在独立的编辑窗口中修改源码（左源码、右预览），行内公式点击后在旁边的浮层中修改（上源码、下预览）（#15）。
