// 实时预览（GLOSSARY）：只用 decoration / widget 改变显示，从不改动正文文本——diff 按偏移同步（diff.ts）、
// 只打开不编辑时源码字节不变，都依赖这一点。唯一会写正文的是任务列表勾选，它走普通的编辑事务和保存路径。
// 光标 / 选区碰到的行显示源码，其余行渲染；按行而不是按元素切换，光标在行内移动时装饰不变，输入法组字更稳
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { tags as t } from '@lezer/highlight'
import { i18next } from '../../shared/i18n'
import type { Presence } from '../../shared/api'
import { parseLfsPointer, sizeLabel, type LfsPointer } from '../../shared/lfs'
import { linkHref, linkRefs as treeRefs, RAW, wikiLinks } from '../../shared/mdLinks'
import { parseWiki } from '../../shared/url'
import { canWrite, embedOf, embedText, renderEmbed, type Embed } from './embed'
import { dataUrl, decodeEntities, imageMime, MAX_IMAGE, resolveImage, resolveLink, unescapeMd } from './diffUtil'
import { resolveHref, type Href } from './links'
import { useUi, useVault } from './store'

// 当前正文属于哪个库的哪篇笔记：图片按笔记目录解析、经现有 readBytes（带库标识校验）读取
type Note = { vault: string; path: string }
const note = Facet.define<Note, Note | null>({ combine: (v) => v[0] ?? null })

// 组字结束、图片缓存失效后要求重建
const refresh = StateEffect.define<null>()

// 选区碰到的行区间，作为「哪些地方显示源码」的指纹：没变就不必为选区变化重建
// 正好选中某个嵌入块（方向键停在它上面）时它要画成选中态，也算进指纹
function activeKey(state: EditorState): string {
  const e = selectedEmbed(state)
  return state.selection.ranges.map((r) => `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number}`).join(',') + (e ? `@${e.from}` : '')
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
// 缓存按库 + 路径，文件有外部改动时失效。工作区里是 LFS 指针（内容没下载，S17）时结果是指针本身
const images = new Map<string, Promise<string | LfsPointer | null>>()
let imageGen = 0
const views = new Set<EditorView>()

function loadImage(vault: string, path: string): Promise<string | LfsPointer | null> {
  const key = `${vault}\0${path}`
  let p = images.get(key)
  if (!p) {
    if (images.size >= 200) images.clear() // shortcut: 满了整个清空而不是 LRU；图片多的笔记来回切换卡顿时再换
    p = window.synote.readBytes(vault, path).then(
      (b) => parseLfsPointer(b) ?? (b.length > MAX_IMAGE ? Promise.reject(new Error('too large')) : dataUrl(b, imageMime(path)!)),
      () => null,
    )
    images.set(key, p)
  }
  return p
}

// 非图片附件链接的目标是否存在（缺失时显示占位）：按库 + 路径缓存，没有的项一次重建里攒成一批，经 presence 查一次，
// 不是每次渲染都查。查到缺失或 LFS 指针（S17）才需要重建（默认按存在渲染）；查询失败按存在处理，免得反复查
const present = new Map<string, Presence>()
const asking = new Map<string, Set<string>>() // 库 → 待查路径
function presenceOf(vault: string, path: string): Presence | undefined {
  const key = `${vault}\0${path}`
  if (present.has(key)) return present.get(key)
  if (!asking.size) queueMicrotask(askPresent)
  asking.set(vault, (asking.get(vault) ?? new Set()).add(path))
  return undefined
}
function askPresent() {
  for (const [vault, set] of asking) {
    const paths = [...set]
    window.synote.presence(vault, paths).then(
      (r) => {
        if (present.size >= 5000) present.clear() // shortcut: 满了整个清空而不是 LRU，附件链接极多时再换
        paths.forEach((p, i) => present.set(`${vault}\0${p}`, r[i]))
        if (r.some((x) => x.state !== 'present')) rebuildViews()
      },
      () => paths.forEach((p) => present.set(`${vault}\0${p}`, { state: 'present' })),
    )
  }
  asking.clear()
}

function rebuildViews() {
  imageGen++
  for (const v of views) v.dispatch({ effects: refresh.of(null) })
}

// 这些文件变了（外部改动、新写入的附件、索引发现的增删）：丢掉缓存，正在显示的视图重建
export function forgetFiles(root: string, changed: string[]) {
  let hit = false
  for (const p of changed) {
    const key = `${root}\0${p}`
    hit = images.delete(key) || hit
    hit = present.delete(key) || hit
  }
  if (hit) rebuildViews()
}

// 单测（node）里没有 window。库的 watcher 跳过 attachments/，附件的增删靠索引服务的变化推送
if (typeof window !== 'undefined') {
  window.synote.onVaultChanged(({ root, changed }) => forgetFiles(root, changed))
  window.synote.onIndexChanged(({ root, paths }) => forgetFiles(root, paths))
  // 笔记增删改变 [[名字]] 指向哪篇：重建（不动图片代次，免得图片重绘闪烁）
  useVault.subscribe((st, prev) => st.vault?.entries !== prev.vault?.entries && views.forEach((v) => v.dispatch({ effects: refresh.of(null) })))
}

// 双链目标不存在（ADR 0001 的相对链接、[[名字]] 都算）：显示为失效链接。附件另有缺失占位，外链不查
function broken(state: EditorState, h: Href): boolean {
  const info = state.facet(note)
  if (!info) return false
  const t = resolveHref(h, info.path)
  if (!t) return 'wiki' in h
  return !t.path.startsWith('attachments/') && presenceOf(info.vault, t.path)?.state === 'missing'
}
const linkClass = (state: EditorState, h: Href) => (broken(state, h) ? 'cm-lp-link cm-lp-broken' : 'cm-lp-link')

// 占位里的按钮：执行期间禁用，失败时报错
function placeholderButton(box: HTMLElement, label: string, run: () => Promise<void>) {
  const btn = box.appendChild(document.createElement('button'))
  btn.className = 'cm-lp-restore'
  btn.textContent = label
  btn.addEventListener('mousedown', (e) => e.preventDefault()) // 不让光标移进来（那样整行会切成源码）
  btn.addEventListener('click', async (e) => {
    e.preventDefault()
    btn.disabled = true
    try {
      await run()
    } catch (err) {
      useUi.getState().setError(String(err))
    } finally {
      btn.disabled = false
    }
  })
}

// 附件缺失占位的内容：提示 + "从历史恢复"（S15，#9 决定 7）。主进程找最后一个还有它的提交，确认后 git restore 写回工作区；
// 写回后丢掉存在性和图片缓存，占位随即消失（索引的变化推送也会再丢一次）
function fillMissing(box: HTMLElement, vault: string, path: string) {
  box.className = 'cm-lp-image-missing'
  box.textContent = i18next.t('attachmentMissing', { path })
  placeholderButton(box, i18next.t('restoreFromHistory'), async () => {
    const src = await window.synote.restoreSource(vault, path)
    if (!src) throw new Error(i18next.t('restoreNotFound', { path }))
    const date = new Date(src.time * 1000).toLocaleString('zh-CN')
    if (!confirm(i18next.t('restoreConfirm', { hash: src.hash.slice(0, 7), date, subject: src.subject, path }))) return
    await window.synote.restoreAttachment(vault, path, src.hash)
    forgetFiles(vault, [path])
  })
}

// 工作区里是 LFS 指针的图片（S17）：和附件缺失区分开的占位，"下载"执行 git lfs pull 写回工作区，之后丢掉缓存换成图片
function fillLfs(box: HTMLElement, vault: string, path: string, size: number) {
  box.className = 'cm-lp-image-missing cm-lp-lfs'
  box.textContent = i18next.t('lfsNotDownloaded', { size: sizeLabel(size), path })
  placeholderButton(box, i18next.t('lfsDownload'), async () => {
    await window.synote.lfsPull(vault, path)
    forgetFiles(vault, [path])
  })
}

// 指向库内附件（attachments/ 下）的普通链接，目标已知不存在时的占位；lfs 不为 null 时是 LFS 内容未下载的占位（S17，大小）
class MissingWidget extends WidgetType {
  constructor(
    readonly vault: string,
    readonly path: string,
    readonly lfs: number | null,
  ) {
    super()
  }
  eq(o: MissingWidget) {
    return o.vault === this.vault && o.path === this.path && o.lfs === this.lfs
  }
  toDOM() {
    const el = document.createElement('span')
    if (this.lfs === null) fillMissing(el, this.vault, this.path)
    else fillLfs(el, this.vault, this.path, this.lfs)
    return el
  }
}

function missingWidget(state: EditorState, target: string): MissingWidget | null {
  const info = state.facet(note)
  const path = info && target ? resolveLink(target, info.path) : null
  if (!path?.startsWith('attachments/')) return null
  const p = presenceOf(info!.vault, path)
  return p?.state === 'missing' ? new MissingWidget(info!.vault, path, null) : p?.state === 'lfs' ? new MissingWidget(info!.vault, path, p.pointer.size) : null
}

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
    const vault = this.vault
    loadImage(vault, path).then(
      (url) => {
        // 附件缺失（#8）：只显示占位，不自动修复也不改引用；attachments/ 下的可以手动从历史恢复
        if (!url) return path.startsWith('attachments/') ? fillMissing(box, vault, path) : fail(i18next.t('attachmentMissing', { path }))
        if (typeof url !== 'string') return fillLfs(box, vault, path, url.size)
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

// HTML 实体（`&amp;`、`&#35;`）显示成它代表的字符；识别和解码与链接目标共用 diffUtil.decodeEntities
class EntityWidget extends WidgetType {
  constructor(readonly entity: string) {
    super()
  }
  eq(o: EntityWidget) {
    return o.entity === this.entity
  }
  toDOM() {
    const el = document.createElement('span')
    el.textContent = decodeEntities(this.entity)
    return el
  }
}

// 跨行链接整段替换成它的文字
class LinkText extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super()
  }
  eq(o: LinkText) {
    return o.text === this.text && o.cls === this.cls
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.cls
    el.textContent = this.text
    return el
  }
}

// 引用定义 `[ref]: 地址`（识别规则在 shared/mdLinks，和索引共用）；跨行标签按 sourceText 去掉续行的引用标记
const source = (state: EditorState) => ({ text: (a: number, b: number) => state.sliceDoc(a, b), label: (a: number, b: number) => sourceText(state, a, b) })
export const linkRefs = (state: EditorState): Map<string, string> => treeRefs(syntaxTree(state), source(state))

// 一行上各层引用标记 `>`（连同其后一个空格）的位置。按语法树确定：取这一行末尾处节点的 Blockquote / ListItem 祖先，
// 由外到内逐层定位——容器从这一行开始时，`>` 就在 Blockquote 的起点、列表标记在 ListMark；续行时跳过缩进再找 `>`。
// 不从行首数 `>`（`- > 引用` 这种列表里的引用，`>` 前面是列表标记），也不依赖 QuoteMark 节点（Setext 下划线等处没有）。
// 懒续行（没写 `>`）在那一层停下
export function quoteMarks(state: EditorState, line: { from: number; to: number }): [number, number][] {
  const doc = state.doc
  const chain: SyntaxNode[] = []
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.to, -1); n; n = n.parent)
    if (n.name === 'Blockquote' || n.name === 'ListItem') chain.unshift(n)
  const ch = (p: number) => doc.sliceString(p, p + 1)
  const skipWs = (p: number) => {
    while (p < line.to && (ch(p) === ' ' || ch(p) === '\t')) p++
    return p
  }
  const out: [number, number][] = []
  let pos = line.from
  for (const c of chain) {
    if (c.name === 'ListItem') {
      const mark = c.from >= line.from ? c.getChild('ListMark') : null
      pos = mark ? mark.to : skipWs(pos) // 列表标记本身由 ListMark 分支处理，续行缩进不动
      continue
    }
    const p = c.from >= line.from ? c.from : skipWs(pos)
    if (ch(p) !== '>') break
    pos = ch(p + 1) === ' ' || ch(p + 1) === '\t' ? p + 2 : p + 1
    out.push([p, pos])
  }
  return out
}

// [from, to] 里属于这段文字的源码：跨行时去掉续行行首的引用标记和缩进，换行折成一个空格；不反转义
function sourceText(state: EditorState, from: number, to: number): string {
  const doc = state.doc
  const parts: string[] = []
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos)
    let start = pos
    if (pos !== from) {
      start = Math.max(start, quoteMarks(state, line).at(-1)?.[1] ?? start)
      while (start < line.to && /\s/.test(doc.sliceString(start, start + 1))) start++
    }
    parts.push(doc.sliceString(start, Math.min(line.to, to)))
    pos = line.to + 1
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// 显示文字：在 sourceText 基础上反转义（`\]` 显示成 `]`）
export const plainText = (state: EditorState, from: number, to: number) => unescapeMd(sourceText(state, from, to))

// 链接 / 图片的文字（[ 与 ] 之间）和地址：内联写法取 URL 子节点；引用写法（`[文][ref]`、`[文][]`、`[文]`）按标签查定义，
// 查不到时地址为 null（那就不是链接，显示源码）。地址都经 destination 解码

function linkParts(state: EditorState, n: SyntaxNode, refs: () => Map<string, string>): { text: string; target: string | null } | null {
  const marks = n.getChildren('LinkMark')
  if (marks.length < 2) return null
  return { text: plainText(state, marks[0].to, marks[1].from), target: linkHref(n, refs, source(state)) }
}

function imageWidget(state: EditorState, text: string, target: string): ImageWidget {
  const info = state.facet(note)
  const path = info && target ? resolveImage(target, info.path) : null
  return new ImageWidget(info?.vault ?? null, path, target, text, imageGen)
}

// 引用、列表里的块（表格、嵌入块）整行替换：`> ` 由块自己画左边线，缩进和本行开始的列表标记（`•`、`7.`）也由它画
type Box = { quoted: boolean; indent: number; markers: string[] }
function boxOf(state: EditorState, n: SyntaxNode): Box {
  let quoted = false
  const start = state.doc.lineAt(n.from).from
  const marks: SyntaxNode[] = []
  for (let p = n.parent; p; p = p.parent) {
    quoted ||= p.name === 'Blockquote'
    const mark = p.name === 'ListItem' && p.from >= start ? p.getChild('ListMark') : null
    if (mark) marks.unshift(mark)
  }
  const markers = marks.map((m) => (m.parent?.parent?.name === 'BulletList' ? '•' : state.sliceDoc(m.from, m.to)))
  return { quoted, indent: quoted ? 0 : (marks[0]?.from ?? n.from) - start, markers }
}

function boxed(box: Box, cls: string, inner?: HTMLElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = box.quoted ? `${cls} cm-lp-quote` : cls
  wrap.style.marginLeft = `${box.indent}ch`
  if (box.markers.length) wrap.style.display = 'flex'
  for (const m of box.markers) {
    const el = wrap.appendChild(document.createElement('span'))
    el.className = m === '•' ? 'cm-lp-bullet cm-lp-table-mark' : 'cm-lp-table-mark'
    el.textContent = m
  }
  if (inner) wrap.appendChild(inner)
  return wrap
}

// 嵌入块（GLOSSARY）：不论光标在哪都显示渲染结果，点击或选中后按 Enter 打开编辑（EmbedEditor.tsx）
class EmbedWidget extends WidgetType {
  constructor(
    readonly e: Embed,
    readonly selected: boolean,
    readonly box: Box | null, // 块级的：所在的引用 / 列表
  ) {
    super()
  }
  eq(o: EmbedWidget) {
    return o.e.kind === this.e.kind && o.e.text === this.e.text && o.selected === this.selected // text 含行首前缀，相同即容器相同
  }
  get estimatedHeight() {
    return !this.e.block ? -1 : this.e.kind === 'mermaid' ? 200 : 60
  }
  toDOM(view: EditorView) {
    const { kind, src, display, text, block } = this.e
    const el: HTMLElement = document.createElement(block ? 'div' : 'span')
    el.className = `cm-embed cm-embed-${kind}${this.selected ? ' cm-embed-selected' : ''}`
    renderEmbed(el, kind, src, display, text, i18next.t(kind === 'mermaid' ? 'mermaidEmpty' : 'mathEmpty'), () => view.requestMeasure())
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault() // 不让光标移进来
      const e = ev.button === 0 && embedAround(view.state, view.posAtDOM(el), 1)
      if (e) openEmbed(view, e)
    })
    const box = this.box
    if (!box || (!box.quoted && !box.indent && !box.markers.length)) return el
    el.style.flex = '1'
    return boxed(box, 'cm-embed-box', el)
  }
  ignoreEvent() {
    return true
  }
}

// pos 一侧紧挨着的嵌入块（side 1：从 pos 开始的，-1：到 pos 结束的），按语法树现算，不依赖装饰。
// 块级的从行首到行尾：引用 / 列表里节点不从行首开始，再从这一行行尾往上找
export function embedAround(state: EditorState, pos: number, side: 1 | -1): Embed | null {
  const up = (p: number, s: 1 | -1) => {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(p, s); n; n = n.parent) {
      const e = embedOf(state, n)
      if (e) return e
    }
    return null
  }
  const line = state.doc.lineAt(pos)
  let e = up(pos, side)
  if (!e && line.length && pos === (side > 0 ? line.from : line.to)) e = up(line.to, -1)
  return e && (side > 0 ? e.from : e.to) === pos ? e : null
}

// 选区正好是一个嵌入块
export function selectedEmbed(state: EditorState): Embed | null {
  const r = state.selection.main
  if (r.empty) return null
  const e = embedAround(state, r.from, 1)
  return e?.to === r.to ? e : null
}

// 打开编辑：$$ 公式和 Mermaid 在弹窗里，`$x$` 在公式旁的浮层里。请求里带着视图和发起时的笔记，写回时核对（writeEmbed）
let embedSeq = 0
export function openEmbed(view: EditorView, e: Embed) {
  if (view.state.readOnly) return
  view.dispatch({ selection: { anchor: e.from, head: e.to } })
  // 浮层贴着公式：选中后公式画成选中态，按它的框定位；还没写进正文的按光标位置
  const r = view.contentDOM.querySelector('.cm-embed-selected')?.getBoundingClientRect() ?? view.coordsAtPos(e.from)
  const at = e.kind === 'inline' && r ? { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top } : null
  useUi.getState().setEmbed({ id: ++embedSeq, view, note: view.state.facet(note), embed: e, at })
}

// 视图里还是发起编辑时那篇笔记（共用一个 EditorView，切笔记会换掉整个 state）
export const sameNote = (view: EditorView, owner: Note | null) => view.state.facet(note) === owner

// 把嵌入块的源码改成 src，返回改后的嵌入块。视图已换成别的笔记、正文里那段已经变了（外部重载等）或只读时不写，返回 null
export function writeEmbed(view: EditorView, owner: Note | null, e: Embed, src: string): Embed | null {
  const s = view.state
  if (s.readOnly || !canWrite(e, src) || !sameNote(view, owner) || s.sliceDoc(e.from, e.to) !== e.text) return null
  const text = embedText(e, src)
  view.dispatch({ changes: { from: e.from, to: e.to, insert: text }, userEvent: 'input' })
  return { ...e, src, text, to: e.from + text.length }
}

// 新建：块级公式在光标所在行之后插入（空行就地），行内公式在光标处；先不写正文，保存（行内：输入）时才写
export function insertMath(view: EditorView, display: boolean) {
  const { head } = view.state.selection.main
  const line = view.state.doc.lineAt(head)
  const at = display ? line.to : head
  const open = display ? (line.text.trim() ? '\n\n$$' : '$$') : '$'
  const close = display ? '$$' : '$'
  openEmbed(view, { kind: display ? 'math' : 'inline', block: display, from: at, to: at, text: '', src: '', open, close, prefix: '', sep: display ? '\n' : '', display })
}

// 空行输入 `$$` 或 ```mermaid 后按 Enter：补上结尾并打开编辑窗口。行不在代码块等里面（属于顶层段落或从这行开始的围栏）
function createOnEnter(view: EditorView): boolean {
  const { state } = view
  const r = state.selection.main
  const line = state.doc.lineAt(r.head)
  const text = line.text.trim()
  if (!r.empty || r.head !== line.to || (text !== '$$' && text !== '```mermaid') || line.text !== text) return false
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1)
  while (n && n.parent && n.parent.name !== 'Document') n = n.parent
  // 已有公式的结尾 `$$` 属于 BlockMath，不会进来
  if (!n || !(n.name === 'Paragraph' || (n.name === 'FencedCode' && n.from === line.from))) return false
  view.dispatch({ changes: { from: line.to, insert: text === '$$' ? '\n$$' : '\n```' }, userEvent: 'input' })
  const e = embedAround(view.state, line.from, 1)
  if (e) openEmbed(view, e)
  return true
}

// 光标移到块级嵌入块旁边能接着输入的位置：下一行行首 / 上一行行尾，不贴在 `$$`、围栏上（贴着输入会破坏闭合）。
// 块在文末 / 文首、没有相邻行时补一个换行
export function besideBlock(view: EditorView, e: Embed, fwd: boolean) {
  const len = view.state.doc.length
  const edge = fwd ? e.to >= len : e.from <= 0
  if (edge && !view.state.readOnly) {
    const at = fwd ? len : 0
    view.dispatch({ changes: { from: at, insert: '\n' }, selection: { anchor: fwd ? len + 1 : 0 }, scrollIntoView: true, userEvent: 'input' })
  } else view.dispatch({ selection: { anchor: edge ? (fwd ? len : 0) : fwd ? e.to + 1 : e.from - 1 }, scrollIntoView: true })
}

// 方向键把嵌入块当成一个整体：先停在它上面（选中），再按一次越过；停在上面时 Enter 打开编辑
function arrow(dir: 'left' | 'right' | 'up' | 'down') {
  return (view: EditorView): boolean => {
    const { state } = view
    const fwd = dir === 'right' || dir === 'down'
    const sel = selectedEmbed(state)
    const set = (anchor: number, head = anchor) => (view.dispatch({ selection: { anchor, head }, scrollIntoView: true }), true)
    if (sel) {
      if (!sel.block) return dir === 'left' || dir === 'right' ? set(fwd ? sel.to : sel.from) : false
      besideBlock(view, sel, fwd)
      return true
    }
    const r = state.selection.main
    if (!r.empty) return false
    const line = state.doc.lineAt(r.head)
    let e: Embed | null = null
    if (dir === 'left' || dir === 'right') {
      e = embedAround(state, r.head, fwd ? 1 : -1)
      // 行首 / 行尾：下一个 / 上一个字符是换行，紧挨着的块级嵌入块在相邻行
      if (!e && fwd && r.head === line.to && line.to < state.doc.length) e = embedAround(state, line.to + 1, 1)
      if (!e && !fwd && r.head === line.from && line.from > 0) e = embedAround(state, line.from - 1, -1)
    } else {
      // 光标就在块级嵌入块的边界上，或它在相邻行
      e = embedAround(state, r.head, fwd ? 1 : -1)
      if (!e && (fwd ? line.to < state.doc.length : line.from > 0)) e = fwd ? embedAround(state, line.to + 1, 1) : embedAround(state, line.from - 1, -1)
      if (e && !e.block) e = null // 行内公式交给默认的上下移动（原子范围保证不进到里面）
    }
    return e ? set(e.from, e.to) : false
  }
}

const embedKeys = Prec.high(
  keymap.of([
    { key: 'ArrowLeft', run: arrow('left') },
    { key: 'ArrowRight', run: arrow('right') },
    { key: 'ArrowUp', run: arrow('up') },
    { key: 'ArrowDown', run: arrow('down') },
    {
      key: 'Enter',
      run: (view) => {
        const e = selectedEmbed(view.state)
        if (e) openEmbed(view, e)
        return !!e || createOnEnter(view)
      },
    },
  ]),
)

const embedOnly = (set: DecorationSet) => set.update({ filter: (_a, _b, d) => d.spec.widget instanceof EmbedWidget })

// 表格：整块替换成只读的 HTML 表格；点一下把光标放进表格，切回源码编辑
class TableWidget extends WidgetType {
  private cells: { rows: string[][]; align: (string | null)[] } | null = null
  constructor(
    readonly source: string,
    private readonly parse: () => { rows: string[][]; align: (string | null)[] }, // 单元格用到时才切分：按源码判等，没变的表格不再算
    readonly box: Box,
  ) {
    super()
  }
  eq(o: TableWidget) {
    return o.source === this.source
  }
  get rows() {
    return (this.cells ??= this.parse()).rows
  }
  get align() {
    return (this.cells ??= this.parse()).align
  }
  get estimatedHeight() {
    return this.rows.length * 30 + 8
  }
  toDOM(view: EditorView) {
    const wrap = boxed(this.box, 'cm-lp-table')
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

// 一行表格的各个单元格：按行内的 `|`（TableDelimiter 节点，转义的 `\|` 不算）切分。空单元格没有 TableCell 节点，
// 只收集 TableCell 会丢掉它们、让后面的内容错列。行首、行尾的 `|` 可省略
export function tableCells(state: EditorState, row: SyntaxNode): string[] {
  const pipes = row.getChildren('TableDelimiter')
  const segs: [number, number][] = []
  let start = row.from
  for (const p of pipes) {
    segs.push([start, p.from])
    start = p.to
  }
  segs.push([start, row.to])
  // 首个 `|` 之前、末个 `|` 之后只有空白（行的节点范围可能带首尾空格 / Tab）：那是可省略的边界，不是单元格
  const blank = ([a, b]: [number, number]) => /^[ \t]*$/.test(state.sliceDoc(a, b))
  if (pipes.length && blank(segs[0])) segs.shift()
  if (pipes.length && segs.length && blank(segs.at(-1)!)) segs.pop()
  return segs.map(([a, b]) => unescapeMd(state.sliceDoc(a, b).trim()))
}

function tableCellsOf(state: EditorState, n: SyntaxNode): { rows: string[][]; align: (string | null)[] } {
  const text = (a: number, b: number) => unescapeMd(state.sliceDoc(a, b).trim())
  const rows: string[][] = []
  let align: (string | null)[] = []
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader' || c.name === 'TableRow') rows.push(tableCells(state, c))
    else if (c.name === 'TableDelimiter' && c.from !== c.to && /-/.test(state.sliceDoc(c.from, c.to)))
      align = text(c.from, c.to)
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((s) => {
          s = s.trim()
          return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null
        })
  }
  // 每行按表头列数补齐 / 截断（GFM：多出的单元格忽略，缺的补空）
  const cols = rows[0]?.length ?? 0
  for (const r of rows) r.splice(cols, Infinity, ...Array<string>(Math.max(0, cols - r.length)).fill(''))
  align = align.slice(0, cols)
  return { rows, align }
}

// 在这一行开始的列表项（`- | a |`、`7. | a |`、`- 1. | a |`）：标记在表格替换的整行范围里，交给 widget 画
function tableWidget(state: EditorState, n: SyntaxNode): TableWidget {
  const start = state.doc.lineAt(n.from).from
  return new TableWidget(state.sliceDoc(start, n.to), () => tableCellsOf(state, n), boxOf(state, n))
}

const CONTAINER = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

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
      // ```mermaid / ```math 和块级公式（含引用、列表里的）：整行换成嵌入块，不论光标在哪
      const e = (name === 'FencedCode' || name === 'BlockMath') && embedOf(state, n.node)
      if (e) {
        out.push(Decoration.replace({ widget: new EmbedWidget(e, selectedEmbed(state)?.from === e.from, boxOf(state, n.node)), block: true }).range(e.from, e.to))
        return false
      }
      // 不按节点类型列白名单：除代码等原样节点外，凡是跨行的节点都往里走（任务项、Setext 标题、以后的新容器都覆盖到）；
      // 单行节点里不可能有跨行的链接 / 图片，整个跳过，所以每次重建只付跨行结构的代价。单行的容器（`> $$x$$`）里可能有块级公式
      if (RAW.has(name) || (!multiLine(n.from, n.to) && !CONTAINER.has(name))) return false
      if (name === 'Table') {
        if (!touches(state, n.from, n.to)) out.push(Decoration.replace({ widget: tableWidget(state, n.node), block: true }).range(doc.lineAt(n.from).from, n.to))
        return false
      }
      if (name === 'Link' || name === 'Image') {
        const parts = touches(state, n.from, n.to) ? null : linkParts(state, n.node, () => refs)
        if (parts && parts.target !== null) {
          const widget = name === 'Image' ? imageWidget(state, parts.text, parts.target) : (missingWidget(state, parts.target) ?? new LinkText(parts.text, linkClass(state, { href: parts.target })))
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

type BlockValue = { decos: DecorationSet; atomic: DecorationSet; refs: Map<string, string>; key: string; stale: boolean }
function blockValue(state: EditorState): BlockValue {
  const refs = linkRefs(state)
  const decos = buildBlocks(state, refs)
  return { decos, atomic: embedOnly(decos), refs, key: activeKey(state), stale: false }
}
const blocks = StateField.define<BlockValue>({
  create: blockValue,
  update(v, tr) {
    if (ime || tr.isUserEvent('input.type.compose')) return { ...v, decos: v.decos.map(tr.changes), atomic: v.atomic.map(tr.changes), stale: true }
    if (v.stale || tr.docChanged || activeKey(tr.state) !== v.key || syntaxTree(tr.state) !== syntaxTree(tr.startState) || refreshed([tr]))
      return blockValue(tr.state)
    return v
  },
  // 嵌入块是原子的：光标、删除都不会落到源码中间
  provide: (f) => [EditorView.decorations.from(f, (v) => v.decos), EditorView.atomicRanges.of((view) => view.state.field(f).atomic)],
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

  // 容器的行首标记逐行统一处理，不依赖遍历进入哪个子节点（引用里的代码块、Setext 标题、表格等都一样）：
  // 这一行所属的块（引用的直接子块，如整个代码块）碰到光标时显示源码，否则藏掉各层 `> `；已被 blocks 整段替换的跳过
  for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) {
    const l = doc.line(i)
    const marks = quoteMarks(state, l)
    if (!marks.length) continue
    // 所属的块：这一行末尾处节点往上，直到父节点是 Blockquote 的那一层
    let block: SyntaxNode | null = syntaxTree(state).resolveInner(l.to, -1)
    while (block?.parent && block.parent.name !== 'Blockquote') block = block.parent
    const [a, b] = block?.parent ? [Math.min(block.from, l.from), Math.max(block.to, l.to)] : [l.from, l.to]
    if (touches(state, a, b)) continue
    for (const [x, y] of marks) if (!inTable(x, y)) hide(x, y)
  }

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
          else if (m.from === n.from) hide(m.from, spaceAfter(m.to)) // 开头的 `#`（引用里时在 `> ` 之后）
          else hide(doc.sliceString(m.from - 1, m.from) === ' ' ? m.from - 1 : m.from, m.to) // 结尾的 `##`
        }
        return
      }
      switch (name) {
        case 'Table':
          return false // 由 blocks 字段整块处理
        case 'InlineMath': {
          // 行内公式是嵌入块：光标所在行也显示渲染结果
          const e = embedOf(state, n.node)!
          const sel = state.selection.main
          replace(n.from, n.to, Decoration.replace({ widget: new EmbedWidget(e, sel.from === e.from && sel.to === e.to, null) }))
          return false
        }
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
          const missing = missingWidget(state, parts.target)
          if (missing) {
            replace(n.from, n.to, Decoration.replace({ widget: missing }))
            return
          }
          // [名字](路径)、[名字][ref] → 只显示名字
          const marks = n.node.getChildren('LinkMark')
          hide(marks[0].from, marks[0].to)
          if (marks[0].to < marks[1].from) out.push(mark(linkClass(state, { href: parts.target })).range(marks[0].to, marks[1].from))
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

  // [[目标|别名]]：lezer 不认这种语法，按行扫（跳过代码等原样节点）；只显示别名或目标，⌘ 点击跳转同标准链接
  for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) {
    const l = doc.line(i)
    if (!l.text.includes('[[') || touches(state, l.from, l.to)) continue
    for (const { from: a, to: b, inner } of wikiLinks(syntaxTree(state), l.text, l.from)) {
      if (!parseWiki(inner) || inTable(a, b)) continue
      const bar = inner.indexOf('|')
      const textFrom = bar >= 0 && inner.slice(bar + 1).trim() ? a + 2 + bar + 1 : a + 2 // 别名为空时显示原文
      hide(a, textFrom)
      out.push(mark(linkClass(state, { wiki: inner })).range(textFrom, b - 2))
      hide(b - 2, b)
    }
  }
  return Decoration.set(out, true)
}

// pos 处的双链（⌘ 点击跳转用）：标准链接（含引用式）按语法树找，[[...]] 按行扫；不是链接时为 null
export function linkAt(state: EditorState, pos: number): Href | null {
  for (const side of [1, -1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name !== 'Link') continue
      const parts = linkParts(state, n, () => linkRefs(state))
      if (parts?.target) return { href: parts.target }
      break // 没有定义的 `[文]`：可能是 [[...]] 的里层，下面按行再找
    }
  const l = state.doc.lineAt(pos)
  const w = wikiLinks(syntaxTree(state), l.text, l.from).find((w) => pos >= w.from && pos <= w.to)
  return w ? { wiki: w.inner } : null
}

const inline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    key: string
    stale = false
    constructor(readonly view: EditorView) {
      views.add(view)
      this.decorations = buildInline(view.state, view.viewport.from, view.viewport.to)
      this.atomic = embedOnly(this.decorations)
      this.key = activeKey(view.state)
    }
    update(u: ViewUpdate) {
      if (composing(u)) {
        if (u.docChanged) [this.decorations, this.atomic] = [this.decorations.map(u.changes), this.atomic.map(u.changes)]
        this.stale = true
        return
      }
      const key = activeKey(u.state)
      if (this.stale || u.docChanged || u.viewportChanged || key !== this.key || syntaxTree(u.state) !== syntaxTree(u.startState) || refreshed(u.transactions)) {
        this.decorations = buildInline(u.state, u.view.viewport.from, u.view.viewport.to)
        this.atomic = embedOnly(this.decorations)
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
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
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
  '.cm-lp-broken': { color: 'var(--fg-muted)', textDecorationStyle: 'dashed' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--border)', verticalAlign: 'middle' },
  '.cm-lp-image img': { maxWidth: '100%', verticalAlign: 'bottom' },
  '.cm-lp-image-missing': { color: 'var(--fg-muted)', border: '1px dashed var(--border)', borderRadius: '3px', padding: '0 4px' },
  '.cm-lp-restore': { marginLeft: '6px', background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' },
  '.cm-lp-table': { padding: '4px 0', overflowX: 'auto', cursor: 'text' },
  '.cm-lp-table table': { borderCollapse: 'collapse' },
  '.cm-lp-table-mark': { flex: 'none', marginRight: '1ch', lineHeight: '2.2' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid var(--border)', padding: '4px 10px' },
  '.cm-lp-table th': { backgroundColor: 'var(--bg-raised)' },
  '.cm-embed': { cursor: 'pointer', borderRadius: '4px', outline: '1px solid transparent' },
  '.cm-embed:hover': { backgroundColor: 'var(--bg-hover)' },
  '.cm-embed-selected': { outlineColor: 'var(--accent)' },
  '.cm-embed-mermaid, .cm-embed-math': { display: 'block', padding: '8px 2px 8px 6px', textAlign: 'center', overflowX: 'auto' }, // 左右同 .cm-line
  '.cm-embed-mermaid > svg': { maxWidth: '100%', height: 'auto' },
  '.cm-embed-math .katex-display': { margin: '0' },
  '.cm-embed-inline': { padding: '0 1px' },
  '.cm-embed-error': { color: 'var(--danger)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', textAlign: 'left' },
  '.cm-embed-empty': { color: 'var(--fg-muted)', fontStyle: 'italic' },
})

export function livePreview(n: Note | null): Extension {
  return [n ? note.of(n) : [], syntaxHighlighting(highlight), blocks, inline, embedKeys, theme]
}
