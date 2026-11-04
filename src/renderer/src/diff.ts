// Monaco diff editor 薄封装（ADR 0003、0005）：只在第一次进入 diff 时由 editor.ts 动态 import。
// 正文的唯一来源仍是 CM6 视图：这里的输入经 onEdit 同步写回，CM6 的其它改动经 replace 推过来
import * as monaco from 'monaco-editor/editor/editor.api.js'
// 只挑日常编辑用得到的部分，键位与 CM6 的 VSCode 键位表一致；不用 editor.main（全部语言和功能）
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { i18next } from '../../shared/i18n'
import { monacoColors } from './tokens'
import { imageAt, imageMime, minimalEdit } from './diffUtil'

// diff 计算放在 worker 里，不卡输入
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
monaco.editor.defineTheme('synote', { base: 'vs-dark', inherit: true, rules: [], colors: monacoColors() })

// CM6 的 VSCode 键位表在 mac 上比 Monaco 多几条（⌘Home / ⌘End 到文首文末、⌘Y 重做），补齐让两边一致
const { KeyMod: M, KeyCode: K } = monaco
monaco.editor.addKeybindingRules(
  [
    [M.CtrlCmd | K.Home, 'cursorTop'],
    [M.CtrlCmd | M.Shift | K.Home, 'cursorTopSelect'],
    [M.CtrlCmd | K.End, 'cursorBottom'],
    [M.CtrlCmd | M.Shift | K.End, 'cursorBottomSelect'],
    [M.CtrlCmd | K.KeyY, 'redo'],
  ].map(([keybinding, command]) => ({ keybinding: keybinding as number, command: command as string })),
)

export type Change = { from: number; to: number; insert: string }

let editor: monaco.editor.IStandaloneDiffEditor | null = null
let cur: { vault: string; path: string; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null = null
// replace 写入 Monaco 时为 true：这些改动来自 CM6，不能再同步回去
let applying = false
// Monaco 把开头的 BOM 单独存、不算进文本和偏移，CM6 的 doc 里却是一个字符：工作区一侧的文本 = CM6 正文去掉 BOM，
// 偏移整体差 bom 位。落盘字节不动（仍按 CM6 的 doc 写）
let bom = 0
const strip = (doc: string) => {
  bom = doc.startsWith('\uFEFF') ? 1 : 0
  return doc.slice(bom)
}

// 不变式自检：每次同步后工作区一侧必须和 CM6 正文一致；不一致说明偏移换算有漏洞，以 CM6 为准整体重设并记日志
function verify(doc: string) {
  const m = cur?.modified
  const want = strip(doc)
  if (!m || m.getValue() === want) return
  console.error('[diff] modified side out of sync with CM6, resetting', { path: cur!.path })
  applying = true
  try {
    m.setValue(want)
  } finally {
    applying = false
  }
}

// docNow：CM6 视图里的最新正文，同步后用来自检
export function create(parent: HTMLElement, onEdit: (changes: Change[]) => void, docNow: () => string) {
  const body = getComputedStyle(document.body)
  editor = monaco.editor.createDiffEditor(parent, {
    theme: 'synote',
    automaticLayout: true,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: false, // 始终左右并排：内联视图里删除行悬停不了，看不到 HEAD 一侧的图
    wordWrap: 'on',
    diffWordWrap: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // 字体与 CM6 共用（ADR 0003）：都取 body 上的那一份
    fontFamily: body.fontFamily,
    fontSize: parseFloat(body.fontSize),
    lineHeight: 1.7,
    renderOverviewRuler: true,
  })
  editor.getModifiedEditor().onDidChangeModelContent((e) => {
    // 一次事件里的多处改动都以改动前的文档为坐标，正好对应 CM6 一个事务里的多个 change
    if (applying) return
    onEdit(e.changes.map((c) => ({ from: c.rangeOffset + bom, to: c.rangeOffset + c.rangeLength + bom, insert: c.text })))
    verify(docNow())
  })
}

export function show(vault: string, path: string, head: string, doc: string, readOnly: boolean) {
  hide()
  // 模型只是 CM6 正文的临时镜像，每次进入重建；EOL 固定为 LF，偏移才和 CM6 对得上（CM6 的 doc 只用 \n）
  const mk = (text: string) => {
    const m = monaco.editor.createModel(text, 'markdown')
    m.setEOL(monaco.editor.EndOfLineSequence.LF)
    return m
  }
  cur = { vault, path, original: mk(head), modified: mk(strip(doc)) }
  editor!.setModel({ original: cur.original, modified: cur.modified })
  setReadOnly(readOnly)
}

export function hide() {
  if (!cur) return
  editor!.setModel(null)
  cur.original.dispose()
  cur.modified.dispose()
  cur = null
}

const edit = (m: monaco.editor.ITextModel, text: string) => {
  const e = minimalEdit(m.getValue(), text)
  if (!e) return
  const range = monaco.Range.fromPositions(m.getPositionAt(e.from), m.getPositionAt(e.to))
  applying = true
  try {
    m.pushEditOperations([], [{ range, text: e.insert }], () => null)
  } finally {
    applying = false
  }
}

// CM6 那边的改动（外部重载）：推给工作区一侧
export function replace(doc: string) {
  if (!cur) return
  edit(cur.modified, strip(doc))
  verify(doc)
}
// HEAD 变了（提交、切分支）：更新左侧
export const setHead = (head: string) => cur && cur.original.setValue(head)
export const setReadOnly = (on: boolean) => editor?.getModifiedEditor().updateOptions({ readOnly: on })
export const focus = () => editor?.getModifiedEditor().focus()

const dataUrl = (bytes: Uint8Array, type: string) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  })

// shortcut: 缩略图直接用整张原图的 data URL，超过 8 MiB 不显示；有大图需求时再在主进程缩放
const MAX_IMAGE = 8 << 20

// diff 里的图片只显示源码，悬停弹出缩略图（#9 决定 6）：左边读 HEAD 里的 blob（文件已删也能看到），右边读工作区
monaco.languages.registerHoverProvider('markdown', {
  async provideHover(model, pos) {
    const c = cur
    if (!c || (model !== c.original && model !== c.modified)) return null
    const ref = imageAt(model.getLineContent(pos.lineNumber), pos.column - 1, c.path)
    if (!ref) return null
    const range = new monaco.Range(pos.lineNumber, ref.start + 1, pos.lineNumber, ref.end + 1)
    const bytes = await (model === c.original ? window.synote.readHead(c.vault, ref.path) : window.synote.readBytes(c.vault, ref.path)).catch(() => null)
    const text = (value: string) => ({ range, contents: [{ value }] })
    if (!bytes) return text(i18next.t('imageMissing', { path: ref.path }))
    if (bytes.length > MAX_IMAGE) return text(i18next.t('imageTooLarge'))
    return text(`![](${await dataUrl(bytes, imageMime(ref.path)!)}|width=240)`)
  },
})
