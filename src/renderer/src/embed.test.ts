import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { canWrite, embedOf, embedText, mathSyntax, type Embed } from './embed'

const md = parser.configure([GFM, mathSyntax])

// 文本里被认成行内公式的源码片段
function maths(text: string): string[] {
  const out: string[] = []
  md.parse(text).iterate({ enter: (n) => void (n.name === 'InlineMath' && out.push(text.slice(n.from, n.to))) })
  return out
}

describe('行内公式定界（Pandoc / GitHub 规则）', () => {
  it('普通公式', () => {
    expect(maths('设 $x^2$ 与 $\\alpha$。')).toEqual(['$x^2$', '$\\alpha$'])
  })
  it('$5 到 $10 不是公式', () => {
    expect(maths('价格从 $5 到 $10 不等')).toEqual([])
    expect(maths('$5 and $10')).toEqual([])
  })
  it('开头 $ 后是空白、结尾 $ 前是空白都不算', () => {
    expect(maths('$ x$')).toEqual([])
    expect(maths('$x $')).toEqual([])
  })
  it('结尾 $ 后紧跟数字不算结尾', () => {
    expect(maths('$x$1')).toEqual([])
    // 跳过后紧跟数字的 $，接着找下一个合格的结尾
    expect(maths('$x$1 和 $y$')).toEqual(['$x$1 和 $y$'])
  })
  it('\\$ 是字面量', () => {
    expect(maths('\\$5 和 \\$10')).toEqual([])
    expect(maths('\\$x$')).toEqual([])
    expect(maths('$a\\$b$')).toEqual(['$a\\$b$'])
  })
  it('$$...$$ 写在行内也是公式，空的 $$ 不是', () => {
    expect(maths('前 $$x + y$$ 后')).toEqual(['$$x + y$$'])
    expect(maths('$$')).toEqual([])
  })
  it('代码里的 $ 不是公式', () => {
    expect(maths("`$x$` 和\n\n```\n$y$\n```")).toEqual([])
  })
  it('不跨行', () => {
    expect(maths('$a\nb$')).toEqual([])
  })
})

// 文本里的块级嵌入块（块级公式、```mermaid / ```math）
function blocks(text: string): Embed[] {
  const state = EditorState.create({ doc: text, extensions: markdown({ base: markdownLanguage, extensions: [mathSyntax] }) })
  const out: Embed[] = []
  ensureSyntaxTree(state, text.length)!.iterate({
    enter: (n) => {
      const e = embedOf(state, n.node)
      if (e?.block) out.push(e)
    },
  })
  return out
}
const srcs = (text: string) => blocks(text).map((e) => e.src)

describe('块级公式', () => {
  it('三行写法与单行写法', () => {
    expect(srcs('$$\nx^2\n$$')).toEqual(['x^2'])
    expect(blocks('$$x$$')[0]).toMatchObject({ src: 'x', sep: '', text: '$$x$$' })
  })
  it('打断段落：前后是正文', () => {
    expect(srcs('正文\n$$\na\n$$\n后文')).toEqual(['a'])
  })
  it('空公式', () => {
    expect(srcs('$$\n$$')).toEqual([''])
  })
  it('没闭合、中间有空行、中间还有 $$ 都不算', () => {
    expect(srcs('$$\na')).toEqual([])
    expect(srcs('$$\na\n\nb\n$$')).toEqual([])
    expect(srcs('$$a$$ b $$')).toEqual([])
  })
  it('先于 Markdown 块结构识别：内容像列表、标题也是公式', () => {
    expect(srcs('$$\n- x + y\n$$')).toEqual(['- x + y'])
    expect(srcs('$$\n# a\n$$')).toEqual(['# a'])
  })
  it('引用和列表里的公式、Mermaid：源码不含续行前缀，整行替换', () => {
    const [q] = blocks('前\n\n> $$\n> a\n> $$\n\n后')
    expect(q).toMatchObject({ src: 'a', prefix: '> ', text: '> $$\n> a\n> $$' })
    expect(embedText(q, 'b\nc')).toBe('> $$\n> b\n> c\n> $$')
    const [l] = blocks('- 项\n\n  $$\n  a\n  $$')
    expect(l).toMatchObject({ src: 'a', prefix: '  ' })
    expect(embedText(l, 'b')).toBe('  $$\n  b\n  $$')
    const [m] = blocks('> ```mermaid\n> graph TD\n>   A --> B\n> ```')
    expect(m).toMatchObject({ kind: 'mermaid', src: 'graph TD\n  A --> B' })
    expect(embedText(m, 'graph LR')).toBe('> ```mermaid\n> graph LR\n> ```')
  })
  it('单行写法改成多行源码时拆成三行', () => {
    expect(embedText(blocks('$$x$$')[0], 'a\nb')).toBe('$$\na\nb\n$$')
  })
  it('结尾的 \$$ 是转义的美元符号，不是结束符', () => {
    expect(srcs('$$\nx\\$$\n后文')).toEqual([])
    expect(srcs('$$\nx\\$$\n$$')).toEqual(['x\\$$'])
    expect(srcs('$$x\\$$')).toEqual([])
    expect(srcs('$$\nx\\\\$$')).toEqual(['x\\\\']) // `\\` 是转义的反斜杠，之后的 $$ 照常结束
  })
  it('写在行内的 $$x$$ 按公式编辑（弹窗），不是行内浮层', () => {
    const state = EditorState.create({ doc: '前 $$x$$ 后', extensions: markdown({ base: markdownLanguage, extensions: [mathSyntax] }) })
    let e: Embed | null = null
    ensureSyntaxTree(state, 10)!.iterate({ enter: (n) => void (e ??= embedOf(state, n.node)) })
    expect(e).toMatchObject({ kind: 'math', block: false, display: true, src: 'x' })
  })
  it('写在行内的 $$ 不能写入换行，块级的可以', () => {
    const state = EditorState.create({ doc: '前 $$x$$ 后', extensions: markdown({ base: markdownLanguage, extensions: [mathSyntax] }) })
    let e: Embed | null = null
    ensureSyntaxTree(state, 10)!.iterate({ enter: (n) => void (e ??= embedOf(state, n.node)) })
    expect(canWrite(e!, 'x% comment\n+y')).toBe(false)
    expect(canWrite(e!, 'x + y')).toBe(true)
    expect(canWrite(blocks('$$x$$')[0], 'a\nb')).toBe(true)
  })
})
