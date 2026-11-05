// shortcut: @lezer/markdown 1.8.1 的 GFM Table 不认带行尾空白的对齐行（`|---|---| `）：它的 delimiterLine 正则不允许
// 末个 `|` 之后有空白，整段就成了段落；GFM 规范允许这种写法，属上游 bug。这里包一层原 Table 解析器，把每行的行尾空白
// 去掉再交给它，语法树本身就是对的（实时预览、以后用到语法树的地方一致）。上游修好后删掉本文件和 editor.ts 里的引用
import { Table, type BlockParser, type Line, type MarkdownConfig } from '@lezer/markdown'

const original = (Table as MarkdownConfig).parseBlock![0] as BlockParser
const trim = (s: string) => s.replace(/[ \t]+$/, '')
// 只替换 text，其余字段（pos、next、basePos 等）沿原型读原来的 Line
const trimmed = (line: Line): Line => Object.create(line, { text: { value: trim(line.text) } })

export const tableTrailingSpace: MarkdownConfig = {
  parseBlock: [
    {
      name: 'Table', // 同名：替换原来的 leaf 解析器（原来的 endLeaf 仍在，它对这种行返回 false，不影响）
      leaf(cx, leaf) {
        const p = original.leaf!(cx, leaf)
        if (p) {
          const next = p.nextLine.bind(p)
          p.nextLine = (cx, line, leaf) => next(cx, trimmed(line), leaf) // 改实例方法，保留 instanceof TableParser
        }
        return p
      },
      // 表格打断前面的段落时，原实现用 peekLine 看下一行是不是对齐行：同样先去掉行尾空白
      endLeaf(cx, line, leaf) {
        const peek = Object.create(cx, { peekLine: { value: () => trim(cx.peekLine()) } })
        return original.endLeaf!(peek, line, leaf)
      },
      before: 'SetextHeading',
    },
  ],
}
