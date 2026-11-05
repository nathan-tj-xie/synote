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
  const text = (a: number, b: number) => state.sliceDoc(a, b).trim()
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

// 能装下表格的容器：只往这些节点里走，段落、代码块等叶子块整块跳过，每次重建只付块级结构的代价
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

// 跨行替换（表格）必须由 StateField 提供，ViewPlugin 不能替换换行。块级替换按整行：
// 引用、列表里的表格连同行首的 `> ` / 缩进一起替换（行内插件跳过这些行，不会叠加装饰）
export function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== 'Table') return CONTAINERS.has(n.name)
      if (!touches(state, n.from, n.to))
        out.push(Decoration.replace({ widget: tableWidget(state, n.node), block: true }).range(state.doc.lineAt(n.from).from, n.to))
      return false
    },
  })
  return Decoration.set(out)
}

// 组字状态：由 DOM 的 compositionstart / end 维护。StateField 拿不到 view.composing，靠它在组字期间不重建表格
let ime = false

type TableValue = { decos: DecorationSet; key: string; stale: boolean }
const tables = StateField.define<TableValue>({
  create: (s) => ({ decos: buildTables(s), key: activeKey(s), stale: false }),
  update(v, tr) {
    if (ime || tr.isUserEvent('input.type.compose')) return { ...v, decos: v.decos.map(tr.changes), stale: true }
    const key = activeKey(tr.state)
    if (v.stale || tr.docChanged || key !== v.key || syntaxTree(tr.state) !== syntaxTree(tr.startState) || refreshed([tr]))
      return { decos: buildTables(tr.state), key, stale: false }
    return v
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
})

const MARKS: Record<string, string> = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }

// [from, to]（视口）内的行内装饰。只遍历视口，打开大文件、逐键输入都只付视口的代价
export function buildInline(state: EditorState, from: number, to: number): DecorationSet {
  const out: Range<Decoration>[] = []
  const doc = state.doc
  const info = state.facet(note)
  // 已整块渲染成表格的范围（引用、列表里的表格）：里面的 `> `、缩进等不再加装饰
  const rendered = state.field(tables, false)?.decos
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
          if (h[1] === 'Setext') hide(m.from, m.to)
          else if (m.from === doc.lineAt(n.from).from) hide(m.from, spaceAfter(m.to))
          else hide(doc.sliceString(m.from - 1, m.from) === ' ' ? m.from - 1 : m.from, m.to) // 结尾的 `##`
        }
        return
      }
      switch (name) {
        case 'Table':
          return false // 由 tables 字段整块处理
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
        case 'Link': {
          const marks = n.node.getChildren('LinkMark')
          if (active() || marks.length < 2) return
          // [名字](路径) → 只显示名字。目标跨行（`](\n路径)`）时整个链接显示源码，不能只藏一半
          if (!oneLine(marks[1].from, n.to)) return
          hide(marks[0].from, marks[0].to)
          if (marks[0].to < marks[1].from) out.push(mark('cm-lp-link').range(marks[0].to, marks[1].from))
          hide(marks[1].from, n.to)
          return
        }
        case 'Image': {
          // 跨行的图片整个显示源码（ViewPlugin 不能替换换行）
          if (active() || !oneLine(n.from, n.to)) return false
          const url = n.node.getChild('URL')
          const src = url ? doc.sliceString(url.from, url.to) : ''
          const marks = n.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          const path = info && src ? resolveImage(src, info.path) : null
          replace(n.from, n.to, Decoration.replace({ widget: new ImageWidget(info?.vault ?? null, path, src, alt, imageGen) }))
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
  return [n ? note.of(n) : [], syntaxHighlighting(highlight), tables, inline, theme]
}
