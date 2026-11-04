# 桌面外壳使用 Electron

Synote 的桌面外壳选用 Electron，不用 Tauri，也不 fork VSCode、不做成 VSCode 扩展。原因：Electron 自带 Chromium，macOS 和 Windows 上的渲染与输入法行为一致，和 VSCode 同源，Monaco 在这个环境里经过了最充分的验证；Tauri 在 macOS 上用的是系统 WebKit，存在已知的 Monaco 和中文输入法问题（monaco#4796、tauri#15924）。原型（#6）实测 10k 篇笔记库的首屏时间两种外壳都低于 1.8 s，所以性能不构成区分。

## Consequences

- 安装包更大（相比 Tauri 多出 Chromium 的体积），在 GitHub Releases 发未签名包的方案下可以接受。
- 主进程使用 Node，文件系统、git 子进程、索引都放在主进程或 utility process 里，通过 IPC 交给渲染进程。
