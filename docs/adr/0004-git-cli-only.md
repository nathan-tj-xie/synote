# git 集成只用系统 git CLI 子进程

Synote 的所有 git 操作都通过子进程调用 git CLI（要求 ≥ 2.38），不引入 isomorphic-git、nodegit、libgit2 或 gitoxide。原因：只有 CLI 能无条件复用系统已有的 git 配置和凭据（产品不做应用内认证），能拿到完整的冲突三方数据（index stage 1/2/3、`MERGE_HEAD`、`merge --abort/--continue`），并且和用户在终端里的操作语义一致；性能也足够，本机 12.5k 个文件的 `git status` 只要 47 ms（#4）。

## Consequences

- 批量读取历史版本的文件内容时，用常驻的 `git cat-file --batch` 进程，不要每次读取都新起一个 `git show`。
- 需要解析 porcelain 输出（`status --porcelain=v2 -z`、`log --format`），并统一处理 `-z` 分隔和路径编码。
- 依赖用户机器上装了 git，不内置 dugite-native（#12）。查找顺序：设置项里的 git 路径（按本机存在应用数据目录）→ macOS 登录 shell 的 `PATH`（`$SHELL -ilc`，3 s 超时）→ 当前 `PATH`，每一级都要求 `git --version` ≥ 2.38；macOS 上先用 `xcode-select -p` 检查 CLT，避免触发 `/usr/bin/git` shim 的安装弹窗。
- 没有可用 git 时按非 git 目录模式运行，git 面板显示引导（没找到 / 版本太低，带"重新检测"和"打开设置"），不弹模态框。缺 `user.name` / `user.email` 时只给出可复制的 `git config --global` 命令并禁用提交，应用不代写 git 配置。
