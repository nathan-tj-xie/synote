// CM6 薄封装：一个 EditorView，按标签页缓存 EditorState，不放进 React state（ADR 0005）
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type ChangeSpec, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import { minimalSetup } from 'codemirror'
import type { LogEntry } from '../../shared/api'
import { i18next } from '../../shared/i18n'
import type { Rewritten } from '../../shared/api'
import { applyEdits } from '../../shared/mdLinks'
import { anchorLine, movePath, relativeLink } from '../../shared/url'
import { imageMime } from './diffUtil'
import { tableTrailingSpace } from './gfmTable'
import { noteCompletion, resolveHref, type Href } from './links'
import { mathSyntax } from './embed'
import { forgetFiles, insertMath, linkAt, livePreview } from './livePreview'
import { isMac } from './match'
import { useEditor, useGit, useUi, useVault } from './store'

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
// 历史对比（S15）同用这一套，只是左侧换成某个提交里的版本
type Source = { rev: string; path: string } // 左侧：HEAD 或提交 oid，path 是文件在那个版本里的路径
const diffMode = new Map<string, Source>() // 处于 diff 形态的已打开文件（按标签页记住）
let diffWant: string | null = null // 应该显示的 diff：`文件\0版本`（加载中或已显示）
let diffShown: string | null = null // Monaco 里实际是哪个文件
let diffSeq = 0
// 合并中还没解决的冲突文件（S16）：打开时直接进冲突视图，优先于 diff 形态；解决（自动 git add）后回到正文
let conflicted = new Set<string>()
const fromDiff = Annotation.define<boolean>()
let cmBox: HTMLElement | null = null
let diffBox: HTMLElement | null = null

const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)' },
    '.cm-content': { fontFamily: 'var(--font-ui)', padding: 'var(--space6) clamp(16px, 3vw, 40px)', boxSizing: 'border-box', caretColor: 'var(--accent)', maxWidth: 'var(--editor-width)', margin: '0 auto' },
    '.cm-scroller': { lineHeight: 'var(--line-height-editor)', fontSize: 'var(--font-size-editor)', fontFamily: 'var(--font-ui)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-raised)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-control)', boxShadow: 'var(--shadow)', fontSize: 'var(--font-size-ui)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--bg-selected)', color: 'var(--fg)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--bg-selected)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
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

// 和笔记路径有关的扩展（链接按所在目录解析）放在一个 compartment 里，重命名后原地换掉，不丢撤销历史
const where = new Compartment()
const atPath = (path: string) => [
  livePreview(vault ? { vault, path } : null),
  noteCompletion(path),
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
]

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
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [tableTrailingSpace, mathSyntax] }), // GFM（表格、任务列表、删除线）；代码块按语言懒加载高亮
      where.of(atPath(path)),
      EditorView.lineWrapping,
      theme,
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
  // 拖入：链接落在松手处，光标也移过去（否则与光标同行时插完仍显示源码）
  if (at != null) view.dispatch({ selection: { anchor: at }, effects: addPending.of({ id, from: at, to: at }) })
  else view.dispatch({ effects: addPending.of({ id, from: sel.from, to: sel.to }) })
  const v = vault
  const g = vaultGen
  const note = shown
  const job = (async () => {
    const links: string[] = []
    const saved: string[] = []
    try {
      for (const f of [...files]) {
        // Chromium 里截图等剪贴板位图的文件名固定是 image.png，按剪贴板图片命名
        const r = await window.synote.saveAttachment(v, paste && f.name === 'image.png' ? null : f.name, new Uint8Array(await f.arrayBuffer()))
        if (r.warn) useUi.getState().setError(i18next.t(r.warn === 'huge' ? 'attachmentHuge' : 'attachmentLarge', { path: r.path }))
        saved.push(r.path)
        forgetFiles(v, [r.path]) // 之前按缺失缓存过的同名附件
        const alt = r.path.split('/').pop()!.replace(/\.[^.]*$/, '').replace(/[\\[\]]/g, '\\$&')
        links.push(`${imageMime(r.path) ? '!' : ''}[${alt}](${relativeLink(note, r.path)})`)
      }
    } catch (err) {
      useUi.getState().setError(String(err))
    }
    // 插入任务结束（插入、取消或丢弃）：插了链接就立即落盘，再通知主进程解除这些附件的在途保护（S11）。
    // 之后撤销掉链接的话，它们就是普通孤儿，可以清理
    if (place(links) && g === vaultGen) await flush(note)
    if (saved.length) await window.synote.attachmentSettled(v, saved).catch((e) => console.error('[attach] settle failed', e))
  })()
  attaching.add(job)
  job.finally(() => attaching.delete(job))
  return true

  // 把链接插进发起时的位置，返回是否改了正文
  function place(links: string[]): boolean {
    if (g !== vaultGen) return false
    const s = note === shown ? view?.state : states.get(note)
    const r = s?.field(pending, false)?.get(id)
    if (!s || !r) return false // 标签页已关，或外部改动重新加载过（位置已作废）
    const spec: TransactionSpec = { effects: dropPending.of(id) }
    if (links.length && !locked) {
      let insert = links.join('\n')
      const cur = s.selection.main
      // 光标还停在发起时那段上才把它放到链接后面（换到下一行，否则光标所在行显示源码、图片不渲染），否则只随改动映射
      if (cur.from === r.from && cur.to === r.to) {
        insert += '\n'
        spec.selection = { anchor: r.from + insert.length }
      }
      spec.changes = { from: r.from, to: r.to, insert }
      spec.userEvent = 'input.paste'
    }
    if (note === shown) view!.dispatch(spec)
    else {
      states.set(note, s.update(spec).state)
      if (spec.changes) scheduleSave(note)
    }
    return !!spec.changes
  }
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
  useUi.getState().setEmbed(null) // 嵌入块的编辑属于换下去的那篇（写回时也会核对）
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

// 改 diffMode 都走这里，同时更新 store 里的镜像（历史栏据此高亮选中的提交）
function setMode(path: string, src: Source | null) {
  if (src) diffMode.set(path, src)
  else diffMode.delete(path)
  useEditor.getState().setCompare(path, src?.rev ?? null)
}

// 让 Monaco 跟上「shown 是否处于 diff 形态」。setView 之后、切换形态时调用；加载期间 CM6 照常可用，
// 加载完才取视图里的最新正文放进 Monaco。读左侧版本失败（没有 git、不是仓库）就退回正文并报错
function syncDiff() {
  const conflict = !!shown && conflicted.has(shown)
  const src = shown && !conflict ? diffMode.get(shown) : undefined
  const want = conflict ? `${shown}\0conflict` : src ? `${shown}\0${src.rev}` : null
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
  if (!src && !conflict) return
  const p = shown!
  const v = vault!
  ;(async () => {
    const [mod, head] = await Promise.all([diff ?? import('./diff'), src ? window.synote.readRev(v, src.rev, src.path) : null])
    diff = mod
    if (my !== diffSeq || !view) return // 期间又切了文件 / 形态，或换了库
    if (!diffBox!.childElementCount) mod.create(diffBox!, applyFromDiff, () => view!.state.doc.toString())
    diffBox!.hidden = false
    cmBox!.hidden = true
    mod.show(v, p, src?.rev ?? '', src?.path ?? p, decode(head), view.state.doc.toString(), locked, conflict)
    diffShown = p
    mod.focus()
  })().catch((e) => {
    if (my !== diffSeq) return
    if (src) setMode(p, null)
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
  setMode(shown, on ? { rev: 'HEAD', path: shown } : null)
  syncDiff()
  if (!on) view!.focus()
}

// git 面板点改动的文件（S13）：打开它并直接进入工作区对比（已在对比中就保持）
export function openDiff(path: string) {
  if (locked) return
  if (diffMode.get(path)?.rev !== 'HEAD') setMode(path, { rev: 'HEAD', path })
  if (path === shown) syncDiff()
  useEditor.getState().open(path)
}

// 历史栏选中提交（S15）：当前笔记 ↔ 该提交里的版本，再点同一个提交回到正文。左侧只读，块级拣回和输入一样写回 CM6
export function compareWith(path: string, e: LogEntry) {
  if (path !== shown || locked) return
  const off = diffMode.get(path)?.rev === e.hash
  setMode(path, off ? null : { rev: e.hash, path: e.path })
  syncDiff()
  if (off) view!.focus()
}

useGit.subscribe((s) => {
  const st = s.state
  conflicted = new Set(st?.status === 'ready' && st.merging ? st.files.filter((f) => f.conflict).map((f) => f.path) : [])
  if (view) syncDiff()
})

// HEAD 变了（提交、切分支等）：刷新工作区对比的左侧；历史提交的内容不会变
window.synote.onGitChanged((e) => {
  const p = diffShown
  if (!p || !vault || e.root !== vault || diffMode.get(p)?.rev !== 'HEAD') return
  const my = diffSeq
  window.synote.readRev(vault, 'HEAD', p).then(
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
  if (!t || !t.path.endsWith('.md') || (await window.synote.presence(v, [t.path]))[0].state === 'missing') {
    useUi.getState().setError(i18next.t('noteMissing', { path: t?.path ?? ('wiki' in h ? h.wiki : h.href) }))
    return
  }
  const text = t.anchor ? (docOf(t.path) ?? (await window.synote.readFile(v, t.path))) : ''
  if (vault !== v) return // 期间换了库
  const line = t.anchor ? anchorLine(text, t.anchor) : null
  if (line) reveal(t.path, line, 0, 0)
  else useEditor.getState().open(t.path)
}

// 命令「插入块级公式 / 插入行内公式」（S4）
export const insertEmbed = (display: boolean) => view && shown && !locked && !diffShown && insertMath(view, display)

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
  setMode(path, null)
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

// 会改写工作区的 git 操作（pull 等，S13）：插完在途附件、加锁、所有输入落盘（写不进去就抛 unsaved），操作期间编辑器只读；
// 结束后（成功或失败）把每个已打开的笔记按磁盘主动重载一次再解锁，不等 watcher：否则解锁后、重载前的输入会把旧正文存回去
export async function withWorktreeLock<T>(unsaved: string, f: () => Promise<T>): Promise<T> {
  if (locked) throw new Error(i18next.t('worktreeBusy'))
  await attachmentsSettled()
  if (locked) throw new Error(i18next.t('worktreeBusy'))
  setLocked(true)
  try {
    if (!(await flushAll())) throw new Error(unsaved)
    return await f()
  } finally {
    await Promise.all([...new Set([...states.keys(), ...(shown ? [shown] : [])])].map(reloadIfClean))
    setLocked(false)
  }
}

// 重命名 / 移动（S9）：主进程算出并原子地写下所有改写，编辑器这边保证不和它打架——先插完在途附件、加锁、把所有输入落盘
// （此后磁盘内容就是编辑器内容，dirty 为空；有没写进去的改动就拒绝），确认后执行，再把同一组改写同步进已打开笔记的状态
// （不再写盘），路径随之改名。交接锁期间拒绝。用户在确认时取消返回 false
export async function renamePath(r: string, from: string, to: string, confirm: (plan: { files: string[]; skipped: string[] }) => Promise<boolean>): Promise<boolean> {
  const busy = () => locked || vault !== r
  if (busy()) throw new Error(i18next.t('renameBusy'))
  await attachmentsSettled() // 加锁后在途的附件就插不进链接了
  if (busy()) throw new Error(i18next.t('renameBusy'))
  setLocked(true)
  try {
    if (!(await flushAll())) throw new Error(i18next.t('renameUnsaved'))
    const plan = await window.synote.planRename(r, from, to)
    if ((plan.files.length || plan.skipped.length) && !(await confirm(plan))) return false
    const rewritten = await window.synote.rename(r, from, to, plan.files)
    if (vault === r) followRename(from, to, rewritten)
    return true
  } finally {
    setLocked(false)
  }
}

// 主进程的改写按磁盘正文（原换行符）计偏移；编辑器内部一律是 \n，CRLF 时减去前面的 \r。
// 编辑器正文和改写前的磁盘正文对不上（读入时归一了换行等）就整篇换成改写后的正文
function rewriteChanges(s: EditorState, w: Rewritten): ChangeSpec {
  const doc = s.doc.toString()
  const disk = s.field(eol, false) === '\r\n' ? doc.replace(/\n/g, '\r\n') : doc
  if (disk !== w.before) return { from: 0, to: s.doc.length, insert: applyEdits(w.before, w.edits) }
  const at = (i: number) => i - (w.before.slice(0, i).split('\r').length - 1)
  return w.edits.map((e) => ({ from: at(e.from), to: at(e.to), insert: e.insert }))
}

function followRename(from: string, to: string, rewritten: Rewritten[]) {
  const move = (p: string) => movePath(p, from, to)
  const byPath = new Map(rewritten.map((w) => [w.path, w]))
  for (const p of new Set([...states.keys(), ...(shown ? [shown] : [])])) {
    const np = move(p)
    const w = byPath.get(p)
    if (np === p && !w) continue
    const s = p === shown ? view!.state : states.get(p)!
    // 已经写盘：remote 不触发保存；不进撤销历史，撤销不会把链接改回旧路径
    const spec: TransactionSpec = { annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] }
    if (w) spec.changes = rewriteChanges(s, w)
    if (np !== p) spec.effects = where.reconfigure(atPath(np))
    if (p === shown) view!.dispatch(spec)
    else states.set(p, s.update(spec).state)
    if (np === p) continue
    if (p === shown) shown = np
    else {
      states.set(np, states.get(p)!)
      states.delete(p)
    }
    setMode(p, null) // diff 左侧是按旧路径读的版本（HEAD 或历史提交）：退回正文
    writes.delete(p)
  }
  if (current) current = move(current)
  if (target) target.path = move(target.path)
  useEditor.getState().rename(move)
  syncDiff()
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
