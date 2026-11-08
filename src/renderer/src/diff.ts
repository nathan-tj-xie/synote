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
import { IUndoRedoService } from 'monaco-editor/platform/undoRedo/common/undoRedo.js'
import { IEditorWorkerService } from 'monaco-editor/editor/common/services/editorWorker.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { i18next } from '../../shared/i18n'
import { parseLfsPointer, sizeLabel } from '../../shared/lfs'
import { fromMonacoLabel, monacoKeyName, parity } from './keymap'
import { isMac } from './match'
import { useUi } from './store'
import { monacoColors, monacoRules } from './tokens'
import { tokens } from '../../shared/tokens'
import { bomOffset, dataUrl, escapeMd, imageAt, imageMime, lfsHoverMarkdown, MAX_IMAGE, minimalEdit, needsMergeReset } from './diffUtil'
import { type IEditorWorkerService as WorkerService, MergeDiffComputer } from './merge/model/diffComputer'
import { type IUndoRedoService as UndoService, MergeEditorModel, MergeEditorModelState } from './merge/model/mergeEditorModel'
import { waitForState } from './merge/observable'
import { MergeEditor } from './merge/view/mergeEditor'

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
// 冲突视图（#70）：移植自 VS Code 的三栏合并编辑器，结果栏和 diff 共用 modified 一侧的同步（cur.modified 就是结果栏的模型）
let mergeEd: MergeEditor | null = null
let diffDiv: HTMLElement | null = null
let conflictDiv: HTMLElement | null = null
// 合并编辑器上方工具条里切换共同祖先栏的三个按钮
let layoutButtons: HTMLButtonElement[] = []
// 冲突视图的三个输入（共同祖先 / 当前 / 传入）和由它们建起的合并模型
// ready：结果栏按合并重新初始化（resetResult）做完；没有要重置的时候立即完成
type Conflict = { base: monaco.editor.ITextModel; ours: monaco.editor.ITextModel; theirs: monaco.editor.ITextModel; model: MergeEditorModel; ready: Promise<void> }
// path：当前笔记（右侧）；base：左侧那个版本里笔记的路径（跨目录改名后与 path 不同），两侧的相对链接各按各的解析；
// conflict：显示的是冲突视图（original 不用）
let cur: { vault: string; path: string; rev: string; base: string; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel; conflict: Conflict | null } | null = null
// 冲突视图里正在编辑的那一侧编辑器
const modifiedEd = () => (cur?.conflict ? mergeEd!.resultEditor : editor!.getModifiedEditor())
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

let edits: { onEdit: (changes: Change[], quiet: boolean) => void; docNow: () => string } | null = null
// 正在重新初始化结果栏：这期间结果模型的改动写回 CM6 但不触发保存（见 resetResult）
let quiet = false
// docNow：CM6 视图里的最新正文，写回前后用来核对对齐；
// onComplete：点了"完成此文件合并"，unhandled 是还没处理的冲突数（大于 0 时调用方先确认）
// onEdit 的 quiet：这批改动来自结果栏的重新初始化，写回 CM6 但不保存
export function create(parent: HTMLElement, onEdit: (changes: Change[], quiet: boolean) => void, docNow: () => string, onComplete: (path: string, unhandled: number) => void) {
  edits = { onEdit, docNow }
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
    // 字体、字号和行距与 CM6 共用 token（ADR 0003）
    fontFamily: tokens.fontUi,
    fontSize: parseFloat(tokens.fontSizeEditor),
    lineHeight: parseFloat(tokens.lineHeightEditor),
    renderOverviewRuler: true,
    // 块级拣回（#9）：改动块旁的箭头把左侧那块应用到右侧，走 modified 编辑器的编辑，经 onEdit 写回 CM6。
    // 默认的 gutter 菜单在 standalone 里没有动作，还会顶掉箭头；只读（交接锁）时 Monaco 拒绝这类编辑
    renderGutterMenu: false,
    glyphMargin: true, // 箭头画在 glyph margin 里，standalone 默认没开
  })
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    theme: 'synote',
    wordWrap: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: tokens.fontUi,
    fontSize: parseFloat(tokens.fontSizeEditor),
    lineHeight: parseFloat(tokens.lineHeightEditor),
  }
  const t = i18next.t.bind(i18next)
  const bar = conflictDiv.appendChild(document.createElement('div'))
  bar.className = 'merge-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', t('mergeEditor'))
  const body = conflictDiv.appendChild(document.createElement('div'))
  body.className = 'merge-body'
  mergeEd = new MergeEditor(body, options, {
    result: { title: t('mergeResult'), remaining: (n) => (n ? t('mergeRemaining', { n }) : t('mergeNoneRemaining')), next: t('mergeNextConflict'), allHandled: t('mergeAllHandled') },
    base: { title: t('mergeBase'), compareWith: (title) => t('mergeCompareWith', { title }), compareWithTooltip: t('mergeCompareWithTooltip') },
    actions: (key, title = '') => t(`merge_${key}` as `merge_accept`, { title }),
  })
  const button = (label: string, className: string, onClick: () => void, title = label) => {
    const b = bar.appendChild(document.createElement('button'))
    b.textContent = label
    b.title = title
    b.className = className
    b.onclick = onClick
    return b
  }
  // 上一个 / 下一个未处理的冲突（上游的 GoToPreviousUnhandledConflict / GoToNextUnhandledConflict 命令）
  const unhandled = (m: Parameters<MergeEditorModel['isHandled']>[0]) => !cur!.conflict!.model.isHandled(m).get()
  button('↑', 'merge-nav', () => cur?.conflict && mergeEd!.viewModel.get()?.goToPreviousModifiedBaseRange(unhandled), t('mergePrevConflict')).setAttribute('aria-label', t('mergePrevConflict'))
  button('↓', 'merge-nav', () => cur?.conflict && mergeEd!.viewModel.get()?.goToNextModifiedBaseRange(unhandled), t('mergeNextConflict')).setAttribute('aria-label', t('mergeNextConflict'))
  const group = bar.appendChild(document.createElement('div'))
  group.className = 'merge-layout'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', t('mergeBase'))
  group.append(Object.assign(document.createElement('span'), { textContent: t('mergeBase') }))
  // 共同祖先栏：隐藏 / 顶部 / 中间（上游的 Show Base / Show Base Top / Show Base Center）
  const layouts = [
    [t('mergeBaseHidden'), () => mergeEd!.setLayout({ ...mergeEd!.layout, showBase: false })],
    [t('mergeBaseTop'), () => mergeEd!.toggleShowBaseTop()],
    [t('mergeBaseCenter'), () => mergeEd!.toggleShowBaseCenter()],
  ] as const
  layoutButtons = layouts.map(([label, apply]) => {
    const b = group.appendChild(document.createElement('button'))
    b.textContent = label
    b.onclick = () => {
      apply()
      syncBar()
    }
    return b
  })
  bar.appendChild(document.createElement('span')).className = 'merge-spacer'
  // 差异还没算完时未处理数还是 0：等模型初始化完再取，否则会不经确认就暂存带冲突标记的正文
  button(t('mergeComplete'), 'merge-complete', async () => {
    const c = cur
    if (!c?.conflict) return
    await c.conflict.model.onInitialized
    await c.conflict.ready
    if (cur === c) onComplete(c.path, c.conflict.model.unhandledConflictsCount.get())
  })
  syncBar()
  checkKeymap()
}

// 工具条的按下状态跟着当前布局
function syncBar() {
  const l = mergeEd!.layout
  const on = [!l.showBase, l.showBase && l.showBaseAtTop, l.showBase && !l.showBaseAtTop]
  layoutButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(on[i])))
}

// 结果栏（或 diff 的工作区一侧）模型的改动写回 CM6。听模型而不是编辑器：合并模型直接改结果模型（初始化合入非冲突改动、
// 接受某侧），那时编辑器可能还没挂上这个模型
function syncBack(m: monaco.editor.ITextModel, docNow: () => string, onEdit: (changes: Change[], quiet: boolean) => void) {
  return m.onDidChangeContent((e) => {
    if (applying || cur?.modified !== m) return
    const doc = docNow()
    // 改动前两边必须对齐（mirror 就是这次改动前的 Monaco 文本），否则这次输入不写回
    if (mirror === null || bomOffset(doc, mirror) !== off) return reset(doc)
    // 一次事件里的多处改动都以改动前的文档为坐标，正好对应 CM6 一个事务里的多个 change
    onEdit(e.changes.map((c) => ({ from: c.rangeOffset + off, to: c.rangeOffset + c.rangeLength + off, insert: c.text })), quiet)
    const now = docNow()
    if (!align(now)) reset(now)
  })
}

// 删除的笔记（S13）：工作区里已没有它，不进 CM6 / 标签页，单独开一个只读 diff：左 HEAD 正文、右空。返回销毁函数
export function showDeleted(parent: HTMLElement, head: string): () => void {
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
    fontFamily: tokens.fontUi,
    fontSize: parseFloat(tokens.fontSizeEditor),
    lineHeight: parseFloat(tokens.lineHeightEditor),
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
// conflict：改为显示冲突视图（#70），给出共同祖先 / 当前 / 传入三个 stage 的正文，rev / base / head 不用
export function show(vault: string, path: string, rev: string, base: string, head: string, doc: string, readOnly: boolean, conflict: { base: string; ours: string; theirs: string } | null = null) {
  hide()
  // 模型只是 CM6 正文的临时镜像，每次进入重建；EOL 固定为 LF，偏移才和 CM6 对得上（CM6 的 doc 只用 \n）
  const mk = (text: string) => {
    const m = monaco.editor.createModel(text, 'markdown')
    m.setEOL(monaco.editor.EndOfLineSequence.LF)
    return m
  }
  const modified = mk(doc)
  cur = { vault, path, rev, base, original: mk(head), modified, conflict: null }
  syncBack(modified, edits!.docNow, edits!.onEdit)
  if (!align(doc)) reset(doc)
  diffDiv!.hidden = !!conflict
  conflictDiv!.hidden = !conflict
  if (conflict) {
    const [b, ours, theirs] = [mk(conflict.base), mk(conflict.ours), mk(conflict.theirs)]
    const input = (textModel: monaco.editor.ITextModel, side: 'Ours' | 'Theirs') =>
      ({ textModel, title: i18next.t(`merge${side}`), description: i18next.t(`merge${side}Hint`), detail: undefined })
    // 照 VS Code 打开工作区里的冲突文件：结果就是工作区正文，里面还有 git 写的冲突标记时按合并结果重新初始化（非冲突改动合入、冲突块放共同祖先）
    const model = new MergeEditorModel(b, input(ours, 'Ours'), input(theirs, 'Theirs'), modified,
      new MergeDiffComputer(StandaloneServices.get<WorkerService>(IEditorWorkerService)),
      { resetResult: false }, StandaloneServices.get<UndoService>(IUndoRedoService))
    const c: Conflict = { base: b, ours, theirs, model, ready: Promise.resolve() }
    if (needsMergeReset(doc, [conflict.base, conflict.ours, conflict.theirs])) c.ready = resetResult(c)
    cur.conflict = c
    mergeEd!.setModel(model)
  } else editor!.setModel({ original: cur.original, modified: cur.modified })
  setReadOnly(readOnly)
}

// 照 VS Code 打开带冲突标记的文件：结果栏按合并重新初始化（非冲突改动合入、冲突块放共同祖先）。上游在模型构造时做
// （resetResult 选项），这里改由调用方做，好知道哪次改动来自重置：重置出来的内容只进 CM6、不写盘。用户接受或手改之前，
// 工作区里仍是 git 写的冲突标记，全库残留标记检查照样拦得住；关掉再打开会再重置一次，结果相同
async function resetResult(c: Conflict) {
  await waitForState(c.model.inputDiffComputingState, (s) => s === MergeEditorModelState.upToDate)
  if (cur?.conflict !== c) return
  // 输入的差异已算完，reset 里的等待只隔几个微任务，用户输入（宏任务）插不进来
  quiet = true
  try {
    await c.model.reset()
  } finally {
    quiet = false
  }
}

export function hide() {
  if (!cur) return
  editor!.setModel(null)
  mergeEd!.clearModel()
  if (cur.conflict) {
    cur.conflict.model.dispose()
    for (const m of [cur.conflict.base, cur.conflict.ours, cur.conflict.theirs]) m.dispose()
  }
  cur.original.dispose()
  cur.modified.dispose()
  cur = null
}

// CM6 那边的改动（外部重载）：按 CM6 坐标求最小替换，换算成 Monaco 坐标推过去，保住光标和撤销栈。
// 改动碰到 Monaco 藏起来的 BOM、或之前没对齐，就整体重设。
// 冲突视图里重载进来的正文带冲突标记（如笔记开着时 pull 出了冲突）：照打开带标记文件时的规则重新初始化结果栏
export function replace(doc: string) {
  if (!cur) return
  const c = cur.conflict
  if (c && needsMergeReset(doc, [c.base.getValue(), c.ours.getValue(), c.theirs.getValue()])) c.ready = resetResult(c)
  replaceText(doc)
}

function replaceText(doc: string) {
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
  mergeEd?.setReadOnly(on)
}
export const focus = () => cur && modifiedEd().focus()


// 能悬停看图的各栏：rev 是从哪个版本读图片（null 为工作区），note 是相对链接按哪篇笔记的路径解析。
// 冲突视图（#70）里当前一侧读 HEAD、传入一侧读 MERGE_HEAD，结果栏读工作区；共同祖先栏不悬停
type Side = 'original' | 'modified' | 'ours' | 'theirs'
function sideInfo(c: NonNullable<typeof cur>, side: Side): { model: monaco.editor.ITextModel; rev: string | null; note: string; editor: () => monaco.editor.ICodeEditor } | null {
  if (side === 'modified') return { model: c.modified, rev: null, note: c.path, editor: modifiedEd }
  if (!c.conflict) return side === 'original' ? { model: c.original, rev: c.rev, note: c.base, editor: () => editor!.getOriginalEditor() } : null
  if (side === 'ours') return { model: c.conflict.ours, rev: 'HEAD', note: c.path, editor: () => mergeEd!.input1Editor }
  if (side === 'theirs') return { model: c.conflict.theirs, rev: 'MERGE_HEAD', note: c.path, editor: () => mergeEd!.input2Editor }
  return null
}
const sideOf = (c: NonNullable<typeof cur>, model: monaco.editor.ITextModel) =>
  (['original', 'modified', 'ours', 'theirs'] as const).find((k) => sideInfo(c, k)?.model === model)

// 用户在悬停里点了"下载"的 LFS 图片（S17）：左侧按版本 smudge（对象顺带存进本地 LFS 存储，readRev 下次就能直接读到），
// 右侧（工作区）git lfs pull。下好后在原处重新弹出悬停。smudge 的结果也记一份，自定义了 lfs.storage 的仓库靠它
// shortcut: 只增不减，一次会话里下载的历史图片极多时再加上限
// 只按完整 oid 记：HEAD 会指向别的提交，按字符串 HEAD 记会把旧版本的图当成新的（HEAD 一侧下载后对象已在本地，readRev 直接命中）
const smudged = new Map<string, Uint8Array>()
const smudgeKey = (vault: string, rev: string, path: string) => (/^[0-9a-f]{40,64}$/.test(rev) ? `${vault}\0${rev}\0${path}` : null)
monaco.editor.registerCommand('synote.lfsDownload', async (_acc, side: Side, line: number, column: number) => {
  const c = cur
  const info = c && sideInfo(c, side)
  if (!c || !info) return
  const ref = imageAt(info.model.getLineContent(line), column - 1, info.note)
  if (!ref) return
  try {
    if (info.rev) {
      const b = await window.synote.lfsSmudge(c.vault, info.rev, ref.path)
      const key = smudgeKey(c.vault, info.rev, ref.path)
      if (b && key) smudged.set(key, b)
    } else await window.synote.lfsPull(c.vault, ref.path)
  } catch (e) {
    return useUi.getState().setError(String(e))
  }
  if (cur !== c) return
  const ed = info.editor()
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
    const side = c && sideOf(c, model)
    const info = side && sideInfo(c, side)
    if (!c || !side || !info) return null
    const ref = imageAt(model.getLineContent(pos.lineNumber), pos.column - 1, info.note)
    if (!ref) return null
    const range = new monaco.Range(pos.lineNumber, ref.start + 1, pos.lineNumber, ref.end + 1)
    const rev = info.rev
    const bytes =
      (rev && smudged.get(smudgeKey(c.vault, rev, ref.path) ?? '')) ||
      (await (rev ? window.synote.readRev(c.vault, rev, ref.path) : window.synote.readBytes(c.vault, ref.path)).catch(() => null))
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
