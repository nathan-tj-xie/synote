# 双链在磁盘上使用标准 Markdown 相对链接，而非 wikilink

Synote 虽然是 Obsidian 式的笔记应用，但双链写入磁盘时使用 CommonMark 标准相对链接 `[名字](路径.md)`，不用 `[[名字]]` wikilink；输入时仍用 `[[` 触发补全，实时预览中只显示名字。原因：笔记存在 git 中，会在 GitHub、VSCode 等外部工具里浏览，标准链接在任何地方都可点击；路径唯一，避免重名歧义；Synote 不兼容 Obsidian vault，wikilink 的兼容价值不存在。

## Consequences

- 应用内移动/重命名必须自动改写所有相关相对路径（含被移动笔记自身的出站链接）。
- 路径中的空格编码为 `%20`，非 ASCII 字符保持原样；标题锚点使用 GitHub slug 规则。
- 读取时仍识别 `[[...]]`，以容纳手写或外部导入的内容，但 Synote 从不写入该语法。
