// 实时预览（GLOSSARY）：只用 decoration / widget 改变显示，从不改动正文文本——diff 按偏移同步（diff.ts）、
// 只打开不编辑时源码字节不变，都依赖这一点。唯一会写正文的是任务列表勾选，它走普通的编辑事务和保存路径。
// 光标 / 选区碰到的行显示源码，其余行渲染；按行而不是按元素切换，光标在行内移动时装饰不变，输入法组字更稳
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { tags as t } from '@lezer/highlight'
import { i18next } from '../../shared/i18n'
import { dataUrl, imageMime, MAX_IMAGE, resolveImage } from './diffUtil'

// 当前正文属于哪个库的哪篇笔记：图片按笔记目录解析、经现有 readBytes（带库标识校验）读取
type Note = { vault: string; path: string }
const note = Facet.define<Note, Note | null>({ combine: (v) => v[0] ?? null })

// 组字结束、图片缓存失效后要求重建
const refresh = StateEffect.define<null>()

// 选区碰到的行区间，作为「哪些地方显示源码」的指纹：没变就不必为选区变化重建
function activeKey(state: EditorState): string {
  return state.selection.ranges.map((r) => `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number}`).join(',')
}

// [from, to] 所在的整行范围是否碰到任何选区
function touches(state: EditorState, from: number, to: number): boolean {
  const a = state.doc.lineAt(from).from
  const b = state.doc.lineAt(to).to
  return state.selection.ranges.some((r) => r.from <= b && r.to >= a)
}

// 组字期间（含组字产生的事务）只映射旧装饰，不重建：重建可能重绘光标所在行，打断输入法、闪烁跳光标
const composing = (u: ViewUpdate) => u.view.composing || u.transactions.some((tr) => tr.isUserEvent('input.type.compose'))
const refreshed = (trs: readonly Transaction[]) => trs.some((tr) => tr.effects.some((e) => e.is(refresh)))

const hidden = Decoration.replace({})
const line = (cls: string) => Decoration.line({ class: cls })
const mark = (cls: string) => Decoration.mark({ class: cls })

class Bullet extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-bullet'
    el.textContent = '•'
    return el
  }
}

// 任务勾选：改的是 `[ ]` / `[x]` 中间那一个字符，走普通事务 → updateListener → 自动保存
class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(o: Checkbox) {
    return o.checked === this.checked
  }
  toDOM(view: EditorView) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.className = 'cm-lp-task'
    el.checked = this.checked
    el.addEventListener('mousedown', (e) => e.preventDefault()) // 不让光标移进来（那样整行会切成源码）
    el.addEventListener('click', (e) => {
      e.preventDefault()
      if (view.state.readOnly) return
      const pos = view.posAtDOM(el)
      const box = view.state.sliceDoc(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(box)) return
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: box[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' })
    })
    return el
  }
  ignoreEvent() {
    return true
  }
}

class Rule extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-hr'
    return el
  }
}

// 代码块开头一行渲染成语言标签
class FenceLabel extends WidgetType {
  constructor(readonly info: string) {
    super()
  }
  eq(o: FenceLabel) {
    return o.info === this.info
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-fence'
    el.textContent = this.info
    return el
  }
}

// 图片：只读库内文件（readBytes 校验库标识与路径），转成 data URL（CSP 只放行 'self' 和 data:）。
// 缓存按库 + 路径，文件有外部改动时失效
const images = new Map<string, Promise<string | null>>()
let imageGen = 0
const views = new Set<EditorView>()

function loadImage(vault: string, path: string): Promise<string | null> {
  const key = `${vault}\0${path}`
  let p = images.get(key)
  if (!p) {
    if (images.size >= 200) images.clear() // shortcut: 满了整个清空而不是 LRU；图片多的笔记来回切换卡顿时再换
    p = window.synote.readBytes(vault, path).then(
      (b) => (b.length > MAX_IMAGE ? Promise.reject(new Error('too large')) : dataUrl(b, imageMime(path)!)),
      () => null,
    )
    images.set(key, p)
  }
  return p
}

// 单测（node）里没有 window
if (typeof window !== 'undefined') window.synote.onVaultChanged(({ root, changed }) => {
  let hit = false
  for (const p of changed) hit = images.delete(`${root}\0${p}`) || hit
  if (!hit) return
  imageGen++
  for (const v of views) v.dispatch({ effects: refresh.of(null) })
})

class ImageWidget extends WidgetType {
  constructor(
    readonly vault: string | null,
    readonly path: string | null,
    readonly src: string,
    readonly alt: string,
    readonly gen: number,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.vault === this.vault && o.path === this.path && o.src === this.src && o.alt === this.alt && o.gen === this.gen
  }
  get estimatedHeight() {
    return 200
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'cm-lp-image'
    const fail = (text: string) => {
      box.className = 'cm-lp-image-missing'
      box.textContent = text
    }
    // 外链、越出笔记库的路径不加载（CSP 也不放行外链）：显示替代文字
    if (!this.vault || !this.path) {
      fail(this.alt || this.src)
      return box
    }
    const path = this.path
    loadImage(this.vault, path).then(
      (url) => {
        if (!url) return fail(i18next.t('imageMissing', { path }))
        const img = document.createElement('img')
        img.src = url
        img.alt = this.alt
        img.onload = () => view.requestMeasure()
        box.appendChild(img)
      },
      () => fail(i18next.t('imageTooLarge')),
    )
    return box
  }
}

// HTML 实体（`&amp;`、`&#35;`）显示成它代表的字符；交给浏览器解码，先校验确实只是一个实体
class EntityWidget extends WidgetType {
  constructor(readonly entity: string) {
    super()
  }
  eq(o: EntityWidget) {
    return o.entity === this.entity
  }
  toDOM() {
    const el = document.createElement('span')
    if (/^&(#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{0,31});$/i.test(this.entity)) el.innerHTML = this.entity
    else el.textContent = this.entity
    return el
  }
}

// 跨行链接整段替换成它的文字
class LinkText extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(o: LinkText) {
    return o.text === this.text
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-link'
    el.textContent = this.text
    return el
  }
}

// 引用定义 `[ref]: 地址`：标签按 CommonMark 规则归一（去括号、折叠空白、不分大小写）
const normLabel = (s: string) => s.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase()
export function linkRefs(state: EditorState): Map<string, string> {
  const refs = new Map<string, string>()
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== 'LinkReference') return CONTAINERS.has(n.name)
      const label = n.node.getChild('LinkLabel')
      const url = n.node.getChild('URL')
      const key = label && normLabel(state.sliceDoc(label.from, label.to))
      if (key && url && !refs.has(key)) refs.set(key, state.sliceDoc(url.from, url.to)) // 重复定义以第一个为准
      return false
    },
  })
  return refs
}

// 链接 / 图片的文字（[ 与 ] 之间）和地址：内联写法取 URL 子节点；引用写法（`[文][ref]`、`[文][]`、`[文]`）按标签查定义，
// 查不到时地址为 null（那就不是链接，显示源码）
// [from, to] 里的显示文字：跨行时去掉续行行首的容器标记（引用的 `>`）和缩进，换行折成一个空格
export function plainText(state: EditorState, from: number, to: number): string {
  const quotes: number[] = []
  syntaxTree(state).iterate({ from, to, enter: (n) => void (n.name === 'QuoteMark' && quotes.push(n.from)) })
  const doc = state.doc
  const parts: string[] = []
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos)
    let start = pos
    if (pos !== from)
      for (;;) {
        while (start < line.to && /\s/.test(doc.sliceString(start, start + 1))) start++
        if (!quotes.includes(start)) break
        start++ // 跳过 `>`，后面的空格由下一轮跳过
      }
    parts.push(doc.sliceString(start, Math.min(line.to, to)))
    pos = line.to + 1
  }
  return unescape(parts.join(' ').replace(/\s+/g, ' ').trim())
}

// 反斜杠转义（`\]`、`\|` 等 ASCII 标点）显示成字符本身
const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1')

function linkParts(state: EditorState, n: SyntaxNode, refs: () => Map<string, string>): { text: string; target: string | null } | null {
  const marks = n.getChildren('LinkMark')
  if (marks.length < 2) return null
  const text = plainText(state, marks[0].to, marks[1].from)
  const url = n.getChild('URL')
  if (url) return { text, target: state.sliceDoc(url.from, url.to) }
  if (marks.length > 2) return { text, target: '' } // `[文]()`：空地址
  const label = n.getChild('LinkLabel')
  const key = normLabel(label && label.to - label.from > 2 ? plainText(state, label.from, label.to) : text)
  // `[^1]` 是脚注写法（MVP 不支持脚注），不当成引用链接，保持源码
  return { text, target: key.startsWith('^') ? null : (refs().get(key) ?? null) }
}

function imageWidget(state: EditorState, text: string, target: string): ImageWidget {
  const info = state.facet(note)
  const path = info && target ? resolveImage(target, info.path) : null
  return new ImageWidget(info?.vault ?? null, path, target, text, imageGen)
}

// 表格：整块替换成只读的 HTML 表格；点一下把光标放进表格，切回源码编辑
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly rows: string[][],
    readonly align: (string | null)[],
    readonly quoted: boolean, // 在引用里：整行（含 `> `）都被替换，引用的左边线由表格自己画
    readonly indent: number, // 在列表里：表格前的缩进列数
  ) {
    super()
  }
  eq(o: TableWidget) {
    return o.source === this.source
  }
  get estimatedHeight() {
    return this.rows.length * 30 + 8
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = this.quoted ? 'cm-lp-table cm-lp-quote' : 'cm-lp-table'
    wrap.style.marginLeft = `${this.indent}ch`
    const table = wrap.appendChild(document.createElement('table'))
    this.rows.forEach((cells, i) => {
      const tr = (i === 0 ? table.createTHead() : (table.tBodies[0] ?? table.createTBody())).insertRow()
      cells.forEach((text, j) => {
        const cell = tr.appendChild(document.createElement(i === 0 ? 'th' : 'td'))
        cell.textContent = text
        if (this.align[j]) cell.style.textAlign = this.align[j]!
      })
    })
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

function tableWidget(state: EditorState, n: SyntaxNode): TableWidget {
  const text = (a: number, b: number) => unescape(state.sliceDoc(a, b).trim())
  const rows: string[][] = []
  let align: (string | null)[] = []
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader' || c.name === 'TableRow') rows.push(c.getChildren('TableCell').map((cell) => text(cell.from, cell.to)))
    else if (c.name === 'TableDelimiter' && c.from !== c.to && /-/.test(state.sliceDoc(c.from, c.to)))
      align = text(c.from, c.to)
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((s) => {
          s = s.trim()
          return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null
        })
  }
  let quoted = false
  for (let p = n.parent; p; p = p.parent) quoted ||= p.name === 'Blockquote'
  const start = state.doc.lineAt(n.from).from
  return new TableWidget(state.sliceDoc(start, n.to), rows, align, quoted, quoted ? 0 : n.from - start)
}

// 引用定义所在的块级容器（linkRefs 只往这些节点里走）
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])
// 内容不按 Markdown 渲染的节点：里面的 `[..](..)` 不是链接
const RAW = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Comment', 'ProcessingInstructionBlock', 'LinkReference'])

// 跨行替换必须由 StateField 提供，ViewPlugin 不能替换换行。这里出两类：
// - 表格：块级替换按整行，引用、列表里的表格连同行首的 `> ` / 缩进一起替换
// - 跨行的链接 / 图片：整段替换成文字 / 图片（行内插件跳过它们和这些范围里的标记，不会叠加装饰）
export function buildBlocks(state: EditorState, refs: Map<string, string> = linkRefs(state)): DecorationSet {
  const out: Range<Decoration>[] = []
  const doc = state.doc
  const multiLine = (a: number, b: number) => doc.lineAt(a).number !== doc.lineAt(b).number
  syntaxTree(state).iterate({
    enter(n) {
      const name = n.name
      // 不按节点类型列白名单：除代码等原样节点外，凡是跨行的节点都往里走（任务项、Setext 标题、以后的新容器都覆盖到）；
      // 单行节点里不可能有跨行的链接 / 图片，整个跳过，所以每次重建只付跨行结构的代价
      if (RAW.has(name) || !multiLine(n.from, n.to)) return false
      if (name === 'Table') {
        if (!touches(state, n.from, n.to)) out.push(Decoration.replace({ widget: tableWidget(state, n.node), block: true }).range(doc.lineAt(n.from).from, n.to))
        return false
      }
      if (name === 'Link' || name === 'Image') {
        const parts = touches(state, n.from, n.to) ? null : linkParts(state, n.node, () => refs)
        if (parts && parts.target !== null) {
          const widget = name === 'Image' ? imageWidget(state, parts.text, parts.target) : new LinkText(parts.text)
          out.push(Decoration.replace({ widget }).range(n.from, n.to))
        }
        return false
      }
    },
  })
  return Decoration.set(out, true)
}

// 组字状态：由 DOM 的 compositionstart / end 维护。StateField 拿不到 view.composing，靠它在组字期间不重建表格
let ime = false

type BlockValue = { decos: DecorationSet; refs: Map<string, string>; key: string; stale: boolean }
function blockValue(state: EditorState): BlockValue {
  const refs = linkRefs(state)
  return { decos: buildBlocks(state, refs), refs, key: activeKey(state), stale: false }
}
const blocks = StateField.define<BlockValue>({
  create: blockValue,
  update(v, tr) {
    if (ime || tr.isUserEvent('input.type.compose')) return { ...v, decos: v.decos.map(tr.changes), stale: true }
    if (v.stale || tr.docChanged || activeKey(tr.state) !== v.key || syntaxTree(tr.state) !== syntaxTree(tr.startState) || refreshed([tr]))
      return blockValue(tr.state)
    return v
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
})

const MARKS: Record<string, string> = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }

// [from, to]（视口）内的行内装饰。只遍历视口，打开大文件、逐键输入都只付视口的代价
export function buildInline(state: EditorState, from: number, to: number): DecorationSet {
  const out: Range<Decoration>[] = []
  const doc = state.doc
  // 已由 blocks 整段替换的范围（表格、跨行链接 / 图片）：里面的 `> `、缩进、标记等不再加装饰
  const field = state.field(blocks, false)
  const rendered = field?.decos
  let refs: Map<string, string> | undefined
  const getRefs = () => (refs ??= field?.refs ?? linkRefs(state))
  const inTable = (a: number, b: number) => {
    let hit = false
    rendered?.between(a, a, (x, y) => {
      if (x <= a && b <= y) hit = true
    })
    return hit
  }
  // 块内的每一行加 line 装饰，只加视口里的那些行（大代码块不必整块走一遍）
  const lines = (a: number, b: number, cls: (first: boolean, last: boolean) => string) => {
    const first = doc.lineAt(a).number
    const last = doc.lineAt(b).number
    for (let i = Math.max(first, doc.lineAt(from).number); i <= Math.min(last, doc.lineAt(to).number); i++) {
      const l = doc.line(i)
      if (!inTable(l.from, l.to)) out.push(line(cls(i === first, i === last)).range(l.from))
    }
  }
  // ViewPlugin 的替换不能跨行（跨行的图片、链接标题等罕见写法就显示源码）
  const oneLine = (a: number, b: number) => a < b && doc.lineAt(a).to >= b
  const replace = (a: number, b: number, d: Decoration = hidden) => oneLine(a, b) && out.push(d.range(a, b))
  const hide = (a: number, b: number) => replace(a, b)
  // 标记连带一侧的一个空格一起隐藏（`# `、`> `、`- `）
  const spaceAfter = (p: number) => (doc.sliceString(p, p + 1) === ' ' ? p + 1 : p)

  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      const name = n.name
      if (inTable(n.from, n.to)) return false
      const active = () => touches(state, n.from, n.to)
      const h = /^(ATX|Setext)Heading(\d)$/.exec(name)
      if (h) {
        out.push(line(`cm-lp-h${h[2]}`).range(doc.lineAt(n.from).from))
        if (active()) return false
        for (const m of n.node.getChildren('HeaderMark')) {
          if (h[1] === 'Setext') {
            // 引用里的 Setext 下划线行，lezer 不给行首的 `>` 出 QuoteMark 节点：连同它一起藏
            const start = doc.lineAt(m.from).from
            hide(/^[\s>]*$/.test(doc.sliceString(start, m.from)) ? start : m.from, m.to)
          }
          else if (m.from === doc.lineAt(n.from).from) hide(m.from, spaceAfter(m.to))
          else hide(doc.sliceString(m.from - 1, m.from) === ' ' ? m.from - 1 : m.from, m.to) // 结尾的 `##`
        }
        return
      }
      switch (name) {
        case 'Table':
          return false // 由 blocks 字段整块处理
        case 'FencedCode': {
          lines(n.from, n.to, (a, b) => `cm-lp-codeblock${a ? ' cm-lp-codeblock-first' : ''}${b ? ' cm-lp-codeblock-last' : ''}`)
          if (!active()) {
            const open = doc.lineAt(n.from)
            const lang = n.node.getChild('CodeInfo')
            // 从围栏标记起替换，不碰同一行前面的引用 / 列表标记（它们有自己的装饰）
            replace(n.from, open.to, Decoration.replace({ widget: new FenceLabel(lang ? doc.sliceString(lang.from, lang.to) : '') }))
            const close = n.node.lastChild
            if (close?.name === 'CodeMark' && doc.lineAt(close.from).number !== open.number) hide(close.from, doc.lineAt(close.from).to)
          }
          return false // 代码内容交给嵌套语言高亮，不再往里走
        }
        case 'Blockquote':
          lines(n.from, n.to, () => 'cm-lp-quote')
          return
        case 'QuoteMark':
          if (!active()) hide(n.from, spaceAfter(n.to))
          return
        case 'HorizontalRule':
          if (!active()) replace(n.from, n.to, Decoration.replace({ widget: new Rule() }))
          return
        case 'ListMark': {
          if (active() || n.node.parent?.parent?.name !== 'BulletList') return
          // 任务项只留勾选框，圆点不显示
          if (n.node.nextSibling?.name === 'Task') hide(n.from, spaceAfter(n.to))
          else replace(n.from, n.to, Decoration.replace({ widget: new Bullet() }))
          return
        }
        case 'TaskMarker':
          if (!active()) replace(n.from, n.to, Decoration.replace({ widget: new Checkbox(/x/i.test(doc.sliceString(n.from, n.to))) }))
          return
        case 'InlineCode':
          out.push(mark('cm-lp-code').range(n.from, n.to))
          break
        case 'CodeBlock': // 缩进式代码块：没有围栏可藏，只加代码块底色
          lines(n.from, n.to, (a, b) => `cm-lp-codeblock${a ? ' cm-lp-codeblock-first' : ''}${b ? ' cm-lp-codeblock-last' : ''}`)
          return false
        case 'Autolink': {
          // <https://…>、<user@…> → 只显示地址
          const marks = n.node.getChildren('LinkMark')
          if (marks.length === 2) out.push(mark('cm-lp-link').range(marks[0].to, marks[1].from))
          if (!active() && marks.length === 2) {
            hide(marks[0].from, marks[0].to)
            hide(marks[1].from, marks[1].to)
          }
          return false
        }
        case 'URL':
          // GFM 裸链接（www.…、https://…、邮箱）：源码就是显示结果，只加链接样式；链接、图片、引用定义里的 URL 不在这里处理
          if (n.node.parent && !/^(Link|Image|Autolink|LinkReference)$/.test(n.node.parent.name)) out.push(mark('cm-lp-link').range(n.from, n.to))
          return
        case 'Escape': // `\*` → `*`
          if (!active()) hide(n.from, n.from + 1)
          return
        case 'HardBreak': // 行尾 `\` 硬换行：藏掉反斜杠；两个空格的写法本来就看不见
          if (!active() && doc.sliceString(n.from, n.from + 1) === '\\') hide(n.from, n.from + 1)
          return
        case 'Entity':
          if (!active()) replace(n.from, n.to, Decoration.replace({ widget: new EntityWidget(doc.sliceString(n.from, n.to)) }))
          return
        case 'Link': {
          if (!oneLine(n.from, n.to)) return false // 跨行的由 blocks 整段处理
          const parts = active() ? null : linkParts(state, n.node, getRefs)
          if (!parts || parts.target === null) return // 光标在这行，或是没有定义的 `[文]`（不是链接）
          // [名字](路径)、[名字][ref] → 只显示名字
          const marks = n.node.getChildren('LinkMark')
          hide(marks[0].from, marks[0].to)
          if (marks[0].to < marks[1].from) out.push(mark('cm-lp-link').range(marks[0].to, marks[1].from))
          hide(marks[1].from, n.to)
          return
        }
        case 'Image': {
          if (!oneLine(n.from, n.to) || active()) return false // 跨行的由 blocks 整段处理
          const parts = linkParts(state, n.node, getRefs)
          if (parts && parts.target !== null) replace(n.from, n.to, Decoration.replace({ widget: imageWidget(state, parts.text, parts.target) }))
          return false
        }
      }
      const markName = MARKS[name]
      if (markName && !active()) for (const m of n.node.getChildren(markName)) hide(m.from, m.to)
    },
  })
  return Decoration.set(out, true)
}

const inline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    key: string
    stale = false
    constructor(readonly view: EditorView) {
      views.add(view)
      this.decorations = buildInline(view.state, view.viewport.from, view.viewport.to)
      this.key = activeKey(view.state)
    }
    update(u: ViewUpdate) {
      if (composing(u)) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes)
        this.stale = true
        return
      }
      const key = activeKey(u.state)
      if (this.stale || u.docChanged || u.viewportChanged || key !== this.key || syntaxTree(u.state) !== syntaxTree(u.startState) || refreshed(u.transactions)) {
        this.decorations = buildInline(u.state, u.view.viewport.from, u.view.viewport.to)
        this.key = key
        this.stale = false
      }
    }
    destroy() {
      views.delete(this.view)
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      compositionstart() {
        ime = true
      },
      // 组字结束：补一次重建（组字期间只映射了旧装饰）
      compositionend(_e, view) {
        ime = false
        setTimeout(() => views.has(view) && view.dispatch({ effects: refresh.of(null) }))
      },
    },
  },
)

// 源码态（光标所在行）也保持同样的字重、字体，切换时不跳；代码块的嵌套语言用同一套高亮
const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: 'var(--fg-muted)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.tagName, t.attributeName, t.propertyName], color: 'var(--syn-tag)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

const theme = EditorView.theme({
  '&': { '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  '.cm-lp-h1': { fontSize: '1.8em', lineHeight: '1.4' },
  '.cm-lp-h2': { fontSize: '1.45em', lineHeight: '1.4' },
  '.cm-lp-h3': { fontSize: '1.2em' },
  '.cm-lp-h4, .cm-lp-h5, .cm-lp-h6': { fontSize: '1.05em' },
  '.cm-lp-code': { backgroundColor: 'var(--code-bg)', borderRadius: '3px', padding: '1px 3px' },
  '.cm-lp-codeblock': { backgroundColor: 'var(--code-bg)', fontFamily: 'var(--font-mono)', padding: '0 12px' },
  '.cm-lp-codeblock-first': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px' },
  '.cm-lp-codeblock-last': { borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' },
  '.cm-lp-fence': { color: 'var(--fg-muted)', fontSize: '0.85em' },
  '.cm-lp-quote': { borderLeft: '3px solid var(--border)', paddingLeft: '12px', color: 'var(--fg-muted)' },
  '.cm-lp-bullet': { color: 'var(--fg-muted)', display: 'inline-block', width: '1ch' },
  '.cm-lp-task': { margin: '0 4px 0 0', verticalAlign: 'middle', cursor: 'pointer', accentColor: 'var(--accent)' },
  '.cm-lp-link': { color: 'var(--accent)', textDecoration: 'underline' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--border)', verticalAlign: 'middle' },
  '.cm-lp-image img': { maxWidth: '100%', verticalAlign: 'bottom' },
  '.cm-lp-image-missing': { color: 'var(--fg-muted)', border: '1px dashed var(--border)', borderRadius: '3px', padding: '0 4px' },
  '.cm-lp-table': { padding: '4px 0', overflowX: 'auto', cursor: 'text' },
  '.cm-lp-table table': { borderCollapse: 'collapse' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid var(--border)', padding: '4px 10px' },
  '.cm-lp-table th': { backgroundColor: 'var(--bg-raised)' },
})

export function livePreview(n: Note | null): Extension {
  return [n ? note.of(n) : [], syntaxHighlighting(highlight), blocks, inline, theme]
}
