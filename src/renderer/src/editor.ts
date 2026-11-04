// CM6 薄封装：一个 EditorView，按标签页缓存 EditorState，不放进 React state（ADR 0005）
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import { minimalSetup } from 'codemirror'
import { useEditor, useUi } from './store'

const states = new Map<string, EditorState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// 每个文件的写盘串成一条链：后发的保存必须在先发的之后落盘，否则旧内容会覆盖新内容
const writes = new Map<string, Promise<unknown>>()
let view: EditorView | null = null
let current: string | null = null // 要显示的文件
let shown: string | null = null // 视图里实际是哪个文件；读文件期间仍是上一个
// 搜索结果点击后要定位的位置，文件加载完再应用
let target: { path: string; line: number; col: number; len: number } | null = null

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

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      keymap.of(vscodeKeymap), // 键位贴近 Monaco（ADR 0003），放在前面优先于 minimalSetup 的默认键位
      minimalSetup,
      EditorState.allowMultipleSelections.of(true), // ⌘D、⌥ 点击等多光标键位需要
      markdown(),
      EditorView.lineWrapping,
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && shown && !u.transactions.some((t) => t.annotation(Transaction.remote))) scheduleSave(shown)
      }),
    ],
  })
}

function docOf(path: string): string | undefined {
  return (path === shown ? view?.state : states.get(path))?.doc.toString()
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
  if (text === undefined) return
  const write = (writes.get(path) ?? Promise.resolve()).then(() => window.synote.writeFile(path, text))
  writes.set(path, write.catch(() => {}))
  try {
    await write
    const now = docOf(path)
    if (now === undefined || now === text) useEditor.getState().setDirty(path, false) // undefined：标签页已关
  } catch (e) {
    useUi.getState().setError(String(e))
  }
}

function setView(path: string | null, s: EditorState) {
  view!.setState(s)
  shown = path
}

export function mount(parent: HTMLElement) {
  view = new EditorView({ state: makeState(''), parent })
  return () => {
    view?.destroy()
    view = null
    current = shown = null
  }
}

export async function show(path: string | null) {
  if (!view || path === current) return
  if (shown) {
    states.set(shown, view.state)
    if (timers.has(shown)) flush(shown)
  }
  current = path
  if (target?.path !== path) target = null // 切到别的文件：放弃还没应用的搜索定位
  if (!path) return setView(null, makeState(''))
  let s = states.get(path)
  if (!s) {
    s = makeState(await window.synote.readFile(path))
    if (shown === path || states.has(path)) return // 读文件期间另一次 show 已经读进来了，以先到的为准
    if (current !== path) return states.set(path, s) // 读文件期间又切走了
  }
  setView(path, s)
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

export const saveCurrent = () => shown && flush(shown)

export function forget(path: string) {
  if (timers.has(path)) flush(path) // flush 同步取走内容，之后才能清掉缓存
  states.delete(path)
  if (path === current) current = null
  if (path === shown) shown = null
}

// 外部改动：没有未保存改动的已打开文件直接重新加载
export async function reloadIfClean(path: string) {
  if (!states.has(path) && path !== shown) return
  if (useEditor.getState().dirty[path]) return
  const before = docOf(path)
  let text: string
  try {
    text = await window.synote.readFile(path)
  } catch {
    return // 文件已删除，标签页由 setVault 关闭
  }
  // 读文件期间有本地输入（不论是否已存盘），或标签页已关：以本地为准，读到的可能是旧快照
  if (docOf(path) !== before || useEditor.getState().dirty[path]) return
  if (text === before) return // 自己写入触发的事件
  if (path === shown && view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.remote.of(true) })
  else states.set(path, makeState(text))
  useEditor.getState().setDirty(path, false)
}
