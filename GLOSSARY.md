# Synote 术语表

**笔记库（Vault）**：一个本地文件夹，同时也是一个 git 仓库；其中的 `.md` 文件即笔记。
_避免_：仓库（指 git 层面时才说"仓库"）、工作区

**笔记（Note）**：笔记库中的一个 Markdown 文件。

**附件（Attachment）**：被笔记引用的非 Markdown 文件（图片等），存放在笔记库的 `attachments/` 文件夹中，该文件夹在文件树中隐藏。只有 `attachments/` 下的文件由 Synote 管理生命周期。

**孤儿附件（Orphan Attachment）**：全库引用计数为 0 的附件。由索引实时推导，不单独存储；只在 commit 面板或"清理孤儿附件"命令中经用户确认后删除，编辑或保存时从不删除。

**双链（Note Link）**：笔记中指向另一篇笔记的链接，在磁盘上以标准 Markdown 相对链接形式存在。
_避免_：wikilink（特指 `[[...]]` 语法，Synote 不以此写入）

**反链（Backlink）**：从被链接笔记一侧看到的、指向它的双链。

**实时预览（Live Preview）**：在编辑时内联渲染 Markdown，仅光标所在处显示源码的编辑形态。

**Diff 编辑（Diff Editing）**：在 diff 视图中直接修改文件内容。MVP 覆盖三个场景：
- **工作区对比**：HEAD ↔ 当前工作区文件
- **冲突解决**：合并冲突时编辑出最终结果
- **历史对比**：当前文件 ↔ 任意历史 commit 版本，可把旧内容拣回

**手动模式（Manual Git Mode）**：commit、push、pull 均由用户显式触发，应用不自动同步。
