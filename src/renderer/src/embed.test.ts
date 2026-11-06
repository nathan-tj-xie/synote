import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { canWrite, embedOf, embedText, mathSyntax, type Embed } from './embed'
import { livePreview, openLinesAtBlocks, typeAtBlocks } from './livePreview'

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
    expect(blocks('$$x$$')[0]).toMatchObject({ src: 'x', tight: [true, true], text: '$$x$$' })
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
  it('单行写法改成多行源码时定界符仍和源码同行，照样是块级公式', () => {
    const text = embedText(blocks('$$x$$')[0], 'a\nb')
    expect(text).toBe('$$a\nb$$')
    expect(srcs(text)).toEqual(['a\nb'])
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
  it('源码原样还原：首尾空白、定界符同行的写法、容器前缀都不变', () => {
    expect(srcs('$$  x  $$')).toEqual(['  x  '])
    for (const doc of ['$$  x  $$', '$$ a\nb $$', '$$\n  x\n$$', '$$\nx\n$$', '$$\n$$', '> $$\n> a\n> $$', '- 项\n\n  $$\n  a\n  $$', '```mermaid\nflowchart LR\n  A --> B\n```', '```math\n\na\n```']) {
      const [e] = blocks(doc)
      expect(embedText(e, e.src), doc).toBe(e.text)
    }
  })
})

describe('输入不会贴到块级嵌入块的定界符上', () => {
  const type = (doc: string, at: number, insert: string) => {
    const s = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [mathSyntax] }), livePreview(null)] })
    ensureSyntaxTree(s, doc.length)
    const t = s.update({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.type' })
    return { doc: t.state.doc.toString(), head: t.state.selection.main.head }
  }
  it('文末的块之后：输入挤到下一行，光标在输入之后', () => {
    expect(type('$$\nx\n$$', 7, 'Z')).toEqual({ doc: '$$\nx\n$$\nZ', head: 9 })
    expect(type('```mermaid\nA\n```', 16, 'Z').doc).toBe('```mermaid\nA\n```\nZ')
  })
  it('两个相邻块之间：前一块之后、后一块之前都不会贴上', () => {
    const doc = '$$\na\n$$\n$$\nb\n$$'
    expect(type(doc, 7, 'Z')).toEqual({ doc: '$$\na\n$$\nZ\n$$\nb\n$$', head: 9 })
    expect(type(doc, 8, 'Z')).toEqual({ doc: '$$\na\n$$\nZ\n$$\nb\n$$', head: 9 })
  })
  it('换行本身、不挨着块的输入、非用户输入都不改', () => {
    expect(type('$$\nx\n$$', 7, '\n').doc).toBe('$$\nx\n$$\n')
    expect(type('a\n$$\nx\n$$', 1, 'Z').doc).toBe('aZ\n$$\nx\n$$')
    const s = EditorState.create({ doc: '$$\nx\n$$', extensions: [markdown({ base: markdownLanguage, extensions: [mathSyntax] }), livePreview(null)] })
    ensureSyntaxTree(s, 7)
    expect(s.update({ changes: { from: 7, insert: 'Z' } }).state.doc.toString()).toBe('$$\nx\n$$Z')
  })
  const at = (doc: string, ...heads: number[]) => {
    const s = EditorState.create({
      doc,
      selection: EditorSelection.create(heads.map((h) => EditorSelection.cursor(h))),
      extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage, extensions: [mathSyntax] }), livePreview(null)],
    })
    ensureSyntaxTree(s, doc.length)
    return s
  }
  it('块边界上的按键输入：每个光标都照常写入，在边界的那个被挤到块外', () => {
    const s = at('a\n$$\nx\n$$', 1, 9)
    const t = s.update(typeAtBlocks(s, 'Z')!).state
    expect(t.doc.toString()).toBe('aZ\n$$\nx\n$$\nZ')
    expect(t.selection.ranges.map((r) => r.head)).toEqual([2, 12])
    expect(typeAtBlocks(at('a\n$$\nx\n$$', 1), 'Z')).toBeNull() // 没有光标在边界：交给浏览器
  })
  it('输入法组字开始前：贴着定界符的光标先换到块外的新行', () => {
    const s = at('$$\nx\n$$\nb\n$$\ny\n$$', 7, 10, 9)
    const t = s.update(openLinesAtBlocks(s)!).state
    expect(t.doc.toString()).toBe('$$\nx\n$$\n\nb\n\n$$\ny\n$$')
    expect(t.selection.ranges.map((r) => t.doc.lineAt(r.head).text)).toEqual(['', 'b', ''])
    expect(openLinesAtBlocks(at('a $$x$$ b', 3))).toBeNull()
  })
})
