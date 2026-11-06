// 嵌入块（GLOSSARY）：Mermaid 图、块级公式、行内公式的识别与渲染。正文里怎么显示、怎么编辑见 livePreview.ts / EmbedEditor.tsx
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { tokens } from '../../shared/tokens'

// 一个嵌入块：[from, to] 是它在正文里的整段源码 text。块级（block）的占整行，在引用 / 列表里时连同行首的 `> `、缩进；
// 改写时按 open、各行加 prefix 的源码、prefix + close 重新拼出整段；tight 记着源码首行是否紧跟开头定界符、末行是否紧挨结尾定界符
// （`$$x$$`、`$$ a\nb $$`），按原来的样子拼回，没改的源码拼出来和原文一字不差。
// kind：mermaid / math 在弹窗里编辑（包括写在行内的 `$$x$$`），inline（`$x$`）在浮层里编辑
export type Embed = {
  kind: 'mermaid' | 'math' | 'inline'
  block: boolean
  from: number
  to: number
  text: string
  src: string
  open: string
  close: string
  prefix: string // 块级源码各行的续行前缀（`> `、列表缩进）
  tight: [boolean, boolean]
  display: boolean // 公式按块级（display mode）排版
}

export function embedText(e: Embed, src: string): string {
  if (!e.block) return src ? `${e.open}${src}${e.close}` : '' // 清空即删除；不能有换行（canWrite）
  const [a, b] = e.tight
  if (!src && !a) return `${e.open}\n${e.prefix}${e.close}`
  const lines = src.split('\n').map((l, i) => (i === 0 && a ? l : l ? e.prefix + l : e.prefix.trimEnd()))
  return `${e.open}${a ? '' : '\n'}${lines.join('\n')}${b ? '' : '\n' + e.prefix}${e.close}`
}

// 行内公式不能跨行：换行换成空格会改变含义（`%` 注释会吞掉下一行），所以有换行就不写
export const canWrite = (e: Embed, src: string) => e.block || !src.includes('\n')

const space = (c: string | undefined) => c === undefined || /\s/.test(c)

// text[i] 是 `$`：按 Pandoc tex_math_dollars 找公式的结尾（结尾定界符之后），不是公式时 -1。
// `$`：开头的 `$` 后不跟空白，结尾的 `$` 前不是空白、后不紧跟数字（`$5 到 $10` 不是公式）；`$$` 内容非空即可。
// `\$` 是字面量：开头的由 lezer 的 Escape 先吃掉，内容里的这里跳过
export function mathEnd(text: string, i: number): number {
  const d = text.startsWith('$$', i) ? 2 : 1
  const open = i + d
  if (d === 1 && space(text[open])) return -1
  for (let j = open; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') j++
    else if (c === '\n') return -1 // shortcut: 行内公式不跨行（实时预览的行内替换不能跨行），有需要再支持软换行
    else if (c === '$' && d === 2) return text[j + 1] === '$' && j > open ? j + 2 : -1
    else if (c === '$' && !space(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? '')) return j + 1
  }
  return -1
}

// 块级公式 BlockMath：从以 `$$` 开头的行到以 `$$` 结尾的行（可以是同一行），先于列表、标题等块结构识别（`$$\n- x\n$$` 是公式）。
// Pandoc 里 `$$` 不跨空行：没有闭合（遇到空行、文末）就不是公式，未闭合的 `$$` 不会吞掉后面的正文
const isOpen = (line: Line) => line.indent - line.baseIndent < 4 && line.text.startsWith('$$', line.pos)
// 第一个没被转义的 `$$` 的位置（`\$` 是字面量，`\\` 是转义的反斜杠），没有时 -1
function mathMark(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text.startsWith('$$', i)) return i
  }
  return -1
}
// 以没转义的 `$$` 结尾，且前面没有别的 `$$`
const endsMath = (text: string) => {
  const i = mathMark(text)
  return i >= 0 && i === text.trimEnd().length - 2
}

// 开头这行之后能否闭合。shortcut: 用 BlockContext 的私有 scanLine 读后面的原始行（公开的 peekLine 只能看一行），
// 续行前缀按 `>`、空白粗略去掉；依赖 @lezer/markdown 1.8.1 的内部实现，升级时核对
function closes(cx: BlockContext, line: Line): boolean {
  const rest = line.text.slice(line.pos + 2)
  if (rest.trim().length >= 2 && endsMath(rest)) return true
  if (mathMark(rest) >= 0) return false
  const scan = (cx as unknown as { scanLine(pos: number): { text: string; end: number } }).scanLine.bind(cx)
  for (let pos = cx.lineStart + line.text.length + 1; ; ) {
    const r = scan(pos)
    const text = r.text.replace(/^[\s>]*/, '')
    if (!text.trim()) return false
    if (endsMath(text)) return true
    if (mathMark(text) >= 0 || r.end <= pos) return false
    pos = r.end + 1
  }
}

const blockMath = {
  name: 'BlockMath',
  parse(cx: BlockContext, line: Line) {
    if (!isOpen(line) || !closes(cx, line)) return false
    const from = cx.lineStart + line.pos
    const marks = [cx.elt('BlockMathMark', from, from + 2)]
    // 一行里的源码（去掉结尾的 `$$`）记成 BlockMathText，各行之间的前缀不在里面
    const text = (start: number, end: number) => {
      const s = cx.lineStart + start
      const t = cx.lineStart + end
      if (t > s) marks.push(cx.elt('BlockMathText', s, t))
    }
    const rest = line.text.slice(line.pos + 2)
    if (rest.trim().length >= 2 && endsMath(rest)) {
      const end = line.text.trimEnd().length
      text(line.pos + 2, end - 2)
      marks.push(cx.elt('BlockMathMark', cx.lineStart + end - 2, cx.lineStart + end))
      cx.addElement(cx.elt('BlockMath', from, cx.lineStart + end, marks))
      cx.nextLine()
      return true
    }
    text(line.pos + 2, line.text.length)
    let to = cx.lineStart + line.text.length
    // 同 lezer 的 FencedCode：所在容器结束就停（line.depth 运行时有、类型里没有，同 closes 的 shortcut）
    while (cx.nextLine() && (line as Line & { depth: number }).depth >= cx.depth) {
      for (const m of line.markers) marks.push(m)
      if (endsMath(line.text.slice(line.basePos))) {
        const end = line.text.trimEnd().length
        text(line.basePos, end - 2)
        marks.push(cx.elt('BlockMathMark', cx.lineStart + end - 2, cx.lineStart + end))
        to = cx.lineStart + end
        cx.nextLine()
        break
      }
      text(line.basePos, line.text.length)
      to = cx.lineStart + line.text.length
    }
    cx.addElement(cx.elt('BlockMath', from, to, marks))
    return true
  },
  // 打断前面的段落（`正文\n$$\nx\n$$`）
  endLeaf: (cx: BlockContext, line: Line) => isOpen(line) && closes(cx, line),
  before: 'FencedCode',
}

// lezer 扩展：行内公式 InlineMath（含定界符 InlineMathMark）和块级公式 BlockMath
export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: t.special(t.string) },
    { name: 'InlineMathMark', style: t.processingInstruction },
    { name: 'BlockMath', block: true, style: t.special(t.string) },
    { name: 'BlockMathMark', style: t.processingInstruction },
    { name: 'BlockMathText' },
  ],
  parseBlock: [blockMath],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== 36) return -1
        const end = mathEnd(cx.slice(pos, cx.end), 0)
        if (end < 0) return -1
        const d = cx.char(pos + 1) === 36 ? 2 : 1
        return cx.addElement(cx.elt('InlineMath', pos, pos + end, [cx.elt('InlineMathMark', pos, pos + d), cx.elt('InlineMathMark', pos + end - d, pos + end)]))
      },
    },
  ],
}

// 块级的嵌入块范围占整行；续行前缀：开头那行在定界符前的部分里，除 `>` 外都换成空格（`> - ` → `>   `）
function blockEmbed(state: EditorState, kind: Embed['kind'], openEnd: number, contentFrom: SyntaxNode, closeMark: SyntaxNode, src: string, tight: [boolean, boolean]): Embed {
  const doc = state.doc
  const first = doc.lineAt(contentFrom.from)
  const last = doc.lineAt(closeMark.from)
  const prefix = state.sliceDoc(first.from, contentFrom.from).replace(/[^>\s]/g, ' ')
  return { kind, block: true, from: first.from, to: last.to, text: state.sliceDoc(first.from, last.to), src, open: state.sliceDoc(first.from, openEnd), close: state.sliceDoc(closeMark.from, last.to), prefix, tight, display: true }
}

// 节点 n 本身是不是一个嵌入块：```mermaid / ```math 围栏（须闭合，否则未闭合的围栏会吞掉后面全文）、块级公式、行内公式
export function embedOf(state: EditorState, n: SyntaxNode): Embed | null {
  const doc = state.doc
  if (n.name === 'InlineMath') {
    const d = state.sliceDoc(n.from, n.from + 2) === '$$' ? 2 : 1
    const open = '$'.repeat(d)
    const src = state.sliceDoc(n.from + d, n.to - d)
    return { kind: d === 2 ? 'math' : 'inline', block: false, from: n.from, to: n.to, text: state.sliceDoc(n.from, n.to), src, open, close: open, prefix: '', tight: [true, true], display: d === 2 }
  }
  if (n.name === 'BlockMath') {
    const marks = n.getChildren('BlockMathMark')
    if (marks.length < 2) return null
    // 各行的源码原样拼起来（不去首尾空白）：没改的公式写回时一字不差
    const parts = n.getChildren('BlockMathText')
    const src = parts.map((c) => state.sliceDoc(c.from, c.to)).join('\n')
    const line = (p: number) => doc.lineAt(p).number
    const tight: [boolean, boolean] = parts.length ? [line(parts[0].from) === line(marks[0].from), line(parts.at(-1)!.to) === line(marks[1].from)] : [false, false]
    return blockEmbed(state, 'math', marks[0].to, n, marks[1], src, tight)
  }
  if (n.name !== 'FencedCode') return null
  const info = n.getChild('CodeInfo')
  const lang = info && state.sliceDoc(info.from, info.to).toLowerCase()
  const close = n.lastChild
  if ((lang !== 'mermaid' && lang !== 'math') || close?.name !== 'CodeMark' || doc.lineAt(close.from).number === doc.lineAt(n.from).number) return null
  const src = n
    .getChildren('CodeText')
    .map((c) => state.sliceDoc(c.from, c.to))
    .join('') // CodeText 不含续行前缀，行间的换行也是 CodeText
  return blockEmbed(state, lang === 'mermaid' ? 'mermaid' : 'math', doc.lineAt(n.from).to, n, close, src, [false, false])
}

// 渲染失败：原位显示红色源码，悬停显示报错
function fail(el: HTMLElement, text: string, err: unknown) {
  el.classList.add('cm-embed-error')
  el.textContent = text
  el.title = err instanceof Error ? err.message : String(err)
}

// Mermaid 很大，第一次用到才加载；同一段源码的渲染结果缓存
let mermaid: Promise<typeof import('mermaid').default> | null = null
const svgs = new Map<string, Promise<string>>()
let mermaidSeq = 0

function mermaidSvg(src: string): Promise<string> {
  let p = svgs.get(src)
  if (!p) {
    mermaid ??= import('mermaid').then(({ default: m }) => {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'dark',
        themeVariables: { darkMode: true, background: tokens.bg, primaryColor: tokens.bgRaised, primaryBorderColor: tokens.border, primaryTextColor: tokens.fg, lineColor: tokens.fgMuted, mainBkg: tokens.bgRaised, nodeBorder: tokens.fgMuted, edgeLabelBackground: tokens.bg, fontFamily: 'inherit' },
      })
      return m
    })
    const id = `synote-mermaid-${++mermaidSeq}`
    p = mermaid.then((m) => m.render(id, src)).then(
      (r) => r.svg,
      (e) => {
        document.getElementById(id)?.remove()
        document.getElementById(`d${id}`)?.remove()
        throw e
      },
    )
    if (svgs.size >= 100) svgs.clear() // shortcut: 满了整个清空而不是 LRU，图很多的笔记卡顿时再换
    svgs.set(src, p)
  }
  return p
}

// 把嵌入块渲染进 el：空源码显示提示，失败显示 fallback（通常是正文里的源码）。Mermaid 是异步的，画完调用 done
export function renderEmbed(el: HTMLElement, kind: Embed['kind'], src: string, display: boolean, fallback: string, empty: string, done?: () => void) {
  el.classList.remove('cm-embed-error')
  el.removeAttribute('title')
  el.dataset.src = src // 预览里连续输入：只认最后一次的异步结果
  if (!src.trim()) {
    el.classList.add('cm-embed-empty')
    el.textContent = empty
    return
  }
  el.classList.remove('cm-embed-empty')
  if (kind !== 'mermaid') {
    try {
      katex.render(src, el, { displayMode: display, throwOnError: true })
    } catch (e) {
      fail(el, fallback, e)
    }
    return
  }
  mermaidSvg(src).then(
    (svg) => {
      if (el.dataset.src !== src) return
      el.innerHTML = svg // securityLevel strict：Mermaid 已用 DOMPurify 清洗
      done?.()
    },
    (e) => {
      if (el.dataset.src !== src) return
      fail(el, fallback, e)
      done?.()
    },
  )
}
