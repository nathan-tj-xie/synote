// Monaco diff editor 薄封装（ADR 0003、0005）：只在第一次进入 diff 时由 editor.ts 动态 import。
// 正文的唯一来源仍是 CM6 视图：这里的输入经 onEdit 同步写回，CM6 的其它改动经 replace 推过来
import * as monaco from 'monaco-editor/editor/editor.api.js'
// 只挑日常编辑用得到的部分，键位与 CM6 的 VSCode 键位表一致；不用 editor.main（全部语言和功能）
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js'
import { CommandsRegistry } from 'monaco-editor/platform/commands/common/commands.js'
import { IKeybindingService } from 'monaco-editor/platform/keybinding/common/keybinding.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { i18next } from '../../shared/i18n'
import { fromMonacoLabel, monacoKeyName, parity } from './keymap'
import { isMac } from './match'
import { monacoColors } from './tokens'
import { bomOffset, dataUrl, imageAt, imageMime, MAX_IMAGE, minimalEdit } from './diffUtil'

// diff 计算放在 worker 里，不卡输入
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
monaco.editor.defineTheme('synote', { base: 'vs-dark', inherit: true, rules: [], colors: monacoColors() })

// 键位与 CM6 对齐（keymap.ts 的对照表）：Monaco 默认没有的那几条显式注册
const toKeybinding = (key: string) =>
  key
    .split(' ')
    .map((chord) => {
      const parts = chord.split('-')
      const code = monaco.KeyCode[monacoKeyName(parts.pop()!) as keyof typeof monaco.KeyCode]
      const mod = (m: string) =>
        m === 'Shift' ? M.Shift : m === 'Alt' ? M.Alt : (m === 'Cmd') === isMac ? M.CtrlCmd : M.WinCtrl
      return parts.reduce((k, m) => k | mod(m), code)
    })
    .reduce((a, b) => M.chord(a, b))
const { KeyMod: M } = monaco
const table = parity(isMac)
monaco.editor.addKeybindingRules(
  [...table].flatMap(([key, r]) => ('register' in r ? [{ keybinding: toKeybinding(key), command: r.cmd }] : [])),
)

// 自检：对照表里每条命令都要存在，且这个键在 Monaco 实际生效的键位里绑到它（防止漏加载 contribution、Monaco 升级改了默认键位）
function checkKeymap() {
  const kb = StandaloneServices.get<{ getKeybindings(): { command: string | null; resolvedKeybinding?: { getUserSettingsLabel(): string | null } }[] }>(IKeybindingService)
  const bound = new Set<string>()
  for (const it of kb.getKeybindings()) {
    const label = it.resolvedKeybinding?.getUserSettingsLabel()
    if (it.command && label) bound.add(`${fromMonacoLabel(label, isMac)}\0${it.command}`)
  }
  for (const [key, r] of table) {
    if (!('cmd' in r)) continue
    if (!CommandsRegistry.getCommand(r.cmd)) console.error('[diff] monaco command missing', key, r.cmd)
    else if (!bound.has(`${key}\0${r.cmd}`)) console.error('[diff] keybinding differs from CM6', key, r.cmd)
  }
}

export type Change = { from: number; to: number; insert: string }

let editor: monaco.editor.IStandaloneDiffEditor | null = null
let cur: { vault: string; path: string; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null = null
// replace / reset 写入 Monaco 时为 true：这些改动来自 CM6，不能再同步回去
let applying = false
// 不变式：CM6 正文 = off 个 BOM + Monaco 文本。Monaco 会把开头的 BOM 藏起来、不算进文本和偏移，藏几个不猜，
// 每次同步后按两边的实际文本量出来。mirror 是最近一次确认对齐时 Monaco 的文本，null 表示没对齐上。
// 写回 CM6 之前先确认对齐；对不上就不写回，以 CM6 为准重设 Monaco，错位的改动永远进不了 CM6、也就不会落盘
let off = 0
let mirror: string | null = null

function align(doc: string): boolean {
  const v = cur!.modified.getValue()
  const o = bomOffset(doc, v)
  mirror = o === null ? null : v
  off = o ?? 0
  return o !== null
}

// 以 CM6 为准整体重设工作区一侧；unexpected 为 true 说明前面的同步出了漏洞，记日志
function reset(doc: string, unexpected = true) {
  if (unexpected) console.error('[diff] modified side out of sync with CM6, resetting', { path: cur!.path })
  applying = true
  try {
    cur!.modified.setValue(doc)
  } finally {
    applying = false
  }
  if (!align(doc)) console.error('[diff] cannot align modified side with CM6, edits are not written back', { path: cur!.path })
}

// docNow：CM6 视图里的最新正文，写回前后用来核对对齐
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
  checkKeymap()
  editor.getModifiedEditor().onDidChangeModelContent((e) => {
    if (applying || !cur) return
    const doc = docNow()
    // 改动前两边必须对齐（mirror 就是这次改动前的 Monaco 文本），否则这次输入不写回
    if (mirror === null || bomOffset(doc, mirror) !== off) return reset(doc)
    // 一次事件里的多处改动都以改动前的文档为坐标，正好对应 CM6 一个事务里的多个 change
    onEdit(e.changes.map((c) => ({ from: c.rangeOffset + off, to: c.rangeOffset + c.rangeLength + off, insert: c.text })))
    const now = docNow()
    if (!align(now)) reset(now)
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
  cur = { vault, path, original: mk(head), modified: mk(doc) }
  editor!.setModel({ original: cur.original, modified: cur.modified })
  if (!align(doc)) reset(doc)
  setReadOnly(readOnly)
}

export function hide() {
  if (!cur) return
  editor!.setModel(null)
  cur.original.dispose()
  cur.modified.dispose()
  cur = null
}

// CM6 那边的改动（外部重载）：按 CM6 坐标求最小替换，换算成 Monaco 坐标推过去，保住光标和撤销栈。
// 改动碰到 Monaco 藏起来的 BOM、或之前没对齐，就整体重设
export function replace(doc: string) {
  if (!cur) return
  const m = cur.modified
  if (mirror !== null && m.getValue() === mirror) {
    const e = minimalEdit('\uFEFF'.repeat(off) + mirror, doc)
    if (!e) return
    if (e.from >= off) {
      const range = monaco.Range.fromPositions(m.getPositionAt(e.from - off), m.getPositionAt(e.to - off))
      applying = true
      try {
        m.pushEditOperations([], [{ range, text: e.insert }], () => null)
      } finally {
        applying = false
      }
      if (align(doc)) return
      return reset(doc)
    }
    return reset(doc, false)
  }
  reset(doc)
}
// HEAD 变了（提交、切分支）：更新左侧
export const setHead = (head: string) => cur && cur.original.setValue(head)
export const setReadOnly = (on: boolean) => editor?.getModifiedEditor().updateOptions({ readOnly: on })
export const focus = () => editor?.getModifiedEditor().focus()


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
