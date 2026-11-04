# 搜索与反链索引方案调研（Ticket #10）

> 调研日期：2026-11-04。本文只给建议和取舍，**选型由后续 ticket / ADR 决定**。
> 约束摘要：macOS + Windows；Electron（ADR 0002，索引放主进程或 utility process）；只用系统 git CLI ≥ 2.38（ADR 0004）；TS / Rust 都可以；未签名安装包，原生 addon 要能被 electron-builder 打包。规模：≤ 10,000 篇笔记、附件 ≤ 5 GB；打开库 3 秒内可用，搜索 200 ms 内返回。磁盘上写标准相对链接 `[text](../a/b.md)`，读取时同时识别 `[[...]]`（ADR 0001）；应用内重命名要自动改写引用，所以索引必须能反查"谁链接了这个文件"。附件放在扁平的 `attachments/`，按内容哈希命名，全库引用计数，宽松识别引用；孤儿附件由索引实时推导（GLOSSARY、#8）。索引文件放在应用数据目录，属于缓存，不入库。
> 基准脚本在 `research/search-index/`，环境和方法见第 6 节。

## 1. 候选方案与当前状态

| 方案 | 形态 | 当前版本（2026-11-04） | 维护状态 |
|---|---|---|---|
| 实时扫描（不建倒排索引） | 正文常驻内存，查询时逐篇 `String.prototype.includes` | —（V8 内置） | — |
| MiniSearch | 纯 JS 内存倒排（radix tree），序列化为整份 JSON | **7.2.0**（2025-09-16） | 低频维护：最近一次 push 是 2025-09-16，open issues 16 |
| FlexSearch | 纯 JS 内存倒排，`export/import` 分片导出；另有 Redis/SQLite/Postgres 等持久化 adapter | **0.8.212**（2025-09-06） | 中等：最近 push 2026-06-28，open issues 39 |
| SQLite FTS5 + `better-sqlite3` | 原生 addon，同步 API | **13.0.3**（2026-08-05），内置 SQLite 3.53.4 | 活跃。**v13 起改用 N-API，各平台的预编译二进制直接放在 npm 包里** |
| SQLite FTS5 + `node:sqlite` | Node 内置模块 | Node 24.15 起为 *Stability 1.2 – Release candidate*；Electron 45.2.2 内置 Node 24.22.2，SQLite 3.53.4 | 随 Node 发布 |
| tantivy（Rust） | 通过 napi-rs addon 调用 | tantivy **0.27.0**（crates.io，2026-10-17）；Node 绑定 `@oxdev03/node-tantivy-binding` **0.3.3**（基于 tantivy 0.26.2，napi8） | tantivy 本身非常活跃（16k stars）；**这个 Node 绑定只有 15 stars、一个维护者** |
| 中文分词：`@node-rs/jieba` | napi-rs addon | **2.0.4**（2026-10-06） | 活跃（napi-rs/node-rs） |
| 中文分词：`Intl.Segmenter` | V8/ICU 内置 | — | — |
| Markdown 解析：`@lezer/markdown` | 与 CM6 同源 | **1.8.1**（2026-10-19） | 活跃 |
| Markdown 解析：`micromark` + `mdast-util-from-markdown` | unified 生态 | micromark **4.0.3**、mdast-util-from-markdown **2.1.0** | 活跃 |
| 监听：Node `fs.watch({recursive})` | 内置；macOS 用 FSEvents，Windows 用 ReadDirectoryChangesW | — | — |
| 监听：`@parcel/watcher` | 原生 addon，支持离线快照 `getEventsSince` | **2.6.0**（2026-07-20） | 活跃（VS Code 在用） |
| 监听：`chokidar` | 纯 JS | **6.0.0**（2026-10-19），要求 Node ≥ 22.22 | 活跃。v6 在 macOS/Windows 上默认用 `fs.watch` recursive |

数据来源：npm registry（`registry.npmjs.org/<pkg>` 的 `dist-tags.latest` 和 `time`，脚本 `versions.mjs`）、crates.io API、GitHub API（`pushed_at` / releases），以及 https://releases.electronjs.org/releases.json 。

## 2. 逐项对比

### 2.1 实时扫描 vs 持久化增量索引

两件事要分开看：

- **反链和附件引用计数必须有一份常驻的链接图**。重命名时要秒级反查"谁链接了它"，孤儿附件要实时推导，每次都全库重扫不现实。好在这份图很小：10k 篇笔记、3.3 万条笔记边加 1.3 万条附件引用，存成 SQLite 只有 5.9 MB。建图本身也很快（第 6.3 节：用 lezer 解析一遍约 1.06 s，建图约 73 ms）。所以链接图要持久化，主要是为了**打开库时不用重新解析 10k 篇**。
- **全文搜索在这个规模下可以不建倒排索引**。实测把 10k 篇正文（28.7 MB）小写后放在内存里，逐篇 `includes`，13 条查询都在 **1–13 ms** 内完成（第 6.2 节），离 200 ms 预算很远，而且天然是精确的子串语义，不存在中文分词问题。代价是：utility process 常驻约 180 MB；每次打开库都要把全部正文读进内存（实测约 0.4 s，加小写转换共 0.8 s，macOS 热缓存）；只能自己写简单的排序（标题命中、出现次数），没有 BM25；耗时随库线性增长。
- **持久化倒排索引**（FTS5 / tantivy）的好处：加载时间是毫秒级，不用把正文读进内存（RSS 约 60 MB），自带 BM25 排序和 `snippet()`/高亮，库再大也能撑住。代价：首次全量建索引要 3–6 s（第 6.1 节），还要处理缓存失效和一致性。

参考：MiniSearch 和 FlexSearch 都是内存索引，所谓"持久化"就是整份导出、整份导入。实测从持久化文件加载要 0.7–8 s，比直接重读正文做扫描还慢，并不比实时扫描更有优势（见 2.2）。

### 2.2 引擎对比

- **MiniSearch**：API 简单，支持自定义 `tokenize`、前缀和模糊匹配、BM25+。问题有两个。一是持久化只能 `JSON.stringify(index)` 整份写出、`loadJSON` 整份读回。用 CJK bigram 时 `loadJSON` 要 **8.0 s**，加载后 RSS 1.2 GB，建索引时峰值 RSS 1.9 GB；改用词级分词也要 1.0–1.2 s。二是每改一篇，都要把整份索引重新写盘（1.1–2.2 s）。已经超出"打开 3 秒内可用"的预算。来源：https://github.com/lucaong/minisearch 、 https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html#loadJSON
- **FlexSearch**：查询最快（基本都在 0.1 ms 以下），`export` 是分片的，加载约 0.7 s。但内置的 `Charset.CJK` 只是 `split: ""`，即每个字符算一个 token，中英混排时会把英文也拆成单个字母（见 `src/charset/cjk.js`）。所以要像本基准一样，通过 `encode` 自己传入分词函数。`tokenize: 'forward'` 会给每个前缀都建条目，索引在磁盘上有 89 MB，单篇更新 44 ms，更新后整份导出又要 363 ms。0.8 自带的持久化 adapter（`flexsearch/db/sqlite` 等）依赖另外的数据库驱动，本次没测。来源：https://github.com/nextapps-de/flexsearch 、 https://github.com/nextapps-de/flexsearch/blob/master/doc/export-import.md 、 https://github.com/nextapps-de/flexsearch/blob/master/src/charset/cjk.js
- **SQLite FTS5（trigram）**：trigram tokenizer 把每 3 个连续字符当作一个 token，MATCH 和 `LIKE '%…%'` 都是**任意子串**语义，**不需要中文分词**。本基准里所有 ≥ 3 字符的查询，召回率和精确率都是 1。限制有三条，都出自官方文档：①少于 3 个 Unicode 字符的子串在 MATCH 中**匹配不到任何行**；`LIKE` 能用，但会退化成全表扫描（实测 2 字低频词 `喇嘛` 约 21 ms）。② 设了 `remove_diacritics` 之后 **LIKE/GLOB 不再走索引**（本基准起初就踩了这个坑，已经改掉）。③ `detail=none/column` 能把索引从 153 MB 降到 74 MB，但不支持 phrase MATCH，只能用 LIKE，也就没有 BM25 排序。整库放在一个 `.db` 文件里，事务里更新单篇约 13 ms，随时落盘，崩溃安全；链接表、mtime 表可以放在同一个库。来源：https://www.sqlite.org/fts5.html#the_trigram_tokenizer
  - **better-sqlite3 v13 改成了 N-API**：release notes 原文是 “first version of better-sqlite3 to run on the N-API … prebuilt binaries should theoretically work across different versions of Node.js and Electron”。各平台的预编译 `.node` 直接放在包里的 `prebuilds/`（含 darwin-arm64/x64、win32-x64/arm64），binding.gyp 设置了 `NAPI_VERSION=10`。本机已验证：同一份二进制在 Node 26 和 **Electron 45.2.2**（`ELECTRON_RUN_AS_NODE`）里都能直接加载，FTS5 trigram 也可用。换句话说，以前那种"按 Electron ABI 重编译"的问题基本没有了。要注意的是：npm 包里同时带了全部平台的 prebuild（16 MB）和 SQLite 源码 `deps/`（10 MB），打包时要用 `files` 排除掉。来源：https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
  - **`node:sqlite`**：Electron 45.2.2（Node 24.22.2）里可以直接 `require('node:sqlite')`，SQLite 3.53.4，FTS5 trigram 可用（本机实测）。Node 构建时打开了 `SQLITE_ENABLE_FTS5`（`deps/sqlite/sqlite.gyp`）。好处是零原生依赖、零打包问题；坏处是 API 仍是 Release candidate，SQLite 版本跟着 Electron/Node 走，没法单独升级。两种驱动实测的性能几乎一样。来源：https://nodejs.org/docs/latest-v24.x/api/sqlite.html 、 https://github.com/nodejs/node/blob/v24.x/deps/sqlite/sqlite.gyp
- **tantivy**：这次测下来最快、也最小。全量建索引 2.8 s，索引 28.5 MB，加载 1.6 ms，查询都在 2 ms 以内。中文的处理方式是：JS 侧先把正文切成 bigram，再交给 whitespace tokenizer；查询用 phrase，保证 bigram 相邻，这样 ≥ 2 字的中文子串就是精确匹配。不足：①单字和英文词内子串查不到（要么额外索引 unigram，要么在 Rust 侧接入 ngram tokenizer，本次没做）；`thom` 这样的前缀在默认的 parseQuery 下也不匹配。②每次 `commit` + `reload` 约 110 ms，单篇更新要合批。③**风险在绑定层**：唯一能直接用的 Node 绑定只有 15 stars、一个维护者，API 是从 tantivy-py 移植过来的，README 自己列了一串 “Critical Validation Issues”。正式采用基本意味着自己写、自己维护一个 napi-rs addon，还要在 CI 上出 darwin-arm64/x64 和 win32-x64 三份预编译。napi-rs 生成的是 N-API 模块，本机实测在 Electron 45 里能直接加载。来源：https://github.com/quickwit-oss/tantivy 、 https://github.com/oxdev03/node-tantivy-binding

### 2.3 中文分词：准确性与体积的取舍

| 方式 | 子串召回 | 代价 | 实测（10k 篇） |
|---|---|---|---|
| **FTS5 trigram** | ≥ 3 字的任意子串精确；1–2 字要走 LIKE 全表扫描 | 索引最大（153 MB，约为正文的 5.3 倍；`detail=none` 时 74 MB） | 全部查询的 recall 和 precision 都是 1；2 字低频词约 21 ms |
| **CJK bigram（自己切）** | 只要配合 phrase 或相邻约束，≥ 2 字子串就精确；单字只能靠前缀匹配近似（MiniSearch/FlexSearch 召回 0.90） | token 多（542 万），JS 内存索引很重；tantivy 下只有 28.5 MB | 切分 264 ms；`汉市`、`法权章`、`反链` 召回都是 1 |
| **Intl.Segmenter（ICU 词典）** | 只能按词命中。词内和跨词子串几乎都查不到（`汉市` 召回 0.08，`法权章` 召回 0）；ICU 对生词会切成单字，比如 `实时预览` 被切成 `实/时/预/览` | 零依赖 | 切分 1.6 s；索引 31.5 MB |
| **jieba（@node-rs/jieba）** | 只能按词命中：`汉市` 召回 0（因为 jieba 把 `武汉市` 当一个词），`法权章` 召回 0，中英混合查询召回 0.60；`反链` 被切成 `反/链`，只能靠 AND 近似 | 词典 11 MB，每个平台的 addon 约 1.1–4.6 MB | 切分 1.2 s（加载词典 53 ms） |

结论：笔记搜索的用户心智是"我记得这几个字"，所以**子串语义（trigram 或 bigram + 相邻约束）明显优于词典分词**。jieba 和 Segmenter 的召回问题来自分词粒度，跟引擎无关，而且还多了词典体积和自定义词表的维护成本。本基准的中文词表就取自 jieba 自带的词典，这对 jieba 是**偏有利**的，真实笔记里的生词只会更多。来源：https://www.sqlite.org/fts5.html 、 https://tc39.es/ecma402/#segmenter 、 https://github.com/napi-rs/node-rs/tree/main/packages/jieba

### 2.4 链接与附件引用抽取

| 方式 | 10k 篇耗时 | 准确性 |
|---|---|---|
| 纯正则 | **44 ms** | 把代码块里的 999 处"链接"也算进去了（生成器在约 10% 的笔记里放了 fenced code 里的诱饵链接） |
| `@lezer/markdown`（只取 `Link/Image/LinkReference` 下的 `URL` 节点；HTML 里的 `src/href` 用正则补；`[[...]]` 只扫非代码区） | **1,058 ms** | 和生成器的真值完全一致（42,615 条链接、2,998 条 wikilink） |
| `micromark` → `mdast` | 3,204 ms | 同上，也完全一致 |

- 建议用 `@lezer/markdown`。它和 CM6 用的是同一个解析器，编辑器里看到的链接和索引里抽到的链接，判定规则一致；比 mdast 快约 3 倍。它只在全量建索引时花 1 s，增量时每篇约 0.1 ms。来源：https://github.com/lezer-parser/markdown 、 https://github.com/syntax-tree/mdast-util-from-markdown
- **附件引用宽松识别**：直接在全文上跑一个正则 `attachments/<文件名>`，包括代码块、HTML 和引用式定义，10k 篇只要 11 ms。宽松的意思是"宁可多算一次引用，也不误判成孤儿"，符合"孤儿附件只在用户确认后删除"的规则（GLOSSARY）。
- 链接解析：先去掉 `#anchor`，再 `decodeURI`（ADR 0001 规定空格编码成 `%20`），最后按源文件目录做 `posix.join` + `normalize`；`[[name]]` 按"文件名 → 路径列表"解析，重名时需要一条确定的规则（本基准取第一个）。目标还不存在的链接放进 `unresolved`，等对应文件被创建后再补上。

数据结构（实测反链查询约 0.2 μs，单篇增量约 0.1 ms，推导孤儿附件约 2 ms）：

```
out:     Map<srcPath, { notes: Set<dstPath>, atts: Set<attName>, unresolved: Set<raw> }>  // 正向
back:    Map<dstPath, Set<srcPath>>   // 反链 / 重命名时要改写的文件列表
attRefs: Map<attName, Set<srcPath>>   // 引用计数 = size；孤儿 = readdir(attachments) − {size>0}
```

单篇更新的流程是：先用 `out[src]` 撤掉旧边，再重新解析、加上新边，不用全库重算。如果持久化到 SQLite，可以和 FTS 放在同一个库里：`links(src, dst, kind)` 加上 `dst` 索引，写入 4.3 万行约 98 ms，反链查询约 4.5 μs，库大小 5.9 MB。

## 3. 外部改动的增量更新

外部改动有三类来源，处理方式分开：

1. **应用运行期间**（文件管理器、其他编辑器、`git pull`/切分支）：用 watcher 收集变更路径，去抖 100–300 ms 后，对这些路径重新 `stat` 并重建索引。watcher 的事件只当作"这个路径可能变了"的提示，最终状态以 `stat` 和读文件的结果为准（chokidar 6 也改成了这种模型）。
   - **`fs.watch(dir, {recursive: true})`**：在 macOS 上走 FSEvents，在 Windows 上走 ReadDirectoryChangesW，零依赖，启动 0.6 ms。官方文档写明的 caveat：回调里的 `filename` 不保证一定有；在 Windows 上，被监听的目录自己被移动或重命名时不会发出事件，被删除时报 `EPERM`；网络盘上不可靠。来源：https://nodejs.org/docs/latest-v24.x/api/fs.html#caveats
   - **`@parcel/watcher`**：后端同样是 FSEvents / ReadDirectoryChangesW，启动 2.5 ms，事件已经合并去重（模拟切分支时改动了 2,280 个路径，正好收到 2,280 个事件；`fs.watch` 收到了 2,300 个）。它独有的能力是 **`writeSnapshot` / `getEventsSince`**：退出时写一份快照，下次启动时查询这期间的离线变更。macOS 上依靠 FSEvents 历史，实测 259 ms，覆盖率 100%。但 README 写明，Windows 上这个查询是 **FindFirstFile 暴力遍历**（除非装了 Watchman），实际上和下面的 stat 对账是同一种成本。它是原生 addon，每个平台的包约 0.3 MB，本机实测在 Electron 45 里能加载。来源：https://github.com/parcel-bundler/watcher
   - **chokidar 6.0.0**：默认的 `auto` 后端在 macOS 和 Windows 上就用 `fs.watch` recursive，再用 `lstat/stat/readdir` 确认之后才发事件；修了一批 Windows 上的问题（误报 `change`、重命名目录等）。代价是启动时要遍历并 stat 全部文件，实测 `ready` 要 235 ms，而且 6.0.0 才发布两周。来源：https://github.com/paulmillr/chokidar/releases/tag/6.0.0
   - 三者在 macOS 的这次批量改动里覆盖率都是 100%；**Windows 没有测**。
2. **应用关闭期间**：**打开库时做 mtime/size 对账**。遍历并 stat 全部 `.md`（10.5k 个文件），实测 106 ms，再和索引里存的 `(path, mtimeMs, size)` 表比较，不一致的重新读取、重新建索引，消失的删除。这一步跨平台行为一致，不依赖 watcher 的历史，应该作为兜底，一定要做。`@parcel/watcher` 的 `getEventsSince` 在 macOS 上可以作为加速，但不能代替对账。
3. **git 操作**：在索引里记下建索引时的 `HEAD` oid。打开库或者 watcher 发现 `.git/HEAD`、`.git/refs` 变化时，执行 `git diff --name-status -z <旧oid> HEAD`（覆盖 pull、切分支、reset 带来的已提交变化，`-z` 处理路径编码），再加上 `git status --porcelain=v2 -z`（覆盖工作区未提交的变化，#4 实测约 47 ms），就能精确拿到变更集合，避免大批量 watcher 事件被逐个处理。不要依赖 `HEAD@{1}`：它是 reflog 里的"上一个位置"，应用关闭期间如果发生了多次操作，或者 reflog 被关掉、被清理，就对不上"上次建索引时的版本"。来源：https://git-scm.com/docs/git-diff 、 https://git-scm.com/docs/gitrevisions 、 https://git-scm.com/docs/git-status#_porcelain_format_version_2
   - 应用自己写的文件（保存、重命名改写）直接走索引 API 同步更新，再在 watcher 里把这些路径过滤掉，避免重复处理。

忽略规则：`.git/`、`node_modules/` 等目录不监听，也不进全文索引；`attachments/` 只需要文件名列表（引用计数用），不需要内容。

## 4. 汇总对比

| 维度 | 实时扫描（内存） | MiniSearch | FlexSearch | SQLite FTS5 trigram | tantivy（napi） |
|---|---|---|---|---|---|
| 中文子串准确性 | ✅ 完全精确 | ⚠️ 取决于自己切分（bigram 较好，单字召回 0.90） | ⚠️ 同左 | ✅ ≥ 3 字精确；1–2 字退化为 LIKE 扫描（约 21 ms） | ✅ bigram + phrase 时 ≥ 2 字精确；单字要额外处理 |
| 查询耗时（10k 篇） | 1–13 ms | 0.1–6 ms | < 0.5 ms | 0.1–8 ms | < 2 ms |
| 打开库（已有缓存） | 约 0.8 s（读全部正文） | ❌ 1.0–8.0 s | 0.7 s | ✅ 1–5 ms | ✅ 1.6 ms |
| 首次全量建索引 | 0.8 s | 15–20 s | 9.1 s | 5.8 s（`detail=none` 4.9 s） | 2.8 s |
| 磁盘体积 | 0 | 30–52 MB | 89 MB | 153 MB（74 MB） | 28.5 MB |
| 内存（RSS） | 约 180 MB | 0.55–1.2 GB | 约 0.7 GB | 约 60 MB | 约 60 MB |
| 单篇增量 + 落盘 | 0 | 8–14 ms + 整份重写 1.1–2.2 s | 44 ms + 363 ms | 13 ms（事务） | 约 110 ms（commit + reload） |
| 排序 / 摘要 | 自己写 | BM25+ | 自有评分 | BM25、`snippet()` | BM25、snippet |
| 打包风险 | 无 | 无 | 无 | better-sqlite3 v13 是 N-API，预编译随包；`node:sqlite` 零依赖 | 要自己维护 napi-rs addon 和三平台预编译 |

## 5. 建议与取舍（供后续 ticket 决策）

**建议（倾向）：在 utility process 里用一个 SQLite 库同时存放链接图、文件 mtime/size 表，以及 FTS5 trigram 全文索引；驱动用 `better-sqlite3` 13（N-API）或 `node:sqlite`，二选一。打开库时做 stat 对账，运行期间用 watcher，git 操作用 HEAD oid 对比做增量。** 1–2 字的查询走 `LIKE` 扫描。

理由：
1. 子串语义正好对应"我记得这几个字"，不用维护分词词典；≥ 3 字的查询全部精确，1–2 字在 10k 篇规模下扫描也只要约 21 ms。
2. 已有缓存时打开库，加载索引约 5 ms，加上 stat 对账约 106 ms，远低于 3 s；查询 < 10 ms。
3. 链接图、引用计数、孤儿推导都可以用普通 SQL 表加索引实现，和 FTS 放在同一个事务里，崩溃后不会出现"全文已更新、链接图没更新"的状态。
4. better-sqlite3 v13 改成 N-API 之后，不再需要按 Electron ABI 重编译；`node:sqlite` 更是零原生依赖。本机实测两者在 Electron 45 里都能用。

代价 / 风险：
- **首次全量建索引约 5.8 s，超过 3 s**。可以这样处理：先读文件、建链接图（约 1.5 s，反链和孤儿推导立即可用），全文索引在后台分批写入；建好之前用内存扫描兜底（或者干脆只对已读入的正文做扫描）。`detail=none` 能降到 4.9 s，体积也减半，但会失去 BM25。`synchronous=OFF`、加大 `cache_size` 之类的批量写入优化没有测。
- 索引体积约为正文的 5 倍（153 MB），放在应用数据目录可以接受，但要提供"清理缓存 / 重建索引"的入口。
- 1–2 字的 LIKE 查询是全表扫描，库更大或者在 Windows 上会慢一些（没有实测）；也没有排序，要在应用层补一个简单的排序。

**备选 A：完全不建全文索引，只做实时扫描**（链接图仍然持久化）。实现最简单，100% 精确，查询 1–13 ms；代价是每次打开库都要读全部正文（macOS 上约 0.4–0.8 s，Windows 未测，Defender 扫描可能更慢），常驻约 180 MB，排序自己写，库再大就会碰到天花板。适合 MVP 先上，之后再换成 FTS5。

**备选 B：tantivy**。速度和体积都最好（建索引 2.8 s、28.5 MB、查询 < 2 ms），但要自己写、自己维护 napi-rs addon（现成的绑定太小众），而且单字和词内英文子串需要额外处理。只有当 FTS5 的体积或性能真的成为问题时才值得考虑。

不建议：
- **MiniSearch / FlexSearch 用作持久化索引**：本质是内存索引整份导出导入。加载需要 0.7–8 s，每次修改都要整份重写，内存占用 0.5–1.2 GB，比实时扫描还差。
- **jieba / Intl.Segmenter 词典分词**：子串和生词召回差（`汉市` 召回 0–0.08，`法权章` 召回 0），还多了词典体积和维护成本。
- **只用 watcher 不做对账**：Windows 上不能用快照查询离线变更，`fs.watch` 也不保证一定给出 `filename`。对账是保证正确性的底线。

## 6. 本机基准

环境：Apple M1 Max、APFS、macOS 27.2；Node **v26.12.1**（引擎基准在 Node 下跑）；能否在 Electron 45.2.2（Node 24.22.2，`ELECTRON_RUN_AS_NODE=1`）里加载，用 `electron-check.cjs` 单独验证过：`node:sqlite` 和 better-sqlite3 的 FTS5 trigram、@node-rs/jieba、@parcel/watcher、tantivy 绑定都能加载。数值都是热缓存下的结果；查询取 15 次的中位数，单篇更新取 5 次的中位数。

测试库：`gen-vault.mjs` 生成（固定种子），**10,000 篇中英混合笔记，共 28.7 MB，平均 2.9 KB/篇**，分在 20 × 10 个目录里；文件名中英混合，部分带空格。中文词表取 jieba 词典的高频词，外加 10 个词典里没有的产品术语（如 `反链`、`孤儿附件`）；英文词取 `/usr/share/dict/words`。笔记里有 29,865 条标准相对链接（空格编码为 `%20`）、2,998 条 `[[...]]`、12,750 条附件引用（其中 20% 写成 `<img src>`），约 10% 的笔记带有代码块里的诱饵链接。另有 3,000 个附件，其中 300 个是孤儿。没有用 prototype 里的 `.vault-10k`，因为它的每篇正文都是同一段重复文字，测不出搜索的准确性。

### 6.1 引擎：建索引、加载、体积、增量

| 引擎 | 全量建索引 ms | 持久化 ms | 索引体积 MB | 建索引峰值 RSS MB | 加载 ms | 加载后 RSS MB | 单篇更新 ms | 更新后整份落盘 ms |
|---|---|---|---|---|---|---|---|---|
| minisearch + bigram | 20,268 | 2,461 | 51.5 | 1,856 | **7,959** | 1,171 | 13.6 | 2,151 |
| minisearch + Intl.Segmenter | 15,205 | 1,215 | 31.5 | 814 | 1,018 | 578 | 8.3 | 1,135 |
| minisearch + jieba | 14,853 | 1,307 | 29.5 | 812 | 1,201 | 547 | 7.9 | 1,092 |
| flexsearch + bigram（forward） | 9,122 | 549 | 89.2 | 1,145 | 687 | 695 | 44.3 | 363 |
| FTS5 trigram（better-sqlite3） | 5,813 | 1,170 | 152.8 | 168 | 5.5 | 59 | 12.9 | —（事务内） |
| FTS5 trigram（node:sqlite） | 6,371 | 1,135 | 152.8 | 150 | 0.9 | 58 | 12.4 | —（事务内） |
| FTS5 trigram `detail=none`（LIKE） | 4,932 | 551 | 74.4 | 167 | 4.8 | 60 | 13.7 | —（事务内） |
| tantivy + bigram（napi） | **2,804** | 730 | **28.5** | 453 | 1.6 | 60 | 109.4 | —（commit 即落盘） |

读全部 `.md` 文件（不含解析）约 0.4 s，不计入上面的建索引耗时。FTS5 的"持久化"是 `optimize` 加 WAL checkpoint。

### 6.2 查询（top-50 耗时 ms ／ 召回率 ／ 精确率；真值 = 小写后的字面子串）

| 查询 | 真值篇数 | 实时扫描 | minisearch bigram | minisearch Segmenter | minisearch jieba | flexsearch bigram | FTS5 trigram | FTS5 detail=none | tantivy bigram |
|---|---|---|---|---|---|---|---|---|---|
| en 高频词 `thomasing` | 6854 | 7.3 | 3.7 ／ 1 ／ 1 | 3.6 ／ 1 ／ 1 | 3.6 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 7.9 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 | 0.4 ／ 1 ／ 1 |
| en 低频词 `nipcheese` | 92 | 12.5 | 0.1 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0.3 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 |
| en 词内子串 `homasin` | 6854 | 4.7 | 0 ／ **0** ／ 1 | 0 ／ **0** ／ 1 | 0 ／ **0** ／ 1 | 0 ／ **0** ／ 1 | 6.5 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0 ／ **0** ／ 1 |
| en 前缀 `thom` | 6854 | 8.1 | 3.7 ／ 1 ／ 1 | 3.5 ／ 1 ／ 1 | 3.6 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 4.9 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0 ／ **0** ／ 1 |
| zh 2 字高频词 `一个` | 9983 | 2.0 | 5.2 ／ 1 ／ 1 | 4.8 ／ 1 ／ 1 | 5.5 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1（LIKE） | 0.1 ／ 1 ／ 1 | 0.5 ／ 1 ／ 1 |
| zh 2 字低频词 `喇嘛` | 107 | 1.6 | 0.1 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0.1 ／ 0.99 ／ 1 | 0 ／ 1 ／ 1 | **21.9** ／ 1 ／ 1（LIKE 全表扫描） | 21.6 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 |
| zh 3 字人名 `章宗祥` | 74 | 1.7 | 0.1 ／ 1 ／ 1 | 0.2 ／ 0.99 ／ 1 | 0 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0.1 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 |
| zh 词内子串 `汉市` | 1161 | 12.8 | 0.5 ／ 1 ／ 1 | 2.1 ／ **0.08** ／ 0.20 | 0.8 ／ **0** ／ 1 | 0 ／ 1 ／ 1 | 1.4 ／ 1 ／ 1（LIKE） | 1.6 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 |
| zh 跨词子串 `法权章` | 1 | 1.4 | 0.1 ／ 1 ／ 1 | 0.3 ／ **0** ／ 1 | 0.1 ／ **0** ／ 1 | 0 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0 ／ 1 ／ 1 |
| zh 单字 `链` | 8531 | 0.9 | 6.0 ／ 0.90 ／ 1 | 4.1 ／ 1.0 ／ 1 | 3.8 ／ 0.86 ／ 1 | 0 ／ 0.90 ／ 1 | 0.1 ／ 1 ／ 1（LIKE） | 0.1 ／ 1 ／ 1 | 0 ／ **0** ／ 1 |
| zh 词典外 2 字 `反链` | 4643 | 1.4 | 2.4 ／ 1 ／ 1 | 4.9 ／ 1 ／ 0.99 | 5.1 ／ 1 ／ 1 | 0 ／ 1 ／ 1 | 0.3 ／ 1 ／ 1（LIKE） | 0.3 ／ 1 ／ 1 | 0.3 ／ 1 ／ 1 |
| zh 词典外 4 字 `孤儿附件` | 4725 | 5.1 | 6.4 ／ 1 ／ 1 | 3.8 ／ 1 ／ 1 | 4.1 ／ 1 ／ 1 | 0.4 ／ 1 ／ 1 | 3.1 ／ 1 ／ 1 | 0.2 ／ 1 ／ 1 | 1.7 ／ 1 ／ 1 |
| 中英混合 `武汉 darning`（AND） | 463 | 5.6 | 1.2 ／ 1 ／ 1 | 1.1 ／ 1 ／ 1 | 0.8 ／ **0.60** ／ 1 | 0.3 ／ 1 ／ 1 | 0.8 ／ 1 ／ 1 | 0.7 ／ 1 ／ 1 | 0.3 ／ 1 ／ 1 |

说明：
- 实时扫描这一列是"扫描全部 10k 篇"的耗时，召回率和精确率都是 1，按定义如此。FTS5 trigram 的 MATCH 带 `ORDER BY rank`；LIKE 路径和 `detail=none` 不排序，取到 50 条就停，所以高频词反而快，低频词要扫到底。
- 引擎查询没有计入取摘要的耗时。FTS5 可以直接用 `snippet()`；其他引擎要回读文件。
- MiniSearch/FlexSearch 的 bigram 只能用 AND，没有相邻约束，理论上会有假阳性（本查询集里没出现）。tantivy 用 phrase 保证相邻。

### 6.3 链接图（`links-bench.mjs`）

| 项目 | 结果 |
|---|---|
| 解析 10k 篇：正则 ／ lezer ／ mdast | 44 ms ／ **1,058 ms** ／ 3,204 ms（正则多算了 999 条代码块里的链接；lezer 和 mdast 与真值完全一致） |
| 附件引用宽松正则（全文） | 11 ms |
| 建 out/back/attRefs 三张 Map | 73 ms（32,855 条笔记边） |
| 反链查询（Map） | 0.21 μs |
| 单篇增量（重新解析 + 换边） | 0.1 ms |
| 孤儿推导（readdir 3,000 个附件 − 引用计数） | 2.3 ms，得到 300 个，与真值一致 |
| 写入 SQLite links 表 ／ 按 dst 反查 ／ 用 SQL 推导孤儿 | 98 ms ／ 4.5 μs ／ 10 ms；库大小 5.9 MB |

### 6.4 监听与对账（`watch-bench.mjs`，测试库的独立副本）

模拟一次切分支：改 2,000 篇、新建 100 篇、重命名 100 篇，共涉及 2,280 个路径。

| 项目 | 启动 | 收到事件 | 路径覆盖率 |
|---|---|---|---|
| `fs.watch` recursive | 0.6 ms | 2,300 | 100% |
| `@parcel/watcher` subscribe | 2.5 ms | 2,280 | 100% |
| chokidar 6（ignoreInitial） | 235 ms（要遍历并 stat 全部文件） | 2,280 | 100% |
| `@parcel/watcher` 离线：`writeSnapshot` ／ `getEventsSince` | 2.9 ms ／ 259 ms | 2,280 | 100% |
| stat 对账：遍历并 stat 10,520 个 `.md` | 106 ms | — | — |

脚本：`gen-vault.mjs`（生成测试库）、`bench.mjs` + `bench-engine.mjs`（各引擎在独立子进程里 build/load）、`report.mjs`（生成表格）、`scan-bench.mjs`、`tokenize-bench.mjs`、`links-bench.mjs`、`watch-bench.mjs`、`electron-check.cjs`、`versions.mjs`；原始结果在 `results.json`。复现步骤：`npm i && node gen-vault.mjs && node bench.mjs && node report.mjs`。

局限：只在 macOS（APFS、热缓存）上测过。**没有测 Windows**（NTFS 和 Defender 下的读文件、stat、watcher 行为都没测）、冷缓存，也没测在 Electron 运行时里跑性能（只验证了能加载）。测试库是合成文本，词频分布与真实笔记不同。tantivy 只测了"JS 侧切 bigram"这一种接法。FTS5 的批量写入参数没有调优。

## 7. 关键发现

- **在 10k 篇这个规模，内存实时扫描就够快**（1–13 ms，100% 精确子串）；真正需要持久化的是链接图和 mtime 表，全文索引持久化是为了加载快、省内存、有排序。
- **better-sqlite3 13（2026-07）改成了 N-API**，预编译二进制随包发布，本机实测可以直接在 Electron 45 里加载。**`node:sqlite` 在 Electron 45（Node 24.22）里可用**，自带 FTS5 和 trigram，状态是 Release candidate。
- FTS5 trigram 能精确匹配 ≥ 3 字的任意子串，不需要中文分词；1–2 字的查询只能走 LIKE 全表扫描（约 21 ms）。**一旦设了 `remove_diacritics`，LIKE 就不再走索引**。索引体积约为正文的 5 倍（153 MB），`detail=none` 可以减半。
- **jieba 和 Intl.Segmenter 不适合笔记搜索**：词内子串和跨词子串的召回只有 0–0.08；ICU 会把 `实时预览` 切成单字，jieba 会把 `反链` 切成 `反/链`。
- **MiniSearch 和 FlexSearch 不适合作为持久化索引**：加载要 0.7–8 s，内存 0.5–1.2 GB，每次修改都要整份重写。
- tantivy 在性能和体积上都最好（建索引 2.8 s、28.5 MB），但现成的 Node 绑定太小众，采用就等于要自己维护一个 napi-rs addon。
- 链接抽取用 `@lezer/markdown`（和 CM6 同源，1 s / 10k 篇，与真值一致）；纯正则会把代码块里的链接也算进去。附件引用则应该**故意用宽松正则**扫全文。
- 外部改动的增量方案：**打开库时 stat 对账（106 ms）是兜底，一定要做**；运行期间 `fs.watch` recursive 或 `@parcel/watcher` 都够用（`getEventsSince` 在 Windows 上是暴力遍历）；git 操作记录 HEAD oid，用 `git diff --name-status -z <oid> HEAD` 加 `status --porcelain=v2` 拿到精确的变更集合，不要依赖 `HEAD@{1}`。
