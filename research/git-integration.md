# git 集成方式调研（Ticket #4）

> 调研日期：2026-11-03。这里只给建议和取舍，**选型由后续 ticket / ADR 决定**。
> 产品约束（map issue #1 Notes）：只做手动 git 模式；认证依赖系统已有 git 配置/凭据；macOS + Windows；≤ 10k 笔记、附件 ≤ 5 GB；GitHub Releases 未签名包；TypeScript 和 Rust 都可以。

## 1. 候选方案与当前状态

| 方案 | 形态 | 当前版本（2026-11-03） | 维护状态 |
|---|---|---|---|
| 系统 `git` CLI | 用子进程调用 `git` 可执行文件 | git **v2.56.0**；Apple 自带 2.54.0 (Apple Git-157) | 非常活跃 |
| 内置 git CLI（`dugite` / dugite-native） | 应用里打包一份 git 二进制 | dugite **3.3.2**（npm，2026-10-26）；dugite-native **v2.56.0-2** | 活跃，GitHub Desktop 在用 |
| `isomorphic-git` | 纯 JS 实现 | **1.44.10**（npm，2026-11-02） | 活跃（最近 push 2026-11-02），open issues 312 |
| `nodegit`（libgit2 的 Node 绑定） | 原生 Node addon | latest 仍是 **0.27.0**（**2020-07** 发布），`next` 为 0.28.0-alpha.38（2026-04） | 半停滞：6 年没有稳定版 |
| `git2-rs`（libgit2 的 Rust 绑定） | Rust crate + C 库 | git2 **0.21.0** / libgit2-sys 0.18.8+**1.9.7**（2026-10-06）；上游 libgit2 已发 v2.0.0-rc.1（2026-10-14） | 活跃 |
| `gitoxide`（`gix`） | 纯 Rust 实现 | gix **0.90.0**（2026-10-22） | 非常活跃（最近 push 2026-11-03），但功能还没补齐 |

数据来源：`npm view`、crates.io API、GitHub API（各仓库 `pushed_at` / releases）。

## 2. 逐项对比

### 2.1 冲突三方数据（base / ours / theirs）读取与写回

- **git CLI**：冲突后 index 里保留 stage 1/2/3。`git ls-files -u` 列出冲突文件，`git show :1:<path>` / `:2:` / `:3:` 分别取 base / ours / theirs；解决后写回文件，再 `git add <path>` 清除冲突。`git merge-file -p` 可以在内存里重新做三方合并，`git merge-tree --write-tree`（2.38+）能在不碰工作区的情况下预演合并。语义和 git 完全一致，`MERGE_HEAD`、`git merge --abort/--continue` 都是现成的。
  - 来源：https://git-scm.com/docs/git-ls-files 、 https://git-scm.com/docs/gitrevisions （`:<n>:<path>` 语法）、 https://git-scm.com/docs/git-merge-tree
- **libgit2（git2-rs / nodegit）**：`git_index_conflict_get` 返回 ancestor/our/their 三个 index entry，用 `git_index_conflict_remove` 或重新 `add` 写回；git2-rs 对应 `Index::conflicts()`。`git_merge` 会写 `MERGE_HEAD` 等状态。但它**没有 `pull`**，要自己串 fetch → merge analysis → merge → commit。
  - 来源：https://libgit2.org/docs/reference/main/index/git_index_conflict_get.html 、 https://docs.rs/git2/latest/git2/struct.Index.html
- **isomorphic-git**：`merge` 默认用 diff3 合并。冲突时默认 `abortOnConflict: true`，此时**工作区和 index 都不写**，直接抛 `MergeConflictError`；设成 `abortOnConflict: false` 才会把带冲突标记的文本写进文件。`mergeDriver` 回调能拿到 `contents[0..2]`（base/ours/theirs），可以把三方内容交给 UI。但它不会像 git 那样在 index 里留下 stage 1/2/3 冲突状态，和外部 git 工具互操作要自己兜底。也不支持 rebase（issue #189、#1527 仍是 open）。
  - 来源：https://github.com/isomorphic-git/isomorphic-git/blob/main/docs/mergeDriver.md 、 https://isomorphic-git.org/docs/en/merge
- **gitoxide**：`gix-merge` 已经能做 blob/tree/commit 三方合并，并生成带 stage 的 index。但 crate-status 明确写着以下还没完成：**持久化 `MERGE_HEAD`/`MERGE_MSG`、`merge --continue/--abort` 流程、checkout/reset 编排**。也就是说它能“算出冲突”，还不能“完成一次 pull 合并”。
  - 来源：https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md （gix-merge 一节与 “merge workflow orchestration”）

### 2.2 单文件历史与任意 commit 版本读取

- **git CLI**：`git log --follow --format=... -- <path>`（会跟踪重命名）；读任意版本用 `git show <rev>:<path>`，批量读 blob 用 `git cat-file --batch` 长连接，性能好。
- **libgit2**：没有内置 `--follow`，要用 revwalk 逐个 commit 比较 tree entry 自己实现；读任意版本用 `Tree::get_path` + `find_blob`。
- **isomorphic-git**：`git.log({ filepath, follow })`（`follow` 跨重命名，见 `src/api/log.js`）；读版本用 `git.readBlob({ oid, filepath })`。
- **gitoxide**：要用 rev walk + `lookup_entry_by_path` 自己实现；`gix-blame` 已经有了，但 crate-status 里“rename tracking”还没完成。

### 2.3 HEAD ↔ 工作区对比

四种方式都能做到。Synote 的 diff 由 Monaco diff editor 渲染，后端真正要提供的只有两样：“读 HEAD 版本的 blob”和“status 变更列表”。git CLI：`git show HEAD:<path>` + `git status --porcelain=v2 -z`；libgit2：`diff_tree_to_workdir_with_index` / `statuses`；isomorphic-git：`statusMatrix` + `readBlob`；gix：`status`（tree/index ↔ worktree 已标记完成）。

### 2.4 性能：10k 笔记 + 5 GB 附件

> 本机基准（git CLI / git2 / gix / isomorphic-git 的 status 与单文件 log）见第 5 节。

先说结构上的结论：
- status 的成本取决于**文件数量**（stat 次数），和附件体积关系不大：已提交的大附件只要 mtime/size 没变，就不会被重新 hash。
- git CLI 还能开 `core.fsmonitor=true`（内置 fsmonitor daemon，macOS/Windows 都支持，git 2.37+）和 `core.untrackedCache=true`，让 status 的耗时只和改动量相关。libgit2 源码里除了测试仓库自带的 hook sample，没有 fsmonitor 相关代码（GitHub code search，2026-11-03）。gix 的 crate-status 把 fsmonitor / untracked-cache / split-index 列为未完成。
  - 来源：https://git-scm.com/docs/git-fsmonitor--daemon 、 https://git-scm.com/docs/git-update-index#_untracked_cache
- 真正的性能风险在**首次 `git add` 5 GB 附件**（要做 zlib 压缩）和 push 时的 pack 传输。这属于 map 里还没定的“大附件与 Git LFS”问题，跟选哪种集成方式无关。不过 isomorphic-git 是在 JS 里把整个对象读进内存再压缩，大文件更吃内存。

### 2.5 依赖系统已有凭据做 push/pull

| 方案 | HTTPS（credential helper，如 GCM、osxkeychain） | SSH（ssh-agent、`~/.ssh/config`） |
|---|---|---|
| git CLI | 原生支持，完全复用用户配置 | 原生支持，调用系统 OpenSSH，读 `~/.ssh/config` |
| dugite 内置 git | 复用用户全局 `~/.gitconfig` 里的 helper；dugite-native 还**自带 Git Credential Manager** | 调用系统 `ssh` |
| libgit2 / git2-rs | 没有自动机制：git2-rs 的 `Cred::credential_helper` 能调用配置里的 helper，但要在 `credentials` 回调里自己串起来 | 默认走 libssh2：只支持 ssh-agent 和显式指定的 key，**不读 `~/.ssh/config`**，不支持 `@cert-authority`，Windows 上不支持 MinGW/Cygwin 模拟的 socket。libgit2 1.9 新增了 `USE_SSH=exec`（调用系统 OpenSSH），但 git2-rs 的 `ssh` feature 仍然只走 libssh2 |
| isomorphic-git | **不支持** credential helper，只有 `onAuth` 回调，应用要自己拿账号/token；只支持 HTTP(S) smart protocol | **不支持 SSH**（issue #1419 仍是 open） |
| gitoxide | 已支持调用 `git credential` / helper cascade | fetch 能通过外部 `ssh` 完成，但 crate-status 里 **push 还没完成** |

佐证：
- Cargo 内置的 git 库是 libgit2。它的官方文档列出了内置 SSH 的上述限制，并建议用 `net.git-fetch-with-cli = true` 退回 git 可执行文件：https://doc.rust-lang.org/cargo/appendix/git-authentication.html
- GitButler 同时依赖 gix 0.90 和 git2 0.21，但把 push/fetch 单独放在 `gitbutler-git` crate 里**调用 Git CLI**。源码注释原文是 “utility library for pushing/fetching Git repositories using the Git CLI”：https://github.com/gitbutlerapp/gitbutler/blob/master/crates/gitbutler-git/src/lib.rs
- Zed 的 git 集成通过 git 可执行文件完成：优先用系统 git，没有时回退到内置的 git（`system_git_binary_path` / `bundled_git_binary_path`）：https://github.com/zed-industries/zed/blob/main/crates/git/src/repository.rs
- VS Code 要求用户先装好 Git（“Install Git on your machine. VS Code uses this installation for Git operations.”）：https://code.visualstudio.com/docs/sourcecontrol/overview

结论：map 里“认证依赖系统已有 git 配置/凭据”这条约束，**实际上只有 git 可执行文件能无条件满足**。库方案都要自己实现一部分认证逻辑，或者在 SSH 场景退回 CLI。

### 2.6 macOS / Windows 分发与依赖

| 方案 | 用户要不要预装 git | 包体积影响 | 其他 |
|---|---|---|---|
| 系统 git CLI | **要**。macOS 的 `/usr/bin/git` 是个 shim，没装 Xcode Command Line Tools 时会弹出安装提示；Windows 要装 Git for Windows | 0 | 要检测 git 是否存在、版本是否够（例如 `merge-tree --write-tree` 要求 ≥ 2.38） |
| 内置 git（dugite-native / MinGit） | 不用 | tar.gz 约：macOS arm64 60 MB、x64 64 MB、Windows x64 44 MB（含 Git LFS + GCM） | 未签名包里再带一套二进制，要验证 macOS Gatekeeper / 隔离属性的影响；Tauri 可以用 `externalBin` sidecar，Electron 直接用 dugite |
| isomorphic-git | 不用 | 很小（纯 JS） | 没有原生编译问题 |
| nodegit | 不用 | 原生 addon，要按 Electron ABI 预编译或重编译 | 只能在 Electron/Node 里用；稳定版停在 2020 年 |
| git2-rs | 不用 | 静态链接 libgit2（视 feature 加上 libssh2/OpenSSL），约几 MB | 适合 Rust 侧（Tauri）；Windows 下 OpenSSL/libssh2 要用 `vendored` feature 构建 |
| gix | 不用 | 纯 Rust，静态链接 | 网络 push 还没完成 |

来源：dugite-native release v2.56.0-2 的资产列表 https://github.com/desktop/dugite-native/releases ；dugite-native README（自带 Git-LFS 与 Git Credential Manager）；https://git-scm.com/download/mac 。

## 3. 汇总对比表

| 维度 | 系统 git CLI | 内置 git（dugite） | isomorphic-git | nodegit | git2-rs | gitoxide |
|---|---|---|---|---|---|---|
| 冲突三方数据 + 写回 | ✅ 完整 git 语义 | ✅ 同左 | ⚠️ mergeDriver 能拿到三方内容，但不留 index stage | ✅ | ✅ | ⚠️ 能算出冲突，不能持久化 merge 状态 |
| 单文件历史 / 任意版本 | ✅ 含 `--follow` | ✅ | ✅ 含 follow | ✅ 要自己实现 | ✅ 要自己实现 | ✅ 要自己实现，没有重命名跟踪 |
| HEAD ↔ 工作区 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10k 笔记 + 2.5k 附件下的 status（实测） | ✅ ~45 ms | ✅ 同左 | ❌ ~2.4 s | 约等于 libgit2 | ⚠️ ~2.0 s | ✅ ~20 ms |
| 复用系统凭据 | ✅ 完全复用 | ✅（全局配置 + 自带 GCM） | ❌ 没有 helper，没有 SSH | ⚠️ 要自己写 | ⚠️ 要自己写，SSH 不读 config | ⚠️ helper 可用，push 未完成 |
| 不需要用户预装 git | ❌ 需要预装 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 包体积 | 0 | +44~64 MB | 很小 | 中等，有原生 ABI 问题 | 小 | 小 |
| 维护状态 | 活跃 | 活跃 | 活跃 | 停滞 | 活跃 | 活跃但功能未齐 |

## 4. 建议与取舍（供后续 ticket 决策）

**建议：只用 git 可执行文件做 git 后端（spawn 子进程，读 blob 用 `cat-file --batch` 长连接）。优先用系统 git，找不到或版本太低时提示用户安装。是否再内置一份 git 作为回退，留给分发 ticket 决定。**

理由：
1. 它是唯一能无条件满足“认证依赖系统已有 git 配置/凭据”的方案：HTTPS helper、SSH config、GCM、企业代理都原样生效。
2. 冲突处理有完整的 git 语义（stage 1/2/3、`MERGE_HEAD`、abort/continue）。用户离开 Synote 去终端继续操作，状态不会乱。目标用户是懂 git 的开发者，这点很关键。
3. 实测 status ~45 ms、单文件历史 ~28 ms，远低于“打开库 3 秒内可用”的预算；还可以开 fsmonitor / untracked cache。
4. 和技术栈无关：Electron（TS）和 Tauri（Rust）都能直接调用，不会绑死后面的“桌面外壳”选型。
5. 同类产品都这么做：VS Code、Zed、GitHub Desktop，以及 GitButler 的网络操作。

代价 / 风险：
- 用户要预装 git。目标用户懂 git，可以接受；但 macOS 首次调用可能弹出 Xcode CLT 安装提示，要做好检测和说明。想做到零依赖，就要内置 dugite-native/MinGit：包体积 +44~64 MB，还要验证未签名包里的二进制在 macOS 上能否正常运行。
- 要解析 CLI 输出：用 `--porcelain=v2 -z`、`--format` 等机器可读格式可以降低风险。Windows 上进程启动开销更大，高频读 blob 用 `git cat-file --batch` 长连接解决。
- 不同 git 版本行为有差异，要设最低版本：建议 ≥ 2.38（`merge-tree --write-tree` 需要；fsmonitor 需要 ≥ 2.37）。

可选的混合方案（如果技术底座选 Tauri/Rust）：本地只读操作（读 blob、单文件历史、status）在进程内用 `gix` 或 `git2` 完成，省掉进程开销；写操作、合并、push/pull 用 git CLI。GitButler 就是这么做的。代价是两套实现要保持一致，MVP 阶段不建议。

不建议：
- **isomorphic-git**：没有 SSH，没有 credential helper，和“依赖系统凭据”的约束直接冲突；实测 status 和单文件 log 都要 2.4–2.6 s，比 git CLI 慢 50–90 倍。
- **nodegit**：稳定版停在 2020 年，原生 ABI 的维护成本高。
- **只用 gitoxide**：push 和 merge 状态持久化还没完成。
- **只用 libgit2**：SSH 不读 `~/.ssh/config`，认证要自己写；连 Cargo 都提供了退回 CLI 的开关。

## 5. 本机基准

环境：Apple M1 Max、APFS、macOS；git 2.54.0 (Apple Git-157)、Node 26.12.1、Rust release 构建。数值是热缓存下 3 次运行的中位数。

测试仓库：10,000 篇约 2 KB 的 md（分 100 个子目录）+ 2,500 个 200 KB 的随机二进制附件，共 12,500 个文件、101 次提交（`notes/d00/n00000.md` 每次提交都改）；工作区改了 3 篇笔记、新增 1 个未跟踪文件。
**附件只用了 200 KB/个（共约 500 MB），没有用 5 GB**：status 的成本由文件数量决定，已提交文件只比较 stat、不重新 hash，所以文件数和目标规模一致就能代表 status / log 的性能。首次 add / push 5 GB 的成本不在本基准范围内（见 2.4）。

| 操作 | git CLI | git2 0.21（libgit2 1.9.7） | gix 0.90 | isomorphic-git 1.44.10 |
|---|---|---|---|---|
| status（含 untracked） | **47 ms**（`status --porcelain=v2 -uall`） | 2,029 ms（首次运行出现过一次 77 ms，没能复现） | **20 ms** | 2,385 ms（`statusMatrix`） |
| 单文件历史（101 个 commit） | 28 ms（`log -- <path>`） | 6 ms（revwalk + tree 比较） | 7 ms | 2,548 ms（`log({ filepath })`） |
| 最近 100 个 commit | 18 ms（`log -n100`） | — | — | — |
| 读取 HEAD 版本的一个文件 | 15 ms（`show HEAD:<path>`，含进程启动） | — | — | — |

观察：
- git CLI 每次调用都带约 10–15 ms 的进程启动开销（macOS），绝对值依然很小；Windows 上的进程启动更慢，高频读 blob 建议用 `cat-file --batch` 长连接。
- 开启 `core.fsmonitor` + `core.untrackedCache` 后 status 仍是约 40 ms：在这个规模下，APFS 上 stat 本来就不是瓶颈；文件更多或在 Windows/NTFS 上收益会更明显（未实测）。
- git2 的 status 稳定在约 2 s，比 git CLI 慢约 40 倍，原因没深挖（可能和 libgit2 对 stat 缓存 / racy 条目的处理有关）。
- 进程内的 Rust 库读历史比 CLI 快，因为省掉了进程启动；但三种方式都已远低于交互阈值。

局限：只在 macOS 上测了；没测 Windows、冷缓存、更大的历史（如 1 万个 commit）和 push/pull 网络性能。基准程序：Rust 版本用 `git2::Repository::statuses` 与 `gix::Repository::status().into_iter()`；单文件历史用 revwalk 比较每个 commit 与其父 commit 在该路径上的 tree entry；JS 版本用 `statusMatrix` / `log({ filepath })`。
