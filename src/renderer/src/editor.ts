// CM6 薄封装：一个 EditorView，按标签页缓存 EditorState，不放进 React state（ADR 0005）
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { minimalSetup } from 'codemirror'
import { useStore } from './store'

const states = new Map<string, EditorState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let view: EditorView | null = null
let current: string | null = null

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
      minimalSetup,
      markdown(),
      EditorView.lineWrapping,
      theme,
      keymap.of([{ key: 'Mod-s', run: () => (current && flush(current), true) }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && current && !u.transactions.some((t) => t.annotation(Transaction.remote))) scheduleSave(current)
      }),
    ],
  })
}

function docOf(path: string): string | undefined {
  return (path === current ? view?.state : states.get(path))?.doc.toString()
}

function scheduleSave(path: string) {
  useStore.getState().setDirty(path, true)
  clearTimeout(timers.get(path))
  timers.set(path, setTimeout(() => flush(path), 500))
}

async function flush(path: string) {
  clearTimeout(timers.get(path))
  timers.delete(path)
  const text = docOf(path)
  if (text === undefined) return
  try {
    await window.synote.writeFile(path, text)
    if (docOf(path) === text) useStore.getState().setDirty(path, false)
  } catch (e) {
    useStore.getState().setError(String(e))
  }
}

export function mount(parent: HTMLElement) {
  view = new EditorView({ state: makeState(''), parent })
  return () => {
    view?.destroy()
    view = null
    current = null
  }
}

export async function show(path: string | null) {
  if (!view || path === current) return
  if (current) {
    states.set(current, view.state)
    if (timers.has(current)) flush(current)
  }
  current = path
  if (!path) return view.setState(makeState(''))
  let s = states.get(path)
  if (!s) {
    s = makeState(await window.synote.readFile(path))
    if (current !== path) return states.set(path, s) // 读文件期间又切走了
  }
  view.setState(s)
  view.focus()
}

export function forget(path: string) {
  if (timers.has(path)) flush(path) // flush 同步取走内容，之后才能清掉缓存
  states.delete(path)
  if (path === current) current = null
}

// 外部改动：没有未保存改动的已打开文件直接重新加载
export async function reloadIfClean(path: string) {
  if (!states.has(path) && path !== current) return
  if (useStore.getState().dirty[path]) return
  let text: string
  try {
    text = await window.synote.readFile(path)
  } catch {
    return // 文件已删除，标签页由 setVault 关闭
  }
  if (text === docOf(path)) return // 自己写入触发的事件
  if (path === current && view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.remote.of(true) })
  else states.set(path, makeState(text))
  useStore.getState().setDirty(path, false)
}
