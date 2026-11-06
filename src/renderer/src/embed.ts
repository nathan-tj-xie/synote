// 嵌入块（GLOSSARY）：Mermaid 图、块级公式、行内公式的识别与渲染。正文里怎么显示、怎么编辑见 livePreview.ts / Embed.tsx
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownConfig } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { tokens } from '../../shared/tokens'

// 一个嵌入块：[from, to] 是它在正文里的整段源码 text；改写时整段换成 open + sep + 新源码 + sep + close
export type Embed = {
  kind: 'mermaid' | 'math' | 'inline'
  from: number
  to: number
  text: string
  src: string
  open: string
  close: string
  sep: '\n' | ''
  display: boolean // 公式按块级（display mode）排版
}

export function embedText(e: Embed, src: string): string {
  if (e.kind === 'inline') return src ? `${e.open}${src}${e.close}` : '' // 行内公式清空即删除
  return src ? `${e.open}${e.sep}${src}${e.sep}${e.close}` : `${e.open}\n${e.close}`
}

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

// lezer 扩展：行内公式 InlineMath（含定界符 InlineMathMark）
export const inlineMath: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: t.special(t.string) },
    { name: 'InlineMathMark', style: t.processingInstruction },
  ],
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

// 段落里的块级公式：从以 `$$` 开头的行到以 `$$` 结尾的行（可以是同一行），中间没有别的 `$$`。
// Pandoc 里 `$$` 是段落内的元素，不跨空行；所以只在段落内找，没闭合的 `$$` 也不会吞掉后面的正文
export function blockMath(lines: string[]): { first: number; last: number; src: string }[] {
  const out: { first: number; last: number; src: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('$$')) continue
    for (let j = i; j < lines.length; j++) {
      const text = lines.slice(i, j + 1).join('\n').trim()
      if (text.length < 4 || !text.endsWith('$$')) continue
      const src = text.slice(2, -2)
      if (src.includes('$$')) break
      out.push({ first: i, last: j, src: src.replace(/^[ \t]*\n|\n[ \t]*$/g, '') })
      i = j
      break
    }
  }
  return out
}

// 顶层块 n 里的嵌入块：```mermaid / ```math 围栏（须闭合，否则未闭合的围栏会吞掉后面全文）和段落里的块级公式。
// shortcut: 引用、列表里的嵌入块按普通代码块 / 正文显示（续行前缀的读写还没做），用户需要时再支持
export function blockEmbeds(state: EditorState, n: SyntaxNode): Embed[] {
  const doc = state.doc
  if (n.parent?.name !== 'Document') return []
  if (n.name === 'FencedCode') {
    const info = n.getChild('CodeInfo')
    const lang = info && state.sliceDoc(info.from, info.to).toLowerCase()
    const close = n.lastChild
    const open = doc.lineAt(n.from)
    if ((lang !== 'mermaid' && lang !== 'math') || close?.name !== 'CodeMark' || doc.lineAt(close.from).number === open.number) return []
    const last = doc.lineAt(close.from)
    const src = open.number + 1 < last.number ? state.sliceDoc(open.to + 1, last.from - 1) : ''
    return [{ kind: lang === 'mermaid' ? 'mermaid' : 'math', from: open.from, to: last.to, text: state.sliceDoc(open.from, last.to), src, open: open.text, close: last.text, sep: '\n', display: true }]
  }
  if (n.name !== 'Paragraph' || !state.sliceDoc(n.from, n.to).includes('$$')) return []
  const first = doc.lineAt(n.from).number
  const lines: string[] = []
  for (let i = first; i <= doc.lineAt(n.to).number; i++) lines.push(doc.line(i).text)
  return blockMath(lines).map((m) => {
    const from = doc.line(first + m.first).from
    const to = doc.line(first + m.last).to
    return { kind: 'math', from, to, text: state.sliceDoc(from, to), src: m.src, open: '$$', close: '$$', sep: m.first === m.last ? '' : '\n', display: true }
  })
}

export function inlineEmbed(state: EditorState, n: SyntaxNode): Embed {
  const d = state.sliceDoc(n.from, n.from + 2) === '$$' ? 2 : 1
  const open = '$'.repeat(d)
  return { kind: 'inline', from: n.from, to: n.to, text: state.sliceDoc(n.from, n.to), src: state.sliceDoc(n.from + d, n.to - d), open, close: open, sep: '', display: d === 2 }
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
