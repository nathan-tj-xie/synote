# PROTOTYPE · 编辑器原型（#6）

> 用完即弃，只存在于 `prototype/editor` 分支，不要合入 main。

要回答的问题：日常编辑统一用 CM6 实时预览，diff 视图用哪一种？
- **A**：`@codemirror/merge`（同一套 CM6 扩展、主题、键位）
- **B**：Monaco diff editor（懒加载，`vs-dark` 主题）

## 运行

```sh
pnpm install          # 第一次；如果 electron 二进制没下载下来：node node_modules/electron/install.js
pnpm gen-vault        # 生成 .vault-10k（10k 篇假笔记，wipe me）
pnpm dev              # 浏览器：http://localhost:5173/?variant=a&mode=edit（只有内置示例笔记）
pnpm electron         # Electron + 10k 库
pnpm tauri dev        # Tauri（macOS WebKit）+ 10k 库
```

`SYNOTE_VAULT=/path/to/vault` 可以换成真实笔记库（无 git 时以打开那一刻的内容作为 HEAD）。

- 底部浮条或 ← / → 切换 A/B；`⌘/Ctrl+Shift+D` 在编辑和 diff 之间切换。
- 左栏有手测清单和性能数据。

## 已测数据（2026-11-03，macOS，dev 模式，10k 篇 / 39 MB）

| | Electron 45 | Tauri 2（debug 构建） |
|---|---|---|
| 列目录（IPC + fs） | 163–894 ms | 67 ms |
| 文件树渲染（10k 个 div，未虚拟化） | 67–297 ms | 248 ms |
| 打开首篇笔记 | 12–20 ms | 108 ms |
| 从页面导航到首屏 | 513–1794 ms | 707 ms |
| Monaco 懒加载 + 挂载（浏览器） | 373 ms（首次未缓存 1144 ms） | — |

注意：Electron 的 Vite dev server 和 IPC 在同一个主进程里，所以 fs 耗时被抬高了，波动也大（主进程内 fs 耗时 143–682 ms；单独用 Node 遍历只要 8 ms）。两个外壳都远低于 3 秒的预算。

## 还需人工判断

- A/B 的 diff 手感：对齐、字符级高亮、还原按钮、折叠未改区。
- 中文输入法（系统拼音、微信输入法），分别在 Electron / Tauri 的编辑模式和 diff 右侧测。
- 快捷键一致性（A 用 `@replit/codemirror-vscode-keymap`，B 用 Monaco 原生键位）。
