# 大附件与 Git LFS 调研（Ticket #13）

> 调研日期：2026-11-04。这里只给建议和取舍，**选型由后续 ticket / ADR 决定**。
> 已定约束：macOS + Windows；Electron（ADR 0002）；只用系统 git CLI ≥ 2.38，不内置 git（ADR 0004）；认证依赖系统 git 配置；只做手动 git 模式；≤ 10k 笔记、附件 ≤ 5 GB；附件放在扁平的 `attachments/`，按内容哈希去重，孤儿附件在 commit 时 `git rm`（#8）；diff 中悬停图片显示缩略图，左侧从 commit 读 blob；缺失附件可一键从历史恢复（#9 决定 6、7）。
>
> 说明：#8 的结论是"拖入文件保留原名，哈希一致时复用已有文件"，并不是用哈希做文件名。下文的结论对两种做法都成立，因为 LFS 只关心文件内容和 `.gitattributes` 里的路径模式，不关心文件名。

## 1. 现状与版本

| 项目 | 当前版本（2026-11-04） | 备注 |
|---|---|---|
| git | 上游 **v2.56.0**；本机 Apple Git 2.54.0 (Apple Git-157) | GitHub API `repos/git/git/tags` |
| git-lfs | **v3.8.1**（2026-10-22） | `gh api repos/git-lfs/git-lfs/releases/latest`；Homebrew stable 3.8.1 |
| macOS 自带 git | **不带** git-lfs | 本机 `/Library/Developer/CommandLineTools/usr/bin`、`/usr/libexec/git-core` 里都没有 lfs；`brew install git-lfs` 只装二进制，caveat 提示还要手动 `git lfs install` 才会写 filter 配置（https://formulae.brew.sh/formula/git-lfs ） |
| Git for Windows | **默认带** git-lfs | 安装器 `gitlfs` 组件属于 `Types: default`（https://github.com/git-for-windows/build-extra/blob/main/installer/install.iss ）；安装脚本写入 `git config --system filter.lfs.{clean,smudge,process}` 和 `filter.lfs.required true`（https://github.com/git-for-windows/build-extra/blob/main/mingw-w64-git-lfs/git-lfs.install ） |

所以两个平台的默认状态不一样：**Windows 用户基本"开箱即有 LFS"，macOS 用户默认没有**，要自己 `brew install git-lfs && git lfs install`。#4 里说的"dugite-native 自带 LFS"在 ADR 0004（不内置 git）之后已经不适用。

## 2. 逐项分析

### 2.1 LFS 的工作方式（和 Synote 相关的部分）

- 仓库里只存**指针文件**：UTF-8 文本，第一行固定是 `version https://git-lfs.github.com/spec/v1`，然后按字母序是 `oid sha256:<64 位小写 hex>` 和 `size <字节>`，整个文件必须 **< 1024 字节**；空文件就是空文件自己的指针。旧版本工具写的 `version https://hawser.github.com/spec/v1` 也要能识别。
  - 来源：https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md （The Pointer）
- 真实内容存在本地 `.git/lfs/objects/OID[0:2]/OID[2:4]/OID`，push 时由 pre-push hook 上传到 LFS 服务端；`lfs.storage` 可以改目录，`git lfs env` 的 `LocalMediaDir` 给出实际路径。
  - 来源：spec.md（Intercepting Git）；https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc （`lfs.storage`）
- 转换靠 git 的 clean/smudge filter：`.gitattributes` 里 `filter=lfs` 决定**哪些路径**走 LFS，`filter.lfs.*` 配置（全局 / system / 仓库）决定**这台机器**是否真的执行转换。`filter.<driver>.required=true` 时 filter 执行失败会让 git 命令直接报错。
  - 来源：https://git-scm.com/docs/gitattributes#_filter
- clone 时默认只下载**当前 checkout 需要**的对象；历史版本的对象要到 checkout 那个版本、或 `git lfs fetch --recent/--all` 时才下载（`lfs.fetchrecentrefsdays` 默认 7 天，只影响 `fetch --recent`）。
  - 来源：git-lfs-config.adoc（fetch settings）；本机实验第 4.4 节

### 2.2 内容哈希去重与 LFS 指针能否兼容

**能兼容，而且可以对齐。** 要点：

1. **工作区里拿到的是什么取决于这台机器的 filter 状态**，不是仓库：
   - 装了 git-lfs 且有 filter 配置（Windows 默认；macOS 执行过 `git lfs install`）：工作区是真实内容，应用照常读文件即可。
   - 没装 / 没配置 filter，或用 `GIT_LFS_SKIP_SMUDGE=1` clone、`git lfs install --skip-smudge`：工作区里是 **132 字节左右的指针文本**，`git status` 是干净的（实测 0 行变更），用户不会察觉。此时图片预览会坏掉，去重哈希也会算错。
2. **LFS oid 就是文件内容的 SHA-256**（实测指针 oid 与 `shasum -a 256` 一致）。如果 Synote 的去重哈希也用 **SHA-256（整文件，不加前缀）**，那么：
   - 工作区是指针时，可以直接从指针里读出 oid 作为"内容哈希"，不用下载内容就能完成去重和引用判断；
   - 读历史附件时，可以用 oid 直接去 `LocalMediaDir` 找文件。
   - 不要用 git blob id（SHA-1 of `blob <size>\0<content>`）做去重：LFS 仓库里 blob id 是**指针**的哈希，和内容对不上。
3. Synote 自己写附件时**不需要知道 LFS 的存在**：照常把真实内容写进 `attachments/`，`git add` 时 clean filter 自动转成指针（`.gitattributes` 匹配即可）。
4. 风险：**没装 lfs 的机器在 LFS 仓库里新增附件**，会以普通 blob 提交真实内容（实测 1 MB 文件进了 1 MB blob），没有任何报错；之后装了 lfs 的机器会看到这个文件"应是指针却不是"。这在 macOS 上最容易发生。可以用 `git check-attr filter -- <path>` 判断路径是否应走 LFS，再检查 `git lfs version` 是否可用，提交前给出提示。

### 2.3 git CLI 路线下读历史附件（`cat-file --batch`）

ADR 0004 规定用常驻的 `git cat-file --batch` 读历史 blob。在 LFS 仓库里：

| 读法 | 结果 | 结论 |
|---|---|---|
| `cat-file --batch`（现方案） | 拿到**指针**（`blob 132`），18 ms 读 100 个 | 照常用；读到后识别指针再解析 |
| `git show <rev>:<path>` | 也是指针（132 字节），不走 smudge | 同上 |
| `cat-file --filters <rev>:<path>`（单次） | 真实内容；对象不在本地时按需下载 | 能用，但每次一个进程 |
| `cat-file --batch --filters` | 真实内容，但有两个坑，见下 | **不建议**用在常驻进程里 |
| 指针 → `git lfs smudge -- <path>`（stdin 传指针） | 真实内容；本地没有时下载；失败时**退出码 2，stdout 原样输出指针** | 按需单次调用，适合"本地缓存没命中"的兜底 |
| 指针 → 直接读 `LocalMediaDir/oid[0:2]/oid[2:4]/oid` | 真实内容，零子进程 | 首选：缩略图和恢复预览走这条 |

`cat-file --batch --filters` 的两个坑（git 2.54 实测，对照 master 源码 `builtin/cat-file.c`）：
1. **头部的 size 是过滤前的大小**：输出 `… blob 132`，后面却跟了 1,048,576 字节真实内容。文档写的是"contents 由 `%(objectsize)` 个字节组成"，按 size 分帧的解析器会直接错位。源码里过滤后的内容整段读进内存再 `batch_write`，头部已经先按原始对象信息输出了。
2. **任何一个对象出错都会 `die`，整个常驻进程退出**：输入行缺少 path 时报 `fatal: missing path`；LFS 对象下载失败（离线 / remote 不可达）时退出码 128，同一批里后面的请求都拿不到。
- 来源：https://git-scm.com/docs/git-cat-file （`--filters`、BATCH OUTPUT）；https://github.com/git/git/blob/master/builtin/cat-file.c （`die("missing path for '%s'")` 与 `filter_object` 分支）

**指针识别规则**（来自 spec）：blob size < 1024，内容以 `version https://git-lfs.github.com/spec/v1\n`（或 hawser 旧 URL）开头，能解析出 `oid sha256:` 和 `size`。用 `--batch-check` 先看 size，就能在不读正文的情况下排除绝大多数非指针 blob。

### 2.4 对 #9 的影响：diff 悬停缩略图、从历史恢复

- **悬停缩略图**：左侧从 commit 读 blob → 得到指针 → 查本地 `LocalMediaDir`：命中就显示；没命中就显示"LFS 对象未下载（N MB）"的占位和一个"下载"按钮，点了才调用 `git lfs smudge`（会联网、走系统凭据）。**悬停时不要自动下载**：历史对象通常不在本地（实测 clone 后历史附件的本地对象不存在），一次悬停可能触发几 MB 到几十 MB 的下载，GitHub 还会按下载量计费（2.6 节）。
- **从历史恢复缺失附件**（#9 决定 7）：应该用 `git restore --source=<commit> -- attachments/<file>`（或 `git checkout <commit> -- <path>`），**不要**把 `cat-file` 拿到的 blob 原样写回文件：
  - 有 lfs：restore 经过 smudge，写回真实内容（实测 1,048,576 字节）；
  - 没装 lfs：写回的是指针（132 字节），`git status` 干净，但图片仍是坏的，要提示用户安装 git-lfs；
  - 有 lfs 但下载失败（离线）：restore 退出码 128，不写文件，要把 stderr 里的 `Smudge error` 展示给用户。
- **孤儿附件 `git rm`**（#8）：对 LFS 文件照常生效，删掉的是指针；但服务端的 LFS 对象**不会因此释放**。GitHub 的 LFS 存储按"与仓库关联的所有对象"计算，要清理只能走专门的删除流程。
  - 来源：https://docs.github.com/en/billing/concepts/product-billing/git-lfs

### 2.5 `git status` 性能与未安装 git-lfs 时的行为

- **status 成本仍然由文件数决定**：干净状态下 plain 23 ms / LFS 17 ms（1,000 笔记 + 550 个附件）。只有 stat 信息变了的文件才会重新 hash；LFS 下重新 hash = 跑一次 clean filter（`filter-process` 长连接，计算 SHA-256），**不比普通仓库慢**：touch 全部 550 MB 附件后的首次 status，plain 2,169 ms，LFS 1,685 ms，之后都回到 ~20 ms。
- **没装 git-lfs 时**：
  - 仓库里**没有** `filter.lfs.*` 配置（macOS 常见）：clone 正常，附件是指针，status 干净，git 命令都不报错。问题只在应用层：图片坏、哈希错、新增附件被当成普通 blob 提交（2.2 第 4 点）。
  - 配置了 `filter.lfs.required=true` 但找不到 `git-lfs`（例如 Windows 安装时取消勾选、或 PATH 被改）：`git checkout` 和 `git status` 都会以 128 退出，报 `git-lfs filter-process: git-lfs: command not found`（status 在需要重新 hash LFS 文件时失败）。Synote 要把这个错误识别出来并给出引导，而不是显示成"不是 git 仓库"。
  - Electron 从 Finder / Dock 启动时 PATH 不含 `/opt/homebrew/bin`：ADR 0004 已规定用登录 shell 的 PATH 找 git，**git 子进程的环境里也要用这个 PATH**，否则 git 能找到、git-lfs 却找不到。
- pre-push hook：实测只要 filter 运行过（clone 时 smudge），git-lfs 就会自动在仓库里装上 `pre-push`；ADR 0004 用系统 git 执行 push，hook 会正常触发，LFS 对象随 push 上传。

### 2.6 托管方的大小限制（决定阈值的依据）

| 托管方 | 普通 git 仓库 | Git LFS |
|---|---|---|
| GitHub.com | 单文件 > **50 MiB** 警告，> **100 MiB** 拒收；**单次 push 上限 2 GB**；建议仓库 < 1 GB，强烈建议 < 5 GB；`.git` 磁盘体积建议上限 10 GB；网页上传单文件 ≤ 25 MiB | 单文件上限：Free / Pro **2 GB**，Team 4 GB，Enterprise Cloud 5 GB；Free / Pro 每月含 **10 GiB 存储 + 10 GiB 下载流量**（Team / Enterprise 250 GiB）；超出且预算为 $0 时，当月 LFS 被停用，clone 只能拿到指针 |
| GitLab.com | 免费版每个项目 **仓库 + LFS 合计 10 GiB**（Premium / Ultimate 500 GiB），超出后项目只读；单次 push 上限 **5 GiB** | 计入上面的 10 GiB |

来源：
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github （数值来自 `data/variables/large_files.yml`：warning_size 50 MiB、max_github_size 100 MiB、max_github_browser_size 25 MiB）
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits （On-disk size 10 GB、Push size 2GB、Single object size 100 MB）
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage （各 plan 的 LFS 单文件上限）
- https://docs.github.com/en/billing/concepts/product-billing/git-lfs （配额与超额行为）
- https://docs.gitlab.com/user/gitlab_com/ 、 https://docs.gitlab.com/user/storage_usage_quotas/

对 5 GB 附件的含义：
- **不用 LFS**：在 GitHub 上能用，但已超过"强烈建议 < 5 GB"，而且**首次 push 超过 2 GB 会被拒**，要分几次提交、几次 push；任何单个附件 > 100 MiB 都会导致 push 失败。
- **用 LFS（GitHub Free）**：5 GB 存储在 10 GiB 免费额度内，但**每在一台新机器上完整 clone 一次就消耗约 5 GB 流量**，一个月两次就用完；用完后当月只能拿到指针。对个人笔记库来说，LFS 并不是"免费的解药"。
- GitLab.com 免费版：仓库 + LFS 合计 10 GiB，5 GB 附件加上历史删除的附件，有可能触顶变成只读。

### 2.7 其他手段

- **partial clone（`git clone --filter=blob:limit=<n>`）**：需要服务端开启 `uploadpack.allowFilter`（GitHub、GitLab 都支持）。它只省下**历史里**的大 blob；checkout 时 HEAD 需要的 blob 仍然会全部下载（实测 4.3 s、.git 564 MB，和普通 clone 的 609 MB 差不多）。之后 `cat-file --batch` 读历史附件时会**逐个按需联网拉取**（实测单个 61 ms，100 个 2.6 s），可以用，但每次悬停都可能联网。它对用户透明、不改仓库格式，可以作为"文档里推荐的 clone 方式"，不需要应用做任何事。
  - 来源：https://git-scm.com/docs/partial-clone 、 https://git-scm.com/docs/git-clone （`--filter`）、 https://docs.gitlab.com/topics/git/clone/ （Partial clone）、 https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/
- **sparse checkout**：附件在扁平的 `attachments/` 里，按目录排除就等于整个附件目录不在工作区，实时预览全部显示"附件缺失"，孤儿判定和"从历史恢复"也会误导用户。**不适合 Synote**。
  - 来源：https://git-scm.com/docs/git-sparse-checkout
- **仅提示用户自行配置 LFS**：成本最低。应用不写 `.gitattributes`、不执行 `git lfs install`、不改任何 git 配置（和 ADR 0004"应用不代写 git 配置"一致），只在设置页 / 文档里给出可复制的命令，例如 `git lfs install --local` + `git lfs track "attachments/**"`。注意：已经提交的附件不会因此变成 LFS，要转换历史得用 `git lfs migrate import`，那会改写历史，必须由用户自己决定。

## 3. 本机实验

环境：Apple M1 Max、APFS、macOS；git 2.54.0 (Apple Git-157)、git-lfs 3.8.1（brew）。脚本：`research/lfs/run.sh`，测试仓库都生成在 scratch 目录，不进本仓库；LFS 只用 `git lfs install --local`，"没装 lfs"用不含 `/opt/homebrew/bin` 的 PATH 模拟。

测试数据：1,000 篇约 2 KB 的笔记 + 600 个 1 MB 随机二进制附件（不可压缩，接近 JPEG/PNG）。提交 1 放 1,000 笔记 + 400 附件；提交 2 `git rm` 50 个附件（模拟孤儿清理）、新增 200 个。HEAD 有 550 个附件，历史共 600 MB。clone 用 `file://` URL，强制走 pack 传输，没有网络开销。

### 3.1 体积与 clone

| 指标 | 普通提交 | LFS |
|---|---|---|
| 两次 `add` + `commit` 耗时 | **19,956 ms** | **4,472 ms** |
| 源仓库 `.git` | 1,235 MB（gc 后含 3 个 pack，未深挖；以 clone 端为准） | 602 MB（其中 `.git/lfs` 600 MB，git 对象只有 2 MB） |
| clone 耗时 | 4,429 ms | 1,432 ms |
| clone 后 `.git` | 609 MB（全部历史） | 552 MB（只有 HEAD 用到的 550 个对象） |
| `GIT_LFS_SKIP_SMUDGE=1` clone | — | 555 ms，`.git` 2 MB，工作区附件全是指针 |
| 没装 lfs 的 clone | — | 215 ms，`.git` 2 MB，工作区附件全是指针 |
| partial clone `--filter=blob:limit=100k` | 4,305 ms，`.git` 564 MB | — |

观察：
- 普通提交慢在 zlib 压缩（随机数据压不动还要压一遍）；按线性外推，5 GB 首次提交约 170 s，LFS 约 40 s。
- **LFS 省下的 clone 体积 = 历史里已删除或已修改的附件**。Synote 的附件按内容去重、基本不修改，只有孤儿清理会产生"历史独有"的对象，所以 clone 体积差距不大（609 vs 552 MB）。LFS 真正的好处是绕开 GitHub 的 100 MiB 单文件 / 2 GB push 限制，以及允许"只 clone 指针"。
- 本地磁盘：LFS 仓库仍然在 `.git/lfs` 里存一份所有拉过的版本，和普通仓库的 pack 一样占双份（工作区 + 仓库）。

### 3.2 `git status`（`--porcelain=v2 -uall`，5 次中位数）

| 场景 | 普通 | LFS |
|---|---|---|
| 干净 | 23 ms | 17 ms（只 clone 指针的仓库：17 ms） |
| touch 全部附件后首次 | 2,169 ms | 1,685 ms |
| 之后 | 19–23 ms | 16–19 ms |

### 3.3 读历史附件

| 操作 | 普通 | LFS |
|---|---|---|
| `cat-file --batch` 读 100 个历史附件 | 55 ms，104.9 MB | 19 ms，18.3 KB（全是指针） |
| `cat-file --batch --filters` 读 100 个 | 53 ms | 230 ms，104.9 MB（头部 size 仍是 132） |
| `git show HEAD~1:<path>` | — | 132 字节（指针） |
| `cat-file --filters HEAD~1:<path>` | — | 1,048,576 字节 |
| 指针 \| `git lfs smudge` | — | 1,048,576 字节 |
| clone 后历史对象是否在本地 | 是 | **否**；`cat-file --filters` 按需下载 214 ms 后才在本地 |
| 没装 lfs 时 `cat-file --filters` | — | 132 字节（原样输出指针） |
| partial clone 读 1 个 / 100 个历史附件 | 61 ms / 2,639 ms（逐个联网拉取） | — |

### 3.4 失败场景

| 场景 | 结果 |
|---|---|
| 没装 lfs、没有 filter 配置，clone LFS 仓库 | 成功；附件是指针；`git status` 0 行变更 |
| `filter.lfs.required=true` 但 PATH 里没有 git-lfs | `git checkout -- <file>` 退出码 128；`git status` 也失败：`git-lfs filter-process: git-lfs: command not found` |
| 没装 lfs 时在 LFS 仓库新增附件并提交 | 作为 1 MB 普通 blob 入库，没有任何提示 |
| 没装 lfs 时 `git restore --source=HEAD~1` | 写回 132 字节指针 |
| 有 lfs、remote 不可达，`cat-file --batch --filters` 两个未下载对象 | 退出码 128，只输出第一个对象的头部（50 字节）；第二个请求丢失 |
| 同上，`git lfs smudge` | 退出码 2，stdout 原样输出指针，stderr `Smudge error: Error downloading …` |
| 同上，`git restore --source=HEAD~1` | 退出码 128，不写文件 |

局限：只在 macOS 上测了；没测 Windows（Git for Windows 默认带 LFS 和 `required=true`）、真实网络下的 clone/push、GitHub/GitLab 的 LFS 服务端（实验用的是 `file://` remote 的本地传输）、5 GB 全量；附件统一 1 MB，没测 > 100 MiB 的单文件 push 被拒。

## 4. 建议（供后续 ticket 决策）

**建议：MVP 不主动启用 LFS，也不做迁移，只做"检测 + 兼容已配置的 LFS + 大文件提示"。** 具体最小处理：

1. **启动 / 打开笔记库时检测一次**：`git check-attr filter -- attachments/x`（看附件路径是否走 LFS）和 `git lfs version`（用登录 shell 的 PATH）。结果在 git 面板以非模态方式显示：
   - 附件走 LFS 但没有 git-lfs → 提示"附件可能只是指针，请安装 git-lfs"，给出可复制的命令（macOS：`brew install git-lfs && git lfs install`）；
   - 捕获 `git-lfs: command not found` 这类 filter 错误，单独提示，不要把整个笔记库降级成非 git 模式。
2. **去重哈希统一用整文件 SHA-256**，和 LFS oid 一致。读工作区附件时先识别 LFS 指针（size < 1024 + version 行）：
   - 是指针 → 用指针里的 oid 参与去重和引用判断，预览显示"LFS 内容未下载"占位（和"附件缺失"区分开），不当作损坏或孤儿处理；
   - 提供"下载"按钮，调用 `git lfs pull --include=<path>`。
3. **读历史 blob 保持现方案**（常驻 `cat-file --batch`，不加 `--filters`），读到指针后：
   - 先查 `LocalMediaDir/oid[0:2]/oid[2:4]/oid`，命中就显示缩略图；
   - 没命中就显示占位，用户点击后再单次调用 `git lfs smudge -- <path>`，失败时把指针和 stderr 显示出来。
   - 不在悬停时自动下载。
4. **从历史恢复缺失附件用 `git restore --source=<commit> -- <path>`**，不要直接写 blob 内容。恢复后再检查一次是否仍是指针。
5. **粘贴 / 拖入大文件时提示**，建议两档阈值，都按 GitHub 的硬限制定：
   - **> 50 MiB** 提示"GitHub 会警告；建议改用 LFS 或放在笔记库外"；
   - **> 100 MiB** 且附件路径不走 LFS 时，明确提示"push 到 GitHub 会被拒"，仍允许用户继续（不阻止，因为可能用的是自建服务）。
   - 可选：commit 面板显示本次新增附件的总大小，> 2 GB 时提示"GitHub 单次 push 上限 2 GB，建议分批提交"。
6. **文档里说明可选做法**（应用不代做）：怎样自己给 `attachments/**` 开 LFS；GitHub Free 的 LFS 流量配额；可以用 `git clone --filter=blob:limit=1m` 减少历史附件下载。

明确不做（MVP）：
- 不自动写 `.gitattributes`、不执行 `git lfs install` / `track` / `migrate`，不改任何 git 配置（和 ADR 0004 一致）。
- 不内置 git-lfs，不自己实现 LFS 传输协议、不直接调用 LFS batch API（认证和代理全交给系统 git/git-lfs）。
- 不用 `cat-file --batch --filters` 做常驻读取。
- 不支持 sparse checkout 排除 `attachments/`。
- 不做附件体积统计面板、不做 LFS 对象清理（`git lfs prune`）。

取舍：
- 如果以后要"新建笔记库默认开 LFS"，好处是绕开 GitHub 100 MiB / 2 GB push 限制、可以只 clone 指针；代价是 macOS 用户多一个依赖、GitHub Free 的流量配额很快用完、孤儿 `git rm` 不释放服务端存储。按目前的数据（附件基本不修改，LFS 对 clone 体积帮助有限），这个代价对个人笔记库不一定值得，建议等用户反馈后再定。

## 5. 关键发现

- LFS 仓库里 `cat-file --batch` / `git show` 拿到的是 **132 字节左右的指针**，不是内容；现有的常驻 `--batch` 方案只需要加"识别指针 → 查本地 LFS 缓存"这一步。
- `cat-file --batch --filters` 能拿到真实内容，但**头部 size 是指针大小**（132），而且任何一个对象下载失败都会让整个进程退出（128），不能当常驻读取通道。
- **LFS oid = 内容 SHA-256**。Synote 的去重哈希用 SHA-256，就能在只有指针时完成去重，也能直接定位本地 LFS 缓存。
- macOS 默认**没有** git-lfs，Git for Windows 默认**有**而且设置了 `filter.lfs.required=true`。没装 lfs 时 git 不报错，附件静默变成指针；新增附件静默以普通 blob 入库。设置了 required 但缺二进制时，`status` / `checkout` 直接失败（128）。
- 本机 600 MB 附件：普通提交 20.0 s vs LFS 4.5 s；clone 4.4 s / 609 MB vs 1.4 s / 552 MB；status 两者都 ~20 ms，只有大量 mtime 变化时首次 1.7–2.2 s。因为附件很少修改，LFS 对 clone 体积的帮助有限。
- GitHub 硬限制：单文件 100 MiB、单次 push 2 GB；LFS Free 每月 10 GiB 流量，5 GB 附件库在新机器上完整 clone 两次就用完。GitLab.com 免费版仓库 + LFS 合计 10 GiB，单次 push 5 GiB。
- partial clone 只省历史里的 blob，读历史附件时逐个联网（100 个 2.6 s）；sparse checkout 和扁平的 `attachments/` 不兼容。
