# git 集成只用系统 git CLI 子进程

Synote 的所有 git 操作都通过子进程调用 git CLI（要求 ≥ 2.38），不引入 isomorphic-git、nodegit、libgit2 或 gitoxide。原因：只有 CLI 能无条件复用系统已有的 git 配置和凭据（产品不做应用内认证），能拿到完整的冲突三方数据（index stage 1/2/3、`MERGE_HEAD`、`merge --abort/--continue`），并且和用户在终端里的操作语义一致；性能也足够，本机 12.5k 个文件的 `git status` 只要 47 ms（#4）。

## Consequences

- 批量读取历史版本的文件内容时，用常驻的 `git cat-file --batch` 进程，不要每次读取都新起一个 `git show`。
- 需要解析 porcelain 输出（`status --porcelain=v2 -z`、`log --format`），并统一处理 `-z` 分隔和路径编码。
- 依赖用户机器上装了 git。是要求预装，还是内置 dugite-native 作为回退，尚未决定（见 #1 的 Not yet specified）。
