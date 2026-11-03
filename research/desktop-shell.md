# 桌面外壳调研：Electron / Tauri / VSCode fork / VSCode 扩展

> Ticket：[#3](https://github.com/nathan-tj-xie/synote/issues/3) · 地图：[#1](https://github.com/nathan-tj-xie/synote/issues/1) · 调研日期：2026-11-03
>
> 本文只给事实、来源和带取舍的倾向，**不做决策**；选型由后续 ticket / ADR 拍板。

## 0. 评判标准（来自地图 #1 Notes）

- 首要标准：VSCode 级的**编辑体验与 diff 体验**（双编辑器：实时预览编辑器 + Monaco diff editor）。
- macOS + Windows；未签名包，GitHub Releases 分发，无自动更新。
- 规模：≤ 10,000 篇笔记、附件 ≤ 5 GB；打开库 3 秒内可用，搜索 200 ms 内返回。
- git 只做手动模式，认证依赖系统 git 配置/凭据。
- 附件文件夹在文件树中隐藏；Diff 覆盖工作区对比、冲突解决、历史对比（源码层面）。
- TypeScript 与 Rust 都可以。

## 1. 当前版本（2026-11-03 核对）

| 组件 | 版本 | 来源 |
|---|---|---|
| Electron | v45.2.1（2026-10-31），Chromium 156.0.8078.75 / Node 24.22.1 / V8 15.6 | [releases](https://releases.electronjs.org/release/v45.2.1) |
| Electron 发版节奏 | 每 8 周一个 major，只支持最新 3 个 major | [Electron timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) |
| Tauri | `tauri` v2.12.5 / `tauri-cli` v2.12.4（2026-10-21）；v3.0.0-alpha.5 在预览 | [tauri releases](https://github.com/tauri-apps/tauri/releases) |
| Tauri CEF runtime | `tauri-runtime-cef` 3.0.0-alpha.x（2026-09 起），alpha 阶段 | [release](https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.0)、[docs.rs](https://docs.rs/crate/tauri-runtime-cef/3.0.0-alpha.5) |
| VS Code | 1.144.0（2026-10-28），按月发版 | [microsoft/vscode releases](https://github.com/microsoft/vscode/releases) |
| VSCodium | 1.143.17232（2026-10-28） | [VSCodium releases](https://github.com/VSCodium/vscodium/releases) |
| monaco-editor | 0.57.0（2026-09-24） | npm / [releases](https://github.com/microsoft/monaco-editor/releases) |
| CodeMirror 6 | `@codemirror/view` 6.43.15、`@codemirror/state` 6.7.6 | npm |
| Eclipse Theia（参考） | v1.76.0 | [releases](https://github.com/eclipse-theia/theia/releases) |
| git 库 | `isomorphic-git` 1.44.10、`dugite` 3.3.2、`simple-git` 4.0.2；Rust `git2` 0.21.0、`gix` 0.90.0 | npm / crates.io |
| 文件监听 | `@parcel/watcher` 2.6.0、`chokidar` 6.0.0；Rust `notify` 9.0.0-rc.7 | npm / [notify releases](https://github.com/notify-rs/notify/releases) |

## 2. 四条路线概述

| 路线 | 一句话 |
|---|---|
| **A. Electron** | 自带 Chromium + Node。Monaco、CodeMirror 6 都在 Chromium 下开发和测试。Obsidian、VS Code 本身都是 Electron 应用。 |
| **B. Tauri 2** | Rust 后端 + 系统 WebView（macOS 用 WKWebView，Windows 用 WebView2/Chromium）。包小，但 macOS 上的渲染引擎是 WebKit。 |
| **C. Fork VSCode** | 类 Cursor/VSCodium：fork `microsoft/vscode`，改 workbench。拿到完整 VS Code 的编辑、diff、merge editor、SCM。 |
| **D. VSCode 扩展** | 发布一个扩展（加 profile/推荐设置），寄生在用户已装的 VS Code 中。 |

## 3. 逐项回答 ticket 问题

### 3.1 Monaco 与实时预览编辑器在 WebKit（macOS Tauri）与 WebView2 下的已知问题

**结论：WebView2 下基本没有额外风险（它就是 Chromium）。macOS WKWebView 下 Monaco 和 CM6 都有一批没修的 WebKit 专属 bug，其中输入法（IME）相关的对中文用户影响最大。** 另外 WKWebView 的版本跟着用户的 macOS / Safari 走，开发者锁不住版本，同一个包在不同 macOS 版本上表现可能不一样。

Monaco + Safari/WebKit 未关闭的 issue（节选）：
- 中文输入时行上下跳动，只在 Safari 出现：[monaco-editor#4796](https://github.com/microsoft/monaco-editor/issues/4796)（open）
- 在反向选区上打字，第一个按键被吞：[#5390](https://github.com/microsoft/monaco-editor/issues/5390)、[#5448](https://github.com/microsoft/monaco-editor/issues/5448)（open，2026）
- `installWebKitWriteTextWorkaround` 每次点击/按键都泄漏一个未处理的 rejection：[#5458](https://github.com/microsoft/monaco-editor/issues/5458)
- Safari 27 / WKWebView 下 background tokenizer 报错：[#5563](https://github.com/microsoft/monaco-editor/issues/5563)（2026-10-30）
- 多行编辑、跨行复制粘贴丢换行：[#3480](https://github.com/microsoft/monaco-editor/issues/3480)、[#3969](https://github.com/microsoft/monaco-editor/issues/3969)
- 早年 WKWebView（Catalyst）里滚动、复制粘贴、全选失效：[#2205](https://github.com/microsoft/monaco-editor/issues/2205)

Tauri 侧与编辑器/输入相关的问题：
- **macOS：第三方输入法（微信输入法等）在 Tauri WebView 里第一个按键丢失，同一页面在 Safari 里正常**：[tauri#15924](https://github.com/tauri-apps/tauri/issues/15924)（open，2026-08）。说明不只是 WebKit 引擎的问题，还和 WKWebView 的宿主集成有关。
- **Windows：WebView2 下，已有文本的 textarea/contenteditable 第一次获得焦点时 TSF 输入法冻结，CJK 输入被阻塞**：[tauri#15436](https://github.com/tauri-apps/tauri/issues/15436)（open，2026-05；复现用的是 TipTap/ProseMirror）。这个问题出在 WebView2 宿主，不是 Chromium 本身，Electron 没有这层。
- Windows 下多窗口切换后 IME 候选框位置错乱：[tauri#16391](https://github.com/tauri-apps/tauri/issues/16391)（open）
- Monaco 在 Tauri 里的快捷键/剪贴板问题（Cmd+Z、Cmd+A、剪贴板权限）：[#9426](https://github.com/tauri-apps/tauri/issues/9426)、[#12059](https://github.com/tauri-apps/tauri/issues/12059)、[#14309](https://github.com/tauri-apps/tauri/issues/14309)（均已 closed，说明需要额外接线，但都能解决）

CodeMirror 6（实时预览编辑器的候选底座）在 Safari 下：
- 韩文输入后回车插入两个换行：[codemirror/dev#1403](https://github.com/codemirror/dev/issues/1403)（open）
- 长文档折行时滚动条异常（iOS/Safari）：[#1278](https://github.com/codemirror/dev/issues/1278)（open）
- 其余 Safari/iOS 问题大多已修。CM6 作者对 Safari 的支持比 Monaco 积极，Obsidian 的实时预览就建在 CM6 上（Obsidian 是 Electron 应用，所以 macOS 上跑的是 Chromium）。

缓解办法：Tauri 有 CEF（Chromium）runtime，但现在只是 `tauri-runtime-cef` 3.0.0-alpha，Linux 上一串键盘/焦点 bug 还开着（如 [#16251](https://github.com/tauri-apps/tauri/issues/16251)、[#16351](https://github.com/tauri-apps/tauri/issues/16351)），官方还没发稳定版。用了 CEF，包体积优势也就没了。

### 3.2 安装包体积与内存

- Tauri 官方说法：最小应用 < 600 KB，因为复用系统 WebView（[Tauri 文档](https://v2.tauri.app/start/)）。
- 第三方实测差别很大：
  - Hopp 的 6 窗口 demo：Tauri 包 8.6 MiB / 内存 172 MB，Electron 包 244 MiB / 内存 409 MB（[dev.to](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)）。
  - 另一个较重应用的对比：包 57 MB vs 323 MB，**内存只差 109 MB vs 128 MB**，并提醒 macOS 的 WebView 进程单独计数，容易把 Tauri 的内存算少（见 [stork.ai](https://www.stork.ai/blog/electrons-reign-is-over-heres-why) / [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/)，数字出处未能逐一核对）。
- 小结：**包体积 Tauri 稳定小一个数量级；内存优势在 0–50% 之间，取决于窗口数和怎么统计**。对单窗口笔记应用来说，内存大头是 Monaco/CM6 和索引数据，外壳的差别是次要的。
- 路线 C 的包体积和内存约等于 VS Code 本身（Electron + 整个 workbench + 内置扩展），是四条路线里最重的。路线 D 没有额外包体积（用户已经装了 VS Code），但运行在 VS Code 的多进程（extension host + webview）里。
- 分发是未签名包：macOS Apple Silicon 至少需要 ad-hoc 签名，用户首次打开仍要在系统设置里手动放行（[Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)）。Electron 也一样，这一点和外壳选择无关。

### 3.3 文件监听与大目录（10k 笔记、5 GB 附件）

- 两个外壳都能直接用操作系统的递归监听（macOS FSEvents、Windows ReadDirectoryChangesW）：
  - Electron/Node：`@parcel/watcher`（VS Code 自己用的就是它）或 `fs.watch({recursive:true})`；`chokidar` 6。
  - Tauri/Rust：`notify` crate（`tauri-plugin-fs` 的 `watch` 特性就基于它），配 `notify-debouncer-full`。
- 监听开销按**事件数**算，跟文件字节数无关。5 GB 附件只要不读内容，对监听没有压力；10k 个文件对 FSEvents/RDCW 来说不算多。
- 真正的瓶颈在别处，而且基本与外壳无关：
  1. **首次扫描和建索引**（3 秒内可用、200 ms 搜索）：要把 10k 篇 Markdown 读进来解析链接。Rust 可以用 `ignore`/`grep` crate（ripgrep 的内核）或 `tantivy` 并行处理；Node 侧可以 spawn `@vscode/ripgrep`，或在 worker 里建内存索引。Rust 的余量更大，但 Node 也够用。具体方案在"搜索与反链索引方案" ticket 里定。
  2. **git 对 5 GB 二进制附件的处理**（`git add`/`status` 要哈希、要 stat），属于"大附件与 Git LFS" ticket，跟外壳无关。
- 路线 C/D 用的是 VS Code 自己的 watcher 和 `files.watcherExclude`/`search.exclude`，可以排除附件目录。但 VS Code 的全文搜索（ripgrep）只适合即时搜索，反链索引还得自己写。

### 3.4 调用系统 git 与嵌入 git 库的便利性

需求是"认证依赖系统已有 git 配置/凭据"，所以**首选 spawn 系统 `git` CLI**：credential helper、SSH agent、`includeIf` 这些都能自动生效。

| 方式 | Electron (TS) | Tauri (Rust) | 备注 |
|---|---|---|---|
| spawn 系统 git | `child_process` / `simple-git` 4.0.2 | `std::process::Command`（写在 Rust command 里，不需要开放 shell 插件给前端） | 两边一样方便。Windows 要求用户已装 Git for Windows，并要处理 PATH 探测 |
| 内置 git 二进制 | `dugite` 3.3.2（GitHub Desktop 在用） | 自行打包 sidecar | 包体积增加几十 MB，但不再依赖用户环境 |
| 纯库 | `isomorphic-git` 1.44.10：纯 JS，大仓库慢，不走系统 credential helper | `git2` 0.21（libgit2）：成熟，凭据要自己接（`Cred::credential_helper`）；`gix` 0.90：快，但 **push 还没实现**（[crate-status](https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md)、[discussion#2810](https://github.com/GitoxideLabs/gitoxide/discussions/2810)） | 读历史、读 blob、算 diff 可以用库加速，写操作和网络操作走 CLI |
| 路线 C/D | 直接复用 VS Code 内置 Git 扩展（底层也是 spawn 系统 git） | — | 冲突解决可以复用 VS Code 的 3-way merge editor |

结论：git 方面 A 和 B 打平，C 和 D 白送一整套 SCM，包括 merge editor。

### 3.5 VSCode fork 的上游合并维护成本

- VS Code 每月一个版本（现在 1.144）；它依赖的 Electron 每 8 周一个 major，并且只保留 3 个 major 的支持（[Electron timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)），fork 不跟着走就会用上没有安全支持的 Chromium。
- 有资金的团队也跟不上：Cursor 论坛里，用户反复抱怨底座落后上游，一度停在 1.99.3、1.105.1（当时上游已到 1.125）；2026 年才追到 1.128。官方解释是"升级占用工程时间"、"每次 Electron/Chromium 升级都有回归风险"（[论坛 1](https://forum.cursor.com/t/urgent-the-1-105-vs-code-base-is-now-5-months-old-we-need-a-modern-upstream-sync/164204)、[论坛 2](https://forum.cursor.com/t/request-please-bump-the-underlying-vs-code-extension-api-electron-version-to-the-latest-upstream-release/166421)、[论坛 3](https://forum.cursor.com/t/cursor-still-on-vscode-1-99-3-update-plans/135066)）。落后的直接后果是新扩展因 `engines.vscode` 版本要求装不上。
- 扩展生态受限：fork 不能用 Microsoft Marketplace，只能用 Open VSX（规模小得多，也出过停机事故）。Microsoft 的部分扩展（C/C++ cpptools、Pylance）在二进制层面拒绝在 fork 里运行（[winbuzzer 2025-04](https://winbuzzer.com/2025/04/26/microsoft-blocks-popular-c-extension-in-visual-studio-code-forks-xcxwbn/)）。这对笔记应用影响不大，但说明 fork 拿不到官方 VS Code 的全部能力。
- VSCodium 的做法是在上游源码上打补丁（`patches/` 目录）然后重新构建，只做去品牌和去遥测，补丁量很小，所以能当天跟上。**Synote 要改 workbench 布局、加实时预览，补丁会深入 `src/vs/workbench`，冲突面远大于 VSCodium。**
- 对"一个人 dogfooding、之后开源"的项目来说，fork 的持续维护成本是四条路线里最高的，而且这笔成本**永远存在**。
- 折中参考：Eclipse Theia（v1.76.0）是专门用来"做自己的 IDE 产品"的框架，基于 Monaco，不用 fork。但它的 diff/merge 体验和 VS Code 不完全一样，而且同样很重。本文不展开。

### 3.6 扩展路线能否做出独立产品形态

| 需求 | 扩展能否做到 | 依据 |
|---|---|---|
| 实时预览 | **能做，但只能在 webview 里**：用 `CustomTextEditorProvider` 以 `TextDocument` 为模型，webview 里嵌 CM6。原生文本编辑器不能隐藏字符（[vscode#286296](https://github.com/microsoft/vscode/issues/286296) 还是 open 的 feature request），inline widget 所需的 editor insets API 从 2019 年起一直是 proposed（[#85682](https://github.com/microsoft/vscode/issues/85682)），proposed API 不能在 Marketplace 发布的扩展里用 | [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) |
| ↳ 重要新事实 | **VS Code 自己已经内置了一个实验性的 WYSIWYG/Hybrid Markdown Editor**（`vscode.markdown.editor`，在 `markdown-language-features` 里，通过 Reopen Editor With 打开），也是 custom editor + webview，还提供了代码块编辑器的扩展点。但它目前有 CJK IME 问题（[#340727](https://github.com/microsoft/vscode/issues/340727)、[#337197](https://github.com/microsoft/vscode/issues/337197)）和随文档变大的打字延迟（[#344635](https://github.com/microsoft/vscode/issues/344635)） | [源码](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/src/preview/markdownEditorProvider.ts) |
| 隐藏附件文件夹 | 能：`files.exclude`（工作区设置，或扩展的 `configurationDefaults`），也可以加 `FileDecorationProvider` | VS Code 设置 |
| 自定义 diff 流程 | 大部分能：`vscode.diff` 命令打开原生 diff editor，`scm.createSourceControl` + `quickDiffProvider` 接入，或者直接用内置 Git 扩展和 merge editor。**但 diff 只能用 VS Code 原生的那套 UI 和布局** | [VS Code API](https://code.visualstudio.com/api/references/vscode-api) |
| 统一快捷键/主题 | 一半：webview 里的 CM6 要自己读 VS Code 主题 CSS 变量；快捷键要用 `when: activeCustomEditorId == ...` 再转发给 webview；保存在 webview 隐藏时也可能触发，需要 `retainContextWhenHidden`，文档明说"内存开销显著" | Custom Editor 文档 |
| 双链、反链、快速切换、搜索 | 能：DocumentLinkProvider、ReferenceProvider、QuickPick、TreeView | VS Code API |
| **独立产品形态** | **不能**：不能去掉活动栏/菜单、不能改窗口外观和品牌、不能控制启动流程；用户得先装 VS Code，"笔记库"就是一个 VS Code workspace。最多做到"VS Code + 一个推荐 profile" | — |

结论：扩展路线用最少的代码就能拿到 **diff/冲突/历史这一整套首要体验**，代价是放弃独立产品形态，实时预览也必须放在 webview 里，跟 diff 编辑器做不到真正同构。

## 4. 对比表

评分：●●● 好 / ●● 中 / ● 差

| 维度 | A. Electron | B. Tauri 2 | C. Fork VSCode | D. VSCode 扩展 |
|---|---|---|---|---|
| 首要标准：编辑 + diff 体验 | ●●（Monaco diff 直接用；冲突解决的 3-way UI 要自己做，standalone Monaco 没有 merge editor） | ●~●●（同 A，另加 macOS WebKit/IME 风险） | ●●●（原生 diff、merge editor、SCM 全有） | ●●●（同 C，但实时预览在 webview 里） |
| 实时预览实现自由度 | ●●●（CM6，Chromium，与 Obsidian 同栈） | ●●（CM6 能用，Safari/WKWebView IME 问题要逐个绕） | ●●（可以改源码，但要和 workbench 集成） | ●●（只能 webview custom editor） |
| macOS 渲染一致性 | ●●●（自带 Chromium） | ●（WKWebView 跟系统版本走） | ●●● | ●●● |
| Windows 渲染一致性 | ●●● | ●●（WebView2 是 Chromium，但有宿主层 IME bug #15436） | ●●● | ●●● |
| 包体积 | ●（约 100–250 MB） | ●●●（个位数到几十 MB） | ●（≥ VS Code 本身） | ●●●（只有扩展本身） |
| 内存 | ●● | ●●~●●●（优势 0–50%） | ● | ●（寄生在 VS Code 里） |
| 文件监听 / 大目录 | ●●●（@parcel/watcher） | ●●●（notify；Rust 建索引余量更大） | ●●●（VS Code watcher） | ●●●（同 C） |
| 系统 git 调用 | ●●● | ●●● | ●●●（内置 Git 扩展） | ●●●（内置 Git 扩展） |
| 独立产品形态 | ●●● | ●●● | ●●● | ●（就是 VS Code） |
| 长期维护成本 | ●●（跟 Electron major） | ●●（跟 Tauri 2.x，较稳定） | ●（月度 rebase + Electron 升级） | ●●●（API 稳定） |
| 语言栈 | TS | TS + Rust | TS（巨大代码库） | TS |
| 首个 MVP 的工作量 | 中 | 中偏高（多了 Rust 和 WebKit 适配） | 高（熟悉 workbench 的成本） | 低 |

## 5. 倾向与取舍（供决策 ticket 参考，不是决定）

1. **如果坚持独立产品 + 双编辑器（地图目前的方向）：Electron 风险最低。** 理由：
   - 首要标准是编辑体验。Electron 的 macOS 和 Windows 都是同一个版本锁定的 Chromium，Monaco 与 CM6 都在主场，同栈有 Obsidian（CM6 实时预览）和 VS Code（Monaco diff）做先例。
   - Tauri 的主要收益（包体积、部分内存）不在地图的评判标准里；它的主要风险（macOS WKWebView 下 Monaco/CM6 和中文 IME 的问题，如 tauri#15924、monaco#4796）恰好落在首要标准上。
   - Rust 在索引和扫描上的优势，Electron 也能通过 Node 原生模块 / napi-rs 或 sidecar 补上，等需要时再说。
   - 取舍：包体积大一个数量级；要自己做冲突解决的 3-way UI（standalone Monaco 没有 VS Code 的 merge editor）。
2. **Tauri 只有在原型证明 macOS 上 Monaco diff + CM6 实时预览 + 中文输入法（系统拼音 + 微信等第三方输入法）都可接受时才值得选。** 等 Tauri CEF runtime 稳定后可以重新评估，但那时它就不再有包体积优势。
3. **扩展路线是最便宜的"验证器"**：几天就能用上 diff/冲突/历史 + webview 实时预览，适合 dogfooding 期先验证工作流。缺点是没有独立产品形态，而且 VS Code 官方的实验性 Markdown Editor 已经在做重叠的事，差异化空间会被压缩。
4. **Fork VSCode 不建议**：唯一的独特收益是"完整 VS Code diff/merge + 独立品牌"，但上游追赶成本连 Cursor 都承受不了，单人项目扛不住。

建议原型 ticket 优先验证（与外壳无关、但决定外壳）：在 Electron 和 Tauri(macOS) 中各跑一遍"CM6 实时预览 + Monaco diff editor + 中文 IME（系统拼音、微信输入法）"，打开 10k 篇笔记的库测首屏时间。

## 6. 未验证 / 局限

- 内存与体积数字来自第三方 demo，没有在 Synote 的实际负载下测过。
- 没有实测 Monaco diff editor 在 WKWebView 下的表现，只汇总了公开 issue。
- Tauri CEF runtime 的官方路线图没有找到。
- 对 VS Code 实验性 Markdown Editor 只看了 issue 和入口源码，没有评估它的完成度和是否会转正。
