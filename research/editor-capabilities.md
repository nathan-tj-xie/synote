# 编辑器能力调研：实时预览与 Monaco diff

> Research ticket：nathan-tj-xie/synote#2 ・ 调研日期：2026-11-03
> 评判标准（来自 #1）：VSCode 级别的编辑与 diff 体验；10k 笔记规模下的性能。
> 本文只给事实与建议，**选型决策留给后续 ticket**。

## TL;DR

| 问题 | 结论 |
|---|---|
| Q1 实时预览 | **CodeMirror 6 是唯一"源码即真相"且有现成 Obsidian 式实现的路线**（Obsidian 本身即基于 CM6）。社区库可覆盖标题/强调/图片/`[[wikilink]]`/光标行显示源码，但都是小项目（≤160 stars），Mermaid 块渲染 + 单独编辑需自己写（约数百行 widget）。Milkdown/ProseMirror 系是 WYSIWYG，会 parse→serialize 改写 Markdown 源码，与 git diff 场景冲突。 |
| Q2 Monaco diff | modified 侧**默认可编辑**，original 侧可通过 `originalEditable` 打开。**Monaco 没有三方合并**，官方两次以 not planned 关闭。VSCode merge editor 只能通过 `@codingame/monaco-vscode-api`（即"把 VSCode workbench 搬进来"）获得，重量级且需原型验证。 |
| Q3 统一成本 | 两套编辑器的主题、高亮、快捷键、配置模型都不同，需写一层"共享设计 token + 双端适配"。主题可借 Shiki（同一份 TextMate 主题同时喂给两端）收敛；快捷键需手工映射。业界案例多为"从 Monaco 迁到 CM6"（Sourcegraph、Replit），未找到"CM6 编辑 + Monaco diff"并存的公开案例。 |
| Q4 `@codemirror/merge` | 能做两方 diff（分栏 + unified，双侧可编辑、按块接受/还原、折叠未变更区），**但也没有三方合并**（CM5 有，CM6 未移植）。diff 体验比 Monaco 少：无移动检测、无 inline/side-by-side 自动切换、无 accessible diff viewer、算法较朴素（可通过 `DiffConfig.override` 替换）。 |

**倾向性建议**（供决策 ticket 参考）：以 **CM6 统一编辑与 diff** 为默认方案（实时预览 + `@codemirror/merge` 做工作区对比/历史对比），冲突解决用"**冲突标记 + CodeLens 式接受按钮**"的单编辑器方案或自建基于 `@codemirror/merge` 的三栏视图；只有当原型证明 CM6 diff 体验明显不够时，再引入 Monaco diff editor（两方）。不建议为三方合并引入 `monaco-vscode-api` 的 workbench。

---

## 版本与维护状态（2026-11-03，npm registry）

| 包 | 版本 | 最近发布 | 备注 |
|---|---|---|---|
| `@codemirror/view` | 6.43.15 | 2026-10-19 | 活跃。**CodeMirror 已于 2026-04-15 把 GitHub 仓库归档，迁至 [code.haverbeke.berlin](https://code.haverbeke.berlin/codemirror/dev)**（issue 跟踪也在那边），npm 照常发布 |
| `@codemirror/lang-markdown` | 6.5.2 | 2026-08-04 | 基于 `@lezer/markdown`，支持 GFM 扩展与自定义语法扩展 |
| `@codemirror/merge` | 6.12.3 | 2026-10-19 | 活跃；6.12.0 起可 `DiffConfig.override` 自定义 diff 算法 |
| `monaco-editor` | 0.57.0 | 2026-09-24 | 活跃（microsoft/monaco-editor ~47k stars），仍为 0.x |
| `@codingame/monaco-vscode-api` | 38.1.3 | 2026-10-29 | 活跃（517 stars，MIT），跟随 VSCode 版本 |
| `@milkdown/crepe` / `@milkdown/kit` | 7.23.0 | 2026-10-27 | 活跃（12k stars） |
| `prosemirror-view` | 1.42.9 | 2026-10-31 | 活跃 |
| `@tiptap/core` | 3.32.2 | 2026-10-30 | 活跃 |
| `@atomic-editor/editor` | 0.6.2 | 2026-07-11 | CM6 实时预览，160 stars，MIT，React |
| `codemirror-live-markdown` | 0.5.1-alpha.1 | 2026-01-18 | CM6 实时预览，44 stars，MIT，框架无关 |
| `codemirror-markdown-hybrid` | 1.2.2 | 2026-01-26 | CM6，8 stars |
| `codemirror-rich-markdoc` | 0.0.2 | 2024-10 | 停更（2024-11 后无提交），仅作参考 |
| `mermaid` | 12.3.0 | 2026-11-03 | 活跃 |
| `@shikijs/monaco` | 4.6.0 | 2026-11-02 | Shiki → Monaco |
| `@replit/codemirror-vscode-keymap` | 6.0.2 | — | CM6 的 VSCode 风格快捷键 |
| `node-diff3` | 3.2.1 | 2026-06 | 三方合并算法（diff3） |

---

## Q1. 实时预览（Live Preview）能力

### 1.1 CodeMirror 6：机制完全具备，Obsidian 就是先例

- **Obsidian 的 Live Preview 基于 CM6**。官方开发文档列出可用的四类 decoration：mark / widget / replace / line（[Obsidian Docs: Decorations](https://docs.obsidian.md/Plugins/Editor/Decorations)）。社区普遍认为其实现是"一个 StateField 提供 replace widget，**当光标/选区不与目标范围重叠时**才替换"（[forum](https://forum.obsidian.md/t/plugin-api-expose-live-edit-functionality-for-extension/73447)）。Obsidian 闭源，内部扩展不对插件开放。
- 对应 CM6 原语：
  - 隐藏 `#`、`**`、`[[ ]]` 等标记：`Decoration.replace({})`，按 `@lezer/markdown` 语法树节点（`HeaderMark`、`EmphasisMark`、`LinkMark`…）定位。
  - 图片、Mermaid 渲染：`Decoration.widget` / `Decoration.replace({widget, block: true})`。**块级替换必须由 StateField 提供，不能由 ViewPlugin 提供**（影响垂直布局，CM6 限制；见同一 [forum 讨论](https://forum.obsidian.md/t/how-to-create-custom-codemirror-block-widget/36132)）。
  - 光标所在行/块显示源码：在构建 decoration 时跳过与 `state.selection` 相交的范围；每次 selection 变化重算。
  - `[[wikilink]]`：`@lezer/markdown` 支持自定义 inline 语法扩展（`MarkdownConfig`），可新增 `WikiLink` 节点；补全用 `@codemirror/autocomplete`。
- **源码即真相**：所有 decoration 都只作用于 view，文档始终是原始 Markdown，保存与 git diff 字节级一致——这是 Synote（git 存储 + 源码层 diff）最关键的属性。

### 1.2 CM6 现成实现对照

| 能力 | `@atomic-editor/editor` | `codemirror-live-markdown` | 需自研 |
|---|---|---|---|
| 标题/强调/高亮/链接 | 有 | 有 | — |
| 光标行显示源码 | 有（"raw syntax 只在光标所在行出现"） | 有（`collapseOnSelectionFacet`） | — |
| 图片内联渲染 | 有 | 有（v0.5） | 本地相对路径 → 桌面 app 资源协议的解析 |
| `[[wikilink]]` | 有（`[[target\|label]]`、异步解析、补全、点击跳转） | **无** | 后者需自写 |
| 表格 | WYSIWYG 表格 | 有 + 可编辑表格 | — |
| 代码块高亮 | 有（20+ 语言懒加载） | 有（lowlight） | — |
| 数学公式 | 未提及 | KaTeX | — |
| **Mermaid 默认渲染、可切换为代码编辑** | **无** | **无** | **需自写** |
| 框架 | React（peer） | 无框架 | — |

来源：[atomic-editor README](https://github.com/kenforthewin/atomic-editor)、[codemirror-live-markdown README](https://github.com/blueberrycongee/codemirror-live-markdown)。

**风险**：两者都是单人维护的小项目（160 / 44 stars），且 atomic-editor 绑定 React。更稳的做法是**把它们当参考实现，在自有代码里写 live preview 扩展**（核心逻辑通常 1–2k 行），或 fork 后内化。

**Mermaid 块的自研方案**（可行、工作量可控）：
- StateField 遍历 `FencedCode` 节点，`CodeInfo == "mermaid"` 且光标不在块内时，用 `Decoration.replace({block: true, widget})` 渲染 `mermaid.render()` 生成的 SVG；
- 点击 widget 或光标进入块 → 不再替换，露出源码（即"单独以代码形式编辑"）；也可以做成"块内切换按钮"；
- 注意：`mermaid.render` 是异步的，widget 需缓存渲染结果并实现 `eq()`，否则每次输入都会重绘；widget 高度需通过 `estimatedHeight` 处理，避免滚动跳动。
- 参考：SilverBullet（CM6、6.4k stars、活跃）有 Mermaid 支持与类 live preview 的渲染（[silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet)）。

### 1.3 Milkdown / ProseMirror 系（Milkdown、Tiptap、BlockNote）

- **模型是 WYSIWYG 文档树，不是 Markdown 文本**：Markdown → (remark) → ProseMirror doc → 编辑 → serialize 回 Markdown。原始格式（`*` vs `_`、列表缩进、空行、转义）会被规范化，导致**未改动内容也出现在 git diff 中**。Milkdown 讨论中明确指出："you'll lose user's original input as markdown because of the parse and serialize transform steps"（[Milkdown#645](https://github.com/Milkdown/milkdown/issues/645)）；也有序列化把嵌套强调错误变成字面 `*` 的 bug（[Milkdown#2403](https://github.com/Milkdown/milkdown/issues/2403)，已关闭）。
- **光标行显示源码**：非内建。#645（"Always display markdown syntax of block at cursor"）关闭为 completed，但实际只给了"用 decorator 自己做"的思路，社区实现均有边界 bug。
- **Mermaid**：Milkdown 的 code-block 组件内嵌 CodeMirror，并提供 `renderPreview(language, content, applyPreview)` + `previewToggleButton` + `previewOnlyByDefault`，**"默认渲染、切换到代码编辑"是现成能力**（[component-code-block 文档](https://github.com/Milkdown/milkdown/blob/main/docs/api/component-code-block.md)）。这是 Milkdown 相对 CM6 唯一明显领先之处。
- `[[wikilink]]` 需自写 remark 插件 + ProseMirror node/mark。
- **结论**：与"源码层 diff + git 存储"的产品定位冲突，不建议作为主编辑器。

---

## Q2. Monaco diff editor

### 2.1 modified 侧能否编辑 —— 能

`monaco.d.ts`（0.57.0）`IDiffEditorBaseOptions`：
- modified 侧是普通 `ICodeEditor`，默认可编辑（`getModifiedEditor()` 可拿到并像普通编辑器一样操作）；
- `originalEditable?: boolean` —— "Original model should be editable? Defaults to false."；
- 其他相关：`renderSideBySide`、`useInlineViewWhenSpaceIsLimited`、`hideUnchangedRegions {enabled, contextLineCount, …}`、`renderMarginRevertIcon`（块级还原按钮）、`renderGutterMenu`、`experimental.showMoves`（移动检测）、`diffAlgorithm: 'legacy' | 'advanced' | 'advanced-external' | 'advanced-wasm'`、`diffWordWrap`、`onlyShowAccessibleDiffViewer`、`getLineChanges()`、`onDidUpdateDiff`。
- 即 "HEAD ↔ 工作区"（modified=工作区可编辑、original=HEAD 只读）和"历史对比"（双侧只读）**开箱即用，体验与 VSCode 同源**。

### 2.2 三方合并 —— Monaco 不支持

- [monaco-editor#3268](https://github.com/microsoft/monaco-editor/issues/3268)（3-way merge editor）与 [#1295](https://github.com/microsoft/monaco-editor/issues/1295) 均以 **NOT_PLANNED** 关闭（2023）。维护者 hediet："the 3 way merge editor uses many components that are currently not bundled with the monaco-editor… we would rather use that engineering time to improve the merge editor in VS Code."
- 用 Monaco 自建三方合并的可选路径：
  1. **单编辑器 + 冲突标记**：保留 git 写出的 `<<<<<<< / ======= / >>>>>>>`，用 decorations + CodeLens/内容 widget 提供 "Accept Current / Incoming / Both"。VSCode 的 merge-conflict 内置扩展即此模式，`@codingame/monaco-vscode-merge-conflict-default-extension` 已把它打包（需 monaco-vscode-api 的扩展宿主）。自写版本工作量小（数百行）。
  2. **两个 diff editor 拼三栏**（base↔ours、base↔theirs + 下方 result 编辑器），用 `node-diff3` 或 `git merge-file -p --diff3` 计算冲突块，自己同步滚动与"接受"按钮。工作量大（千行级），且很难达到 VSCode merge editor 的打磨度。

### 2.3 VSCode merge editor 能否脱离 VSCode —— 只能"连 workbench 一起带走"

- 源码位于 `microsoft/vscode` 的 `src/vs/workbench/contrib/mergeEditor`（MIT），依赖 workbench 层服务，不在 monaco 发行物中。
- `@codingame/monaco-vscode-api`（v38.1.3）在 `views`/`workbench` service override 的公共入口直接 `import 'vs/workbench/contrib/mergeEditor/browser/mergeEditor.contribution'`（[viewCommon/common.ts](https://github.com/CodinGame/monaco-vscode-api/blob/main/src/service-override/viewCommon/common.ts)），说明**启用 views/workbench override 即可获得 merge editor**，且其补丁集中对 mergeEditor 有修改。
- 代价：
  - 要接管整套 VSCode 服务（files、layout、editor、keybindings、theme、extensions…），README 明确 "VSCode is only designed to be initialized once… not possible to unload the services"；
  - 包体与复杂度大（`monaco-editor` 自身 unpacked ~100 MB 含多份构建；workbench 进一步放大），与 live preview 编辑器并存时主题/快捷键体系将变成"VSCode 一套 + CM6 一套"；
  - 打开 merge editor 走 VSCode 内部命令（`_open.mergeEditor` 一类），属于非公开 API，版本升级可能变动——**需原型验证**。
- 结论：**技术上可行，但等于把产品底座换成"嵌入式 VSCode"**，与"双编辑器分工、统一体验"的方向相悖，代价最高。

---

## Q3. 两套编辑器统一主题/快捷键/字体/行为的成本

| 维度 | CM6 | Monaco | 统一手段 / 成本 |
|---|---|---|---|
| 主题（UI） | `EditorView.theme()`，CSS-in-JS，per-instance，可直接用 CSS 变量 | `defineTheme` + **全局** `setTheme`（"Switches to a theme"，影响所有实例；见 `monaco.d.ts`），颜色键用 VSCode 的 `editor.*` color id | 定义一套设计 token（CSS 变量），分别生成 CM6 theme 与 Monaco theme。成本：低–中，一次性 |
| 语法高亮 | Lezer 解析 + `HighlightStyle`（按 `@lezer/highlight` tags） | Monarch tokenizer + token scope 规则 | **最难对齐的部分**：两套分词器对 Markdown 的 token 划分不同。可选：两端都换用 Shiki（`@shikijs/monaco` 4.6.0；CM6 侧 `codemirror-shiki` / `@cmshiki/shiki`，均为小项目），共享一份 TextMate 主题。成本：中 |
| 字体/行高 | CSS | `fontFamily`/`fontSize`/`lineHeight` 选项 | 从同一配置注入。成本：低 |
| 快捷键 | `keymap.of([...])`，可用 `@replit/codemirror-vscode-keymap` 获得 VSCode 风格键位 | `addCommand`/`addAction`/`monaco.editor.addKeybindingRule(s)`，内置即 VSCode 键位 | 维护一张"命令 → 键位"表，两端各写适配器。命令语义（多光标、行移动、查找替换）细节不完全一致。成本：中，且需持续 |
| 行为（查找面板、补全 UI、右键菜单、IME、滚动） | 自有实现 | VSCode 实现 | 无法完全一致，只能在交互入口层统一（如统一用 app 级查找栏）。成本：中–高 |
| 包体/加载 | 按需扩展，轻 | 重，需配置 Web Worker（Vite `?worker`） | 桌面 app 体积压力较小，但启动 3 秒目标需懒加载 Monaco |

**已知案例**：
- [Sourcegraph: Migrating from Monaco Editor to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror)（2022-10）：Monaco 占搜索页 ~40% JS（~2.4 MB），迁移后 JS 减 43%；痛点包括"无法在无全局状态下运行多个不同配置的实例""颜色难以与设计稿同步"。
- [Replit: Betting on CodeMirror](https://replit.com/blog/codemirror)：认为 CM6 更轻、更快、更可定制；但迁移耗时数月，许多 Monaco 功能需自研。
- 未找到"CM6 负责编辑 + Monaco 负责 diff"长期并存的公开案例；公开案例多为二选一后收敛到单一编辑器。这本身是一个信号：双栈的统一成本是持续性的。

---

## Q4. `@codemirror/merge` 能否替代 Monaco diff

API（6.12.3 `index.d.ts`）：
- `MergeView({a, b, orientation, revertControls: 'a-to-b'|'b-to-a', highlightChanges, gutter, collapseUnchanged, diffConfig})`——分栏，**两侧都是普通 `EditorView`，各自可编辑/只读**，可挂任意扩展（包括 live preview 扩展、同一主题与键位）；
- `unifiedMergeView({original, mergeControls, syntaxHighlightDeletions, allowInlineDiffs, collapseUnchanged})`——单栏 unified 视图，带 accept/reject 按钮（`acceptChunk`/`rejectChunk`），`updateOriginalDoc` 可动态更新基线；
- `goToNextChunk`/`goToPreviousChunk`、`getChunks`、`diff`/`presentableDiff`、`DiffConfig.{scanLimit, timeout, override}`（6.12.0 起可替换 diff 算法）。

| 能力 | Monaco diff editor | `@codemirror/merge` |
|---|---|---|
| 分栏 / inline | 两者 + 窄屏自动切换 | 两者（需自行切换） |
| modified 侧可编辑 | 是 | 是（两侧均可） |
| 块级还原 | `renderMarginRevertIcon` | `revertControls` / `mergeControls` |
| 折叠未变更区 | `hideUnchangedRegions` | `collapseUnchanged` |
| 字符级高亮 | 是 | 是（`highlightChanges`） |
| 移动检测 | `experimental.showMoves` | 无 |
| diff 算法 | VSCode "advanced"（含 wasm 选项） | 内置 Myers 类算法 + `scanLimit/timeout`，可 override |
| 无障碍 diff 浏览 | Accessible Diff Viewer | 无 |
| **三方合并** | **无** | **无**（CM5 merge addon 曾支持三栏；CM6 有 [功能请求](https://discuss.codemirror.net/t/fr-three-way-comparison-for-the-v6-merge-plugin/7879)，未实现） |
| 与 live preview 编辑器统一 | 需双栈适配（见 Q3） | 天然统一（同一套扩展/主题/键位） |

**体验差距评估**：日常 Markdown 笔记的 diff（行数小、以段落改动为主）下，差距主要在"移动检测、diff 算法质量（大段重排时的对齐）、打磨细节"，属于"略逊但可用"；在"主题/快捷键/行为一致性"上 `@codemirror/merge` 反而占优。最终差距需原型用真实笔记仓库对比验证。

**三方合并在 CM6 上的自建路径**：`node-diff3`（或 `git merge-file`）算冲突 → 用 `unifiedMergeView` 在 result 文档上逐块接受，或用 `MergeView` 两组 + result 拼三栏。工作量与 Monaco 自建相当，但能复用同一套编辑器栈。

---

## 10k 笔记规模下的性能

- 编辑器只承载**当前打开的少数文档**，10k 笔记规模主要压在索引/搜索（另有 ticket），不直接压在编辑器上。
- CM6：只渲染视口；live preview decoration 应只针对 `view.visibleRanges` 构建（ViewPlugin），块级 widget 用 StateField 但应增量更新，避免每次按键全量遍历语法树。`@lezer/markdown` 增量解析。
- Monaco：每个 model 常驻内存并做 tokenization，切换笔记时需 `dispose()` 未用 model；diff 计算在 worker 中进行。
- `[[wikilink]]` 解析/补全依赖笔记名索引，必须异步、可取消（atomic-editor 已是 async resolution 模式）。
- 未做实测；建议原型 ticket 用 10k 篇生成数据 + 大单篇（如 5k 行）测试打开、滚动、输入延迟。

---

## 可行性汇总

| 需求 | 现成可用 | 需自研 | 风险 |
|---|---|---|---|
| CM6 live preview（标题/强调/图片/光标行源码） | 社区库/参考实现 | 内化与打磨 | 小项目维护风险；边界交互（IME、选区、点击隐藏标记） |
| `[[wikilink]]` 渲染 + 补全 | atomic-editor 有 | Lezer 扩展 + 索引对接 | 低 |
| Mermaid 默认渲染 + 代码编辑切换 | Milkdown 有；CM6 无 | CM6 block widget（数百行） | widget 高度/异步渲染抖动 |
| 工作区对比 / 历史对比 | Monaco diff、`@codemirror/merge` 均可 | 无 | 低 |
| 冲突解决（三方） | 仅 VSCode merge editor（经 monaco-vscode-api 的 workbench） | 冲突标记 + 接受按钮（小）或三栏视图（大） | 方案选择决定工作量 |
| 两套编辑器统一体验 | — | token/主题/键位适配层 | 持续成本，高亮最难对齐 |

## 建议（含取舍，决策留给后续 ticket）

1. **方案 A（推荐默认）：CM6 单栈**——live preview + `@codemirror/merge` 负责工作区/历史对比；冲突解决 MVP 用"冲突标记 + 行内接受按钮"，后续再做三栏。
   - 优：体验天然一致、包体小、一套扩展体系；diff 两侧可复用 live preview 外的同一高亮/主题。
   - 劣：diff 打磨度低于 VSCode（无移动检测、算法较朴素）；三方合并全部自研。
2. **方案 B：CM6 编辑 + Monaco diff（两方）**——即当前倾向的"双编辑器分工"。
   - 优：diff 体验与 VSCode 同源。
   - 劣：Q3 所述持续统一成本；Monaco 同样无三方合并，冲突解决仍需自研；多了一个重依赖。
3. **方案 C：嵌入 VSCode workbench（`monaco-vscode-api`）获取 merge editor**——仅在"冲突解决必须达到 VSCode merge editor 水平"时考虑。
   - 劣：底座级改变、非公开 API、包体与初始化约束；不推荐用于 MVP。

**建议原型验证点**：(a) 用 `@codemirror/merge` 与 Monaco diff 并排跑同一组真实笔记 diff（段落重排、表格改动、长行），主观对比；(b) CM6 Mermaid block widget 的输入/滚动稳定性；(c) 冲突标记 + 接受按钮在 CM6 上的实现成本。
