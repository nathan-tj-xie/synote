# 渲染进程 UI 使用 React

渲染进程的外围 UI（文件树、git 面板、搜索、设置、快速切换）用 React 19 + TypeScript 实现，不用 Vue、Svelte，也不像 VSCode 那样不用框架。CM6 和 Monaco 都是命令式 API，换哪个框架集成成本都一样，所以选型只看两点：现成组件够不够，贡献者熟不熟。目标贡献者是懂 git 的开发者，React 在这两点上都占优；Electron 从本地加载，框架运行时的体积差异可以忽略（#14）。

配套选型：

- **样式**：CSS Modules。颜色只维护一份 TS token 表，由它生成 CSS 变量（React UI 和 CM6 使用），同时生成 Monaco 的 `defineTheme`。菜单、对话框、Tooltip 等交互组件用 Radix primitives。不用 Tailwind，也不用完整的 UI 库。只做深色主题。
- **状态**：Zustand，按领域拆 store（vault / git / editor …）。渲染进程的状态大多是主进程状态的只读镜像，通过带类型的 `contextBridge` 交给渲染进程：命令走 `invoke`，状态变化由主进程推送事件，类型定义两边共享。
- **文件树**：`@headless-tree/react` + `@tanstack/react-virtual`。
- **快速切换 / 命令面板**：共用一个组件，用 Radix Dialog + 虚拟列表 + `fuzzysort` 拼起来，不用 `cmdk`（它没有虚拟化，10k 项时会卡）。命令注册表同时是快捷键的唯一来源。
- **布局**：活动栏 + 侧边栏 + 单个编辑器组（标签页）+ 历史栏，各区之间的分隔条用 `react-resizable-panels` 实现。MVP 不做分屏。
- **编辑器封装**：CM6 和 Monaco 各自写一层薄封装，不用 `@uiw/react-codemirror` / `@monaco-editor/react`（后者默认从 CDN 加载 Monaco）。编辑器状态按标签页缓存，不放进 React state。
- **构建与打包**：`electron-vite` + `electron-builder`，在 GitHub Actions 的 macOS 和 Windows runner 上分别出未签名安装包。
- **多语言**：`i18next` + `react-i18next`，key 有类型约束，按命名空间组织，主进程和渲染进程共用同一份资源。MVP 只提供 `zh-CN`。
- **测试**：单元测试和组件测试用 Vitest + `@testing-library/react`，端到端测试用 Playwright `_electron`，在 CI 上跑双平台。agent-browser 只用于开发时在真实应用里验证和做探索式 QA，不进 CI。

## Consequences

- 大列表（文件树、搜索结果、git 变更列表）必须用 selector 精确订阅，并做虚拟化，否则一个文件的状态变化就会触发整树重渲染。
- 以后要加浅色主题或自定义主题，只需在 token 表里加一套值，组件里不允许硬编码颜色。
- 分屏留到 MVP 之后再做，到时要把标签页模型从单个列表改成编辑器组的树结构。
