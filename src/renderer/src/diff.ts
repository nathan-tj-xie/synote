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
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js'
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
import { parseConflicts, resolveConflict } from '../../shared/conflicts'
import { i18next } from '../../shared/i18n'
import { parseLfsPointer, sizeLabel } from '../../shared/lfs'
import { fromMonacoLabel, monacoKeyName, parity } from './keymap'
import { isMac } from './match'
import { useUi } from './store'
import { monacoColors, monacoRules } from './tokens'
import { bomOffset, dataUrl, escapeMd, imageAt, imageMime, lfsHoverMarkdown, MAX_IMAGE, minimalEdit } from './diffUtil'

// diff 计算放在 worker 里，不卡输入
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
monaco.editor.defineTheme('synote', { base: 'vs-dark', inherit: true, rules: monacoRules(), colors: monacoColors() })

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
// 冲突视图（S16，#9 决定 1）：单个编辑器显示冲突标记，和 diff 共用 modified 一侧的同步（cur.modified 就是它的模型）
let conflictEd: monaco.editor.IStandaloneCodeEditor | null = null
let diffDiv: HTMLElement | null = null
let conflictDiv: HTMLElement | null = null
// path：当前笔记（右侧）；base：左侧那个版本里笔记的路径（跨目录改名后与 path 不同），两侧的相对链接各按各的解析；
// conflict：显示的是冲突视图（original 不用）
let cur: { vault: string; path: string; rev: string; base: string; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel; conflict: boolean } | null = null
// 冲突视图里正在编辑的那一侧编辑器
const modifiedEd = () => (cur?.conflict ? conflictEd! : editor!.getModifiedEditor())
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
  diffDiv = parent.appendChild(document.createElement('div'))
  conflictDiv = parent.appendChild(document.createElement('div'))
  diffDiv.style.height = conflictDiv.style.height = '100%'
  conflictDiv.dataset.conflictView = ''
  conflictDiv.hidden = true
  editor = monaco.editor.createDiffEditor(diffDiv, {
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
    // 块级拣回（#9）：改动块旁的箭头把左侧那块应用到右侧，走 modified 编辑器的编辑，经 onEdit 写回 CM6。
    // 默认的 gutter 菜单在 standalone 里没有动作，还会顶掉箭头；只读（交接锁）时 Monaco 拒绝这类编辑
    renderGutterMenu: false,
    glyphMargin: true, // 箭头画在 glyph margin 里，standalone 默认没开
  })
  conflictEd = monaco.editor.create(conflictDiv, {
    theme: 'synote',
    automaticLayout: true,
    wordWrap: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: body.fontFamily,
    fontSize: parseFloat(body.fontSize),
    lineHeight: 1.7,
    codeLens: true,
  })
  checkKeymap()
  const blocks = conflictEd.createDecorationsCollection()
  const mark = () => blocks.set(cur?.conflict ? conflictDecorations(cur.modified) : [])
  conflictEd.onDidChangeModel(mark)
  conflictEd.onDidChangeModelContent(mark)
  const sync = (ed: monaco.editor.ICodeEditor, conflict: boolean) => ed.onDidChangeModelContent((e) => {
    if (applying || !cur || cur.conflict !== conflict) return
    const doc = docNow()
    // 改动前两边必须对齐（mirror 就是这次改动前的 Monaco 文本），否则这次输入不写回
    if (mirror === null || bomOffset(doc, mirror) !== off) return reset(doc)
    // 一次事件里的多处改动都以改动前的文档为坐标，正好对应 CM6 一个事务里的多个 change
    onEdit(e.changes.map((c) => ({ from: c.rangeOffset + off, to: c.rangeOffset + c.rangeLength + off, insert: c.text })))
    const now = docNow()
    if (!align(now)) reset(now)
  })
  sync(editor.getModifiedEditor(), false)
  sync(conflictEd, true)
}

// 两侧各染一层底色，看得出哪段是本地、哪段是传入的；标记行本身不染
function conflictDecorations(m: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const span = (from: number, to: number, className: string) =>
    to > from ? [{ range: new monaco.Range(from, 1, to - 1, 1), options: { isWholeLine: true, className } }] : []
  return parseConflicts(m.getValue()).flatMap((c) => [...span(c.start + 1, c.base ?? c.mid, 'synote-ours'), ...span(c.mid + 1, c.end, 'synote-theirs')])
}

// 冲突块上方的行内按钮（#9 决定 1）。按块起始行定位：点的时候按当前内容重新解析，内容变过、块已不在就什么都不做
monaco.languages.registerCodeLensProvider('markdown', {
  provideCodeLenses(model) {
    const lenses = cur?.conflict && model === cur.modified
      ? parseConflicts(model.getValue()).flatMap((c) =>
          (['ours', 'theirs', 'both'] as const).map((take) => ({
            range: new monaco.Range(c.start, 1, c.start, 1),
            command: { id: 'synote.acceptConflict', title: i18next.t(`conflictAccept_${take}`), arguments: [c.start, take] },
          })),
        )
      : []
    return { lenses, dispose() {} }
  },
})
monaco.editor.registerCommand('synote.acceptConflict', (_acc, start: number, take: 'ours' | 'theirs' | 'both') => {
  if (!cur?.conflict || conflictEd!.getOption(monaco.editor.EditorOption.readOnly)) return
  const m = cur.modified
  const text = m.getValue()
  const c = parseConflicts(text).find((x) => x.start === start)
  const e = c && minimalEdit(text, resolveConflict(text, c, take))
  if (!e) return
  // 走编辑器的编辑：和手改一样同步回 CM6、进撤销栈
  conflictEd!.executeEdits('conflict', [{ range: monaco.Range.fromPositions(m.getPositionAt(e.from), m.getPositionAt(e.to)), text: e.insert }])
  conflictEd!.focus()
})

// 删除的笔记（S13）：工作区里已没有它，不进 CM6 / 标签页，单独开一个只读 diff：左 HEAD 正文、右空。返回销毁函数
export function showDeleted(parent: HTMLElement, head: string): () => void {
  const body = getComputedStyle(document.body)
  const ed = monaco.editor.createDiffEditor(parent, {
    theme: 'synote',
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: false,
    wordWrap: 'on',
    diffWordWrap: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: body.fontFamily,
    fontSize: parseFloat(body.fontSize),
    lineHeight: 1.7,
    renderGutterMenu: false,
  })
  const original = monaco.editor.createModel(head, 'markdown')
  const modified = monaco.editor.createModel('', 'markdown')
  ed.setModel({ original, modified })
  return () => {
    ed.dispose()
    original.dispose()
    modified.dispose()
  }
}

// rev / base：左侧是哪个版本（HEAD 或历史提交的 oid）、笔记在那个版本里的路径，悬停图片时按它解析、从同一版本读。
// conflict：改为显示冲突视图（S16），rev / base / head 不用
export function show(vault: string, path: string, rev: string, base: string, head: string, doc: string, readOnly: boolean, conflict = false) {
  hide()
  // 模型只是 CM6 正文的临时镜像，每次进入重建；EOL 固定为 LF，偏移才和 CM6 对得上（CM6 的 doc 只用 \n）
  const mk = (text: string) => {
    const m = monaco.editor.createModel(text, 'markdown')
    m.setEOL(monaco.editor.EndOfLineSequence.LF)
    return m
  }
  cur = { vault, path, rev, base, original: mk(head), modified: mk(doc), conflict }
  diffDiv!.hidden = conflict
  conflictDiv!.hidden = !conflict
  if (conflict) conflictEd!.setModel(cur.modified)
  else editor!.setModel({ original: cur.original, modified: cur.modified })
  if (!align(doc)) reset(doc)
  setReadOnly(readOnly)
}

export function hide() {
  if (!cur) return
  editor!.setModel(null)
  conflictEd!.setModel(null)
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
// 左侧版本的内容变了（HEAD 指向了别的提交）：更新左侧
export const setHead = (head: string) => cur && cur.original.setValue(head)
export const setReadOnly = (on: boolean) => {
  editor?.getModifiedEditor().updateOptions({ readOnly: on })
  conflictEd?.updateOptions({ readOnly: on })
}
export const focus = () => cur && modifiedEd().focus()


// 用户在悬停里点了"下载"的 LFS 图片（S17）：左侧按版本 smudge（对象顺带存进本地 LFS 存储，readRev 下次就能直接读到），
// 右侧（工作区）git lfs pull。下好后在原处重新弹出悬停。smudge 的结果也记一份，自定义了 lfs.storage 的仓库靠它
// shortcut: 只增不减，一次会话里下载的历史图片极多时再加上限
// 只按完整 oid 记：HEAD 会指向别的提交，按字符串 HEAD 记会把旧版本的图当成新的（HEAD 一侧下载后对象已在本地，readRev 直接命中）
const smudged = new Map<string, Uint8Array>()
const smudgeKey = (vault: string, rev: string, path: string) => (/^[0-9a-f]{40,64}$/.test(rev) ? `${vault}\0${rev}\0${path}` : null)
monaco.editor.registerCommand('synote.lfsDownload', async (_acc, side: 'original' | 'modified', line: number, column: number) => {
  const c = cur
  if (!c) return
  const model = side === 'original' ? c.original : c.modified
  const ref = imageAt(model.getLineContent(line), column - 1, side === 'original' ? c.base : c.path)
  if (!ref) return
  try {
    if (side === 'original') {
      const b = await window.synote.lfsSmudge(c.vault, c.rev, ref.path)
      const key = smudgeKey(c.vault, c.rev, ref.path)
      if (b && key) smudged.set(key, b)
    } else await window.synote.lfsPull(c.vault, ref.path)
  } catch (e) {
    return useUi.getState().setError(String(e))
  }
  if (cur !== c) return
  const ed = side === 'original' ? editor!.getOriginalEditor() : modifiedEd()
  ed.focus()
  ed.setPosition({ lineNumber: line, column })
  // 原来的悬停还开着时 showHover 只会聚焦它、不重新取内容，先关掉
  ed.trigger('lfs', 'editor.action.hideHover', {})
  ed.trigger('lfs', 'editor.action.showHover', {})
})

// diff 里的图片只显示源码，悬停弹出缩略图（#9 决定 6）：左边读那个版本里的 blob（文件已删也能看到），右边读工作区。
// 读到 LFS 指针（内容没下载，S17）时显示占位和"下载"链接，悬停本身绝不下载
monaco.languages.registerHoverProvider('markdown', {
  async provideHover(model, pos) {
    const c = cur
    if (!c || (model !== c.original && model !== c.modified)) return null
    const ref = imageAt(model.getLineContent(pos.lineNumber), pos.column - 1, model === c.original ? c.base : c.path)
    if (!ref) return null
    const range = new monaco.Range(pos.lineNumber, ref.start + 1, pos.lineNumber, ref.end + 1)
    const side = model === c.original ? 'original' : 'modified'
    const bytes =
      (side === 'original' && smudged.get(smudgeKey(c.vault, c.rev, ref.path) ?? '')) ||
      (await (side === 'original' ? window.synote.readRev(c.vault, c.rev, ref.path) : window.synote.readBytes(c.vault, ref.path)).catch(() => null))
    // 文字一律转义：路径来自笔记正文，不能被渲染成链接或 HTML
    const text = (value: string) => ({ range, contents: [{ value: escapeMd(value) }] })
    if (!bytes) return text(i18next.t('imageMissing', { path: ref.path }))
    const ptr = parseLfsPointer(bytes)
    if (ptr) {
      // 只放行自己的命令（不用 isTrusted: true）；参数是悬停的位置，命令执行时按当前模型重新解析，不把路径塞进链接
      const value = lfsHoverMarkdown(i18next.t('lfsNotDownloaded', { size: sizeLabel(ptr.size), path: ref.path }), i18next.t('lfsDownload'), [side, pos.lineNumber, pos.column])
      return { range, contents: [{ value, isTrusted: { enabledCommands: ['synote.lfsDownload'] } }] }
    }
    if (bytes.length > MAX_IMAGE) return text(i18next.t('imageTooLarge'))
    // 缩略图：只有 base64 的 data URL，没有来自正文的文字，不转义；不可信（不放行任何命令）
    return { range, contents: [{ value: `![](${await dataUrl(bytes, imageMime(ref.path)!)}|width=240)` }] }
  },
})
