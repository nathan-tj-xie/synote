// CM6 薄封装：一个 EditorView，按标签页缓存 EditorState，不放进 React state（ADR 0005）
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type ChangeSpec, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import { minimalSetup } from 'codemirror'
import { i18next } from '../../shared/i18n'
import { anchorLine, relativeLink } from '../../shared/url'
import { imageMime } from './diffUtil'
import { tableTrailingSpace } from './gfmTable'
import { noteCompletion, resolveHref, type Href } from './links'
import { forgetFiles, linkAt, livePreview } from './livePreview'
import { isMac } from './match'
import { useEditor, useUi, useVault } from './store'

// 缓存不变式：视图里那份（shown）永远是该文件最新的正文，states 只缓存不在视图里的已打开文件。
// setView 是唯一换视图的入口：换之前把 shown 写回 states，放进视图的那份同时移出 states
const states = new Map<string, EditorState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// 每个文件的写盘串成一条链：后发的保存必须在先发的之后落盘，否则旧内容会覆盖新内容
const writes = new Map<string, Promise<unknown>>()
let vault: string | null = null // 当前笔记库（VaultInfo.root），读写都带上它，主进程据此拒绝跨库读写
let view: EditorView | null = null
let current: string | null = null // 要显示的文件
let shown: string | null = null // 视图里实际是哪个文件；读文件期间仍是上一个
// 每次显示、关闭当前文件、换库都加一；读文件回来时代次变了，说明这次显示已作废，结果丢弃
let seq = 0
// 库代次：换库时加一。保存回执只在发起保存的库代次仍是当前时才清 dirty，不按路径误清新库的同名文件
let vaultGen = 0
// 切库交接期间（最终冲刷到 commit 返回）编辑器只读：这段时间的输入没有库可写
const lock = new Compartment()
let locked = false
// editable 管输入和焦点，readOnly 挡住命令（复制行等）对正文的修改
const lockExt = () => [EditorView.editable.of(!locked), EditorState.readOnly.of(locked)]
const editable = () => lock.of(lockExt())
// 搜索结果点击后要定位的位置，文件加载完再应用
let target: { path: string; line: number; col: number; len: number } | null = null

// 工作区对比（S14）：diff.ts（含 Monaco）第一次进入时才加载。CM6 视图在 diff 期间只是隐藏，仍是 shown 的唯一正文：
// Monaco 里的输入同步写回视图（带 fromDiff），视图的其它改动推给 Monaco，所以缓存不变式、保存路径都不变
let diff: typeof import('./diff') | null = null
const diffMode = new Set<string>() // 处于 diff 形态的已打开文件（按标签页记住）
let diffWant: string | null = null // 应该显示 diff 的文件（加载中或已显示）
let diffShown: string | null = null // Monaco 里实际是哪个文件
let diffSeq = 0
const fromDiff = Annotation.define<boolean>()
let cmBox: HTMLElement | null = null
let diffBox: HTMLElement | null = null

const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)' },
    '.cm-content': { fontFamily: 'inherit', padding: '24px 0', caretColor: 'var(--fg)', maxWidth: '760px', margin: '0 auto' },
    '.cm-scroller': { lineHeight: '1.7', fontFamily: 'inherit' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--bg-selected)' },
    '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  },
  { dark: true },
)

// 换行符：CM6 内部一律是 \n（diff.ts 与 Monaco 的偏移同步也按 \n 算），写盘时换回读进来时的换行符。
// 混合换行的文件按占多数的那种统一写回
const detectEol = (text: string) => ((text.split('\r\n').length - 1) * 2 > text.split('\n').length - 1 ? '\r\n' : '\n')
const setEol = StateEffect.define<string>()
const eol = StateField.define<string>({
  create: () => '\n',
  update: (v, tr) => tr.effects.reduce((v, e) => (e.is(setEol) ? e.value : v), v),
})

// 等附件写完再插链接的位置（S10）：发起时记下（粘贴为当时的选区，拖入为落点），随之后的编辑映射，
// 不用完成时的新选区；原选区被删光就退化成插入点。每次粘贴 / 拖入按 id 各自映射
type Span = { from: number; to: number }
const addPending = StateEffect.define<{ id: number } & Span>()
const dropPending = StateEffect.define<number>()
const pending = StateField.define<Map<number, Span>>({
  create: () => new Map(),
  update(m, tr) {
    if (tr.docChanged && m.size)
      m = new Map(
        [...m].map(([id, r]) => {
          const from = tr.changes.mapPos(r.from, 1)
          return [id, { from, to: Math.max(from, tr.changes.mapPos(r.to, -1)) }]
        }),
      )
    for (const e of tr.effects) {
      if (e.is(addPending)) m = new Map(m).set(e.value.id, { from: e.value.from, to: e.value.to })
      if (e.is(dropPending)) (m = new Map(m)).delete(e.value)
    }
    return m
  },
})
let pendingSeq = 0

function makeState(doc: string, path: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      eol.init(() => detectEol(doc)),
      pending,
      keymap.of(vscodeKeymap), // 键位贴近 Monaco（ADR 0003），放在前面优先于 minimalSetup 的默认键位
      minimalSetup,
      editable(),
      EditorState.allowMultipleSelections.of(true), // ⌘D、⌥ 点击等多光标键位需要
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [tableTrailingSpace] }), // GFM（表格、任务列表、删除线）；代码块按语言懒加载高亮
      livePreview(vault ? { vault, path } : null),
      noteCompletion(path),
      EditorView.lineWrapping,
      theme,
      // 文件优先于 CM6 自带的处理（它会把拖入的文件当文本读进来）；粘贴同时带文本时（如表格软件）照常粘文本
      EditorView.domEventHandlers({
        paste: (e) => !e.clipboardData?.types.includes('text/plain') && attach(e, e.clipboardData?.files, true),
        drop: (e, v) => attach(e, e.dataTransfer?.files, false, v.posAtCoords({ x: e.clientX, y: e.clientY })),
        // ⌘ 点击（其他平台 Ctrl）双链跳转；不在链接上时照常交给 CM6（加光标）
        mousedown: (e, v) => {
          if (e.button !== 0 || !(isMac ? e.metaKey : e.ctrlKey)) return false
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
          const h = pos === null ? null : linkAt(v.state, pos)
          if (!h) return false
          e.preventDefault()
          followLink(h, path).catch((err) => useUi.getState().setError(String(err)))
          return true
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || !shown) return
        if (!u.transactions.some((t) => t.annotation(Transaction.remote))) scheduleSave(shown)
        if (diffShown === shown && !u.transactions.some((t) => t.annotation(fromDiff))) diff!.replace(u.state.doc.toString())
      }),
    ],
  })
}

// 按磁盘上的样子（原换行符）取正文
function docOf(path: string): string | undefined {
  const s = path === shown ? view?.state : states.get(path)
  if (!s) return undefined
  const text = s.doc.toString()
  return s.field(eol, false) === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

function scheduleSave(path: string) {
  useEditor.getState().setDirty(path, true)
  clearTimeout(timers.get(path))
  timers.set(path, setTimeout(() => flush(path), 500))
}

async function flush(path: string) {
  clearTimeout(timers.get(path))
  timers.delete(path)
  const text = docOf(path)
  if (text === undefined || !vault) return
  const v = vault // 按发起时所在的库写；之后换了库，主进程会拒绝并报错
  const g = vaultGen
  const write = (writes.get(path) ?? Promise.resolve()).then(() => window.synote.writeFile(v, path, text))
  writes.set(path, write.catch(() => {}))
  try {
    await write
    if (g !== vaultGen) return // 已换库：回执不属于当前库
    const now = docOf(path)
    if (now === undefined || now === text) useEditor.getState().setDirty(path, false) // undefined：标签页已关
  } catch (e) {
    useUi.getState().setError(String(e))
  }
}

// 粘贴 / 拖入文件（S10）：经主进程写进 attachments/，写完把相对链接插进发起时那篇笔记的光标处，走普通编辑事务和保存路径。
// 交接锁期间拒绝（吞掉事件，什么都不写）；写盘期间换了库或进入交接就不插链接，已写的附件成为孤儿，由孤儿清理处理
// 进行中的粘贴 / 拖入：清理孤儿附件前等它们插完链接（之后的自动保存由 flushAll 冲刷）
const attaching = new Set<Promise<void>>()
export const attachmentsSettled = () => Promise.all(attaching)

function attach(e: Event, files: FileList | undefined, paste: boolean, at?: number | null): boolean {
  if (!files?.length) return false
  e.preventDefault()
  if (locked || !vault || !shown || !view) return true
  const id = ++pendingSeq
  const sel = view.state.selection.main
  view.dispatch({ effects: addPending.of(at != null ? { id, from: at, to: at } : { id, from: sel.from, to: sel.to }) }) // 拖入：链接落在松手处
  const v = vault
  const g = vaultGen
  const note = shown
  const job = (async () => {
    const links: string[] = []
    try {
      for (const f of [...files]) {
        // Chromium 里截图等剪贴板位图的文件名固定是 image.png，按剪贴板图片命名
        const r = await window.synote.saveAttachment(v, paste && f.name === 'image.png' ? null : f.name, new Uint8Array(await f.arrayBuffer()))
        if (r.warn) useUi.getState().setError(i18next.t(r.warn === 'huge' ? 'attachmentHuge' : 'attachmentLarge', { path: r.path }))
        forgetFiles(v, [r.path]) // 之前按缺失缓存过的同名附件
        const alt = r.path.split('/').pop()!.replace(/\.[^.]*$/, '').replace(/[\\[\]]/g, '\\$&')
        links.push(`${imageMime(r.path) ? '!' : ''}[${alt}](${relativeLink(note, r.path)})`)
      }
    } catch (err) {
      useUi.getState().setError(String(err))
    }
    if (g !== vaultGen) return
    const s = note === shown ? view?.state : states.get(note)
    const r = s?.field(pending, false)?.get(id)
    if (!s || !r) return // 标签页已关，或外部改动重新加载过（位置已作废）
    const spec: TransactionSpec = { effects: dropPending.of(id) }
    if (links.length && !locked) {
      const insert = links.join('\n')
      const cur = s.selection.main
      spec.changes = { from: r.from, to: r.to, insert }
      // 光标还停在发起时那段上才把它放到链接后面，否则只随改动映射
      if (cur.from === r.from && cur.to === r.to) spec.selection = { anchor: r.from + insert.length }
      spec.userEvent = 'input.paste'
    }
    if (note === shown) view!.dispatch(spec)
    else {
      states.set(note, s.update(spec).state)
      if (spec.changes) scheduleSave(note)
    }
  })()
  attaching.add(job)
  job.finally(() => attaching.delete(job))
  return true
}

// 切库前调用：防抖中的输入立即写，再等所有在途写入落盘；还有没写进去的改动（写失败）就返回 false
export async function flushAll(): Promise<boolean> {
  await Promise.all([...timers.keys()].map(flush))
  await Promise.all(writes.values())
  return Object.keys(useEditor.getState().dirty).length === 0
}

// 唯一换视图的入口，维护缓存不变式
function setView(path: string | null, s: EditorState) {
  if (shown) states.set(shown, view!.state)
  if (path) states.delete(path)
  view!.setState(s)
  view!.dispatch({ effects: lock.reconfigure(lockExt()) }) // 缓存里的状态可能建于加锁或解锁之前：总按当前 locked 重配
  shown = path
  syncDiff()
}

// 没有文件可显示时的占位：只读，不能输入（输入无处保存）
const blank = () => EditorState.create({ extensions: [EditorView.editable.of(false), theme] })

export function mount(parent: HTMLElement) {
  cmBox = parent.appendChild(document.createElement('div'))
  diffBox = parent.appendChild(document.createElement('div'))
  cmBox.style.height = diffBox.style.height = '100%'
  diffBox.hidden = true
  view = new EditorView({ state: blank(), parent: cmBox })
  return () => {
    view?.destroy()
    view = null
    current = shown = null
    seq++
    diffSeq++
    diff?.hide()
    diffShown = diffWant = null
    cmBox?.remove()
    diffBox?.remove()
  }
}

const decode = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : '')

// 让 Monaco 跟上「shown 是否处于 diff 形态」。setView 之后、切换形态时调用；加载期间 CM6 照常可用，
// 加载完才取视图里的最新正文放进 Monaco。读 HEAD 失败（没有 git、不是仓库）就退回正文并报错
function syncDiff() {
  const want = shown && diffMode.has(shown) ? shown : null
  if (want === diffWant) return
  diffWant = want
  const my = ++diffSeq
  if (diffShown) {
    diff!.hide()
    diffShown = null
    cmBox!.hidden = false
    diffBox!.hidden = true
    view!.requestMeasure()
  }
  if (!want) return
  const v = vault!
  ;(async () => {
    const [mod, head] = await Promise.all([diff ?? import('./diff'), window.synote.readHead(v, want)])
    diff = mod
    if (my !== diffSeq || !view) return // 期间又切了文件 / 形态，或换了库
    if (!diffBox!.childElementCount) mod.create(diffBox!, applyFromDiff, () => view!.state.doc.toString())
    diffBox!.hidden = false
    cmBox!.hidden = true
    mod.show(v, want, decode(head), view.state.doc.toString(), locked)
    diffShown = want
    mod.focus()
  })().catch((e) => {
    if (my !== diffSeq) return
    diffMode.delete(want)
    diffWant = null
    useUi.getState().setError(String(e))
  })
}

function applyFromDiff(changes: ChangeSpec[]) {
  if (view && diffShown === shown) view.dispatch({ changes, annotations: fromDiff.of(true) })
}

// ⌘⇧D：当前笔记在正文和 HEAD ↔ 工作区对比之间原地切换
export function toggleDiff() {
  if (!shown || locked) return
  const on = !diffMode.has(shown)
  if (on) diffMode.add(shown)
  else diffMode.delete(shown)
  syncDiff()
  if (!on) view!.focus()
}

// HEAD 变了（提交、切分支等）：刷新 diff 左侧
window.synote.onGitChanged((e) => {
  const p = diffShown
  if (!p || !vault || e.root !== vault) return
  const my = diffSeq
  window.synote.readHead(vault, p).then(
    (b) => my === diffSeq && diff!.setHead(decode(b)),
    () => {},
  )
})

export async function show(path: string | null) {
  if (!view || path === current) return
  const my = ++seq
  if (shown && timers.has(shown)) flush(shown)
  current = path
  if (target?.path !== path) target = null // 切到别的文件：放弃还没应用的搜索定位
  if (!path) return setView(null, blank())
  // 视图里已经是它（读别的文件途中又切回来）：视图那份最新，不动
  if (path !== shown) {
    let s = states.get(path)
    if (!s) {
      let text: string
      try {
        text = await window.synote.readFile(vault!, path)
      } catch (e) {
        if (my !== seq) return
        throw e
      }
      if (my !== seq) return // 读文件期间又切走、关掉或换了库
      s = makeState(text, path)
    }
    setView(path, s)
  }
  applyTarget()
  view.focus()
}

function applyTarget() {
  if (!view || !target || target.path !== shown) return
  const doc = view.state.doc
  // 索引可能比编辑器内容旧：行列越界时夹到文末
  const line = doc.line(Math.min(target.line, doc.lines))
  const from = Math.min(line.from + target.col, line.to)
  const to = Math.min(from + target.len, line.to)
  target = null
  view.dispatch({ selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) })
}

// 打开文件并选中第 line 行 col 列起 len 个字符
export function reveal(path: string, line: number, col: number, len: number) {
  target = { path, line, col, len }
  if (path === shown) {
    applyTarget()
    view?.focus()
  }
  useEditor.getState().open(path)
}

// 打开双链指向的笔记；有锚点时定位到对应标题（按 GitHub slug 匹配，找不到就只打开）。
// 目标正文优先取已打开的那份（可能有未保存改动），否则读盘
async function followLink(h: Href, from: string) {
  const t = resolveHref(h, from)
  const v = vault
  if (!v) return
  if (!t || !t.path.endsWith('.md') || !(await window.synote.exists(v, [t.path]))[0]) {
    useUi.getState().setError(i18next.t('noteMissing', { path: t?.path ?? ('wiki' in h ? h.wiki : h.href) }))
    return
  }
  const text = t.anchor ? (docOf(t.path) ?? (await window.synote.readFile(v, t.path))) : ''
  if (vault !== v) return // 期间换了库
  const line = t.anchor ? anchorLine(text, t.anchor) : null
  if (line) reveal(t.path, line, 0, 0)
  else useEditor.getState().open(t.path)
}

// 正文与上次落盘一致（没有未保存改动）时不写盘
export const saveCurrent = () => !locked && shown && (timers.has(shown) || useEditor.getState().dirty[shown]) && flush(shown)

export function setLocked(on: boolean) {
  locked = on
  view?.dispatch({ effects: lock.reconfigure(lockExt()) })
  diff?.setReadOnly(on)
}

export function forget(path: string) {
  if (timers.has(path)) flush(path) // flush 同步取走内容，之后才能清掉缓存
  states.delete(path)
  diffMode.delete(path)
  if (target?.path === path) target = null
  if (path === current) {
    current = null
    seq++ // 它还在读的话，读回来也不显示
  }
  if (path === shown) {
    // 关掉的正是视图里的文件（另一个文件可能还在读）：换成只读占位，不留一个能输入却不会保存的编辑器
    shown = null
    if (view) setView(null, blank())
  }
}

// 外部改动：没有未保存改动的已打开文件直接重新加载
export async function reloadIfClean(path: string) {
  if (!states.has(path) && path !== shown) return
  if (useEditor.getState().dirty[path]) return
  const before = docOf(path)
  const v = vault!
  let text: string
  try {
    text = await window.synote.readFile(v, path)
  } catch {
    return // 文件已删除（标签页由 setVault 关闭），或已换库
  }
  // 读文件期间换了库、有本地输入（不论是否已存盘）或标签页已关：以本地为准，读到的可能是旧快照
  if (vault !== v || docOf(path) !== before || useEditor.getState().dirty[path]) return
  if (text === before) return // 自己写入触发的事件
  if (path === shown && view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: setEol.of(detectEol(text)), annotations: Transaction.remote.of(true) })
  else states.set(path, makeState(text, path))
  useEditor.getState().setDirty(path, false)
}

// 换笔记库（vaults.ts 已先 flushAll）：交接期间又有输入的话按旧库发出（主进程已切库时拒绝并提示），
// 然后清空整个编辑器状态；标签由 store 清
function switchVault(root: string | null) {
  for (const p of [...timers.keys()]) flush(p)
  vaultGen++
  states.clear()
  diffMode.clear()
  target = null
  current = null
  seq++
  if (shown) {
    shown = null
    if (view) setView(null, blank())
  }
  vault = root
}
useVault.subscribe((s, prev) => s.vault?.root !== prev.vault?.root && switchVault(s.vault?.root ?? null))
