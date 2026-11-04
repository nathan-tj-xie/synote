// CM6 与 Monaco 的键位对照（ADR 0003「命令 → 键位」表）：CM6 用 @replit/codemirror-vscode-keymap，
// 这里把它的每个键（按平台展开、含 shift 变体）对到 Monaco 命令。纯数据 + 纯函数，不依赖 Monaco，便于单测
import type { KeyBinding } from '@codemirror/view'

// 键的规范写法：修饰键按 Ctrl-Alt-Shift-Cmd 排序，Mod 按平台换成 Cmd / Ctrl，单个字母小写；和弦用空格分开
const order = ['Ctrl', 'Alt', 'Shift', 'Cmd']
export function canon(spec: string, mac: boolean): string {
  return spec
    .split(' ')
    .map((chord) => {
      const parts = chord.split('-')
      // '-' 本身作键时会切出空串，这份键位表里没有，不处理
      const key = parts.pop()!
      const mods = parts.map((m) => (m === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : m === 'Meta' ? 'Cmd' : m))
      const sorted = order.filter((m) => mods.includes(m))
      return [...sorted, key.length === 1 ? key.toLowerCase() : key].join('-')
    })
    .join(' ')
}

// 一条 CM6 绑定在某平台上实际生效的键（Windows 用 win ?? key；mac 用 mac ?? key），有 shift 命令时再加上 Shift 变体
export function effectiveKeys(b: KeyBinding, mac: boolean): string[] {
  const spec = mac ? (b.mac ?? b.key) : (b.win ?? b.key)
  if (!spec) return []
  const keys = [canon(spec, mac)]
  if (b.shift) keys.push(canon(spec.replace(/([^ ]+)$/, 'Shift-$1'), mac))
  return keys
}

// cmd：Monaco 命令 id。register：由我们显式注册这条键位；不注册的是 Monaco 自带的（多半带 when 上下文，
// 比如只在查找框里生效的 Escape），只核对它确实存在。skip：两边都不用对齐的键，写明原因
export type Rule = { cmd: string; register?: true } | { skip: string }

const noCompletion = { skip: 'CM6 没有加载自动补全，这些键在正文里也不起补全作用；Monaco 同样没加载 suggest' }
const noLint = { skip: '两边都没有 lint / 诊断' }
// Monaco 的 diff editor 强制关掉两侧的折叠（diffEditorEditors.js 里写死 folding = false），VSCode 的 diff 也一样：
// 只折一侧会让左右对不齐。所以 diff 里没有折叠，正文（CM6）里照常可用
const noFoldInDiff = { skip: 'Monaco diff editor 不支持折叠（只折一侧会破坏左右对齐）' }

// 两个平台共用的部分，写法同 CM6（Mod = mac 的 ⌘ / 其他平台的 Ctrl）
const common: Record<string, Rule> = {
  'Ctrl-Space': noCompletion,
  'Mod-f': { cmd: 'actions.find' },
  Escape: { cmd: 'closeFindWidget' },
  'Alt-Enter': { cmd: 'editor.action.selectAllMatches' },
  'Mod-Alt-Enter': { cmd: 'editor.action.replaceAll' },
  'Ctrl-g': { cmd: 'editor.action.gotoLine' },
  'Mod-d': { cmd: 'editor.action.addSelectionToNextFindMatch' },
  'Mod-Shift-l': { cmd: 'editor.action.selectHighlights' },
  Enter: { skip: '换行由 Monaco 的文本输入处理，不是键位命令' },
  'Shift-Enter': { skip: '同 Enter：换行由 Monaco 的文本输入处理' },
  Tab: { cmd: 'tab' },
  'Shift-Tab': { cmd: 'outdent' },
  ArrowLeft: { cmd: 'cursorLeft' },
  'Shift-ArrowLeft': { cmd: 'cursorLeftSelect' },
  ArrowRight: { cmd: 'cursorRight' },
  'Shift-ArrowRight': { cmd: 'cursorRightSelect' },
  ArrowUp: { cmd: 'cursorUp' },
  'Shift-ArrowUp': { cmd: 'cursorUpSelect' },
  ArrowDown: { cmd: 'cursorDown' },
  'Shift-ArrowDown': { cmd: 'cursorDownSelect' },
  Home: { cmd: 'cursorHome' },
  'Shift-Home': { cmd: 'cursorHomeSelect' },
  End: { cmd: 'cursorEnd' },
  'Shift-End': { cmd: 'cursorEndSelect' },
  PageUp: { cmd: 'cursorPageUp' },
  'Shift-PageUp': { cmd: 'cursorPageUpSelect' },
  PageDown: { cmd: 'cursorPageDown' },
  'Shift-PageDown': { cmd: 'cursorPageDownSelect' },
  // Monaco 在 mac 上不绑 ⌘Home / ⌘End，补上
  'Mod-Home': { cmd: 'cursorTop', register: true },
  'Mod-Shift-Home': { cmd: 'cursorTopSelect', register: true },
  'Mod-End': { cmd: 'cursorBottom', register: true },
  'Mod-Shift-End': { cmd: 'cursorBottomSelect', register: true },
  'Shift-Alt-i': { cmd: 'editor.action.insertCursorAtEndOfEachLineSelected' },
  'Mod-a': { cmd: 'editor.action.selectAll' },
  Backspace: { cmd: 'deleteLeft' },
  'Shift-Backspace': { cmd: 'deleteLeft' },
  Delete: { cmd: 'deleteRight' },
  'Mod-Shift-k': { cmd: 'editor.action.deleteLines' },
  'Alt-ArrowDown': { cmd: 'editor.action.moveLinesDownAction' },
  'Alt-ArrowUp': { cmd: 'editor.action.moveLinesUpAction' },
  'Mod-l': { cmd: 'expandLineSelection' },
  'Mod-Shift-\\': { cmd: 'editor.action.jumpToBracket' },
  'Mod-[': { cmd: 'editor.action.outdentLines' },
  'Mod-]': { cmd: 'editor.action.indentLines' },
  'Mod-k Mod-0': noFoldInDiff,
  'Mod-k Mod-j': noFoldInDiff,
  'Mod-k Mod-c': { cmd: 'editor.action.addCommentLine' },
  'Mod-k Mod-u': { cmd: 'editor.action.removeCommentLine' },
  'Mod-/': { cmd: 'editor.action.commentLine' },
  'Shift-Alt-a': { cmd: 'editor.action.blockComment' },
  'Mod-z': { cmd: 'undo' },
  'Mod-Shift-z': { cmd: 'redo' },
  // Monaco 在 mac 上不绑 ⌘Y，补上
  'Mod-y': { cmd: 'redo', register: true },
  'Mod-u': { cmd: 'cursorUndo' },
  'Mod-Shift-m': noLint,
  F8: noLint,
}

const mac: Record<string, Rule> = {
  'Alt-ArrowLeft': { cmd: 'cursorWordLeft' },
  'Shift-Alt-ArrowLeft': { cmd: 'cursorWordLeftSelect' },
  'Alt-ArrowRight': { cmd: 'cursorWordEndRight' },
  'Shift-Alt-ArrowRight': { cmd: 'cursorWordEndRightSelect' },
  'Cmd-ArrowLeft': { cmd: 'cursorHome' },
  'Shift-Cmd-ArrowLeft': { cmd: 'cursorHomeSelect' },
  'Cmd-ArrowRight': { cmd: 'cursorEnd' },
  'Shift-Cmd-ArrowRight': { cmd: 'cursorEndSelect' },
  'Cmd-ArrowUp': { cmd: 'cursorTop' },
  'Shift-Cmd-ArrowUp': { cmd: 'cursorTopSelect' },
  'Cmd-ArrowDown': { cmd: 'cursorBottom' },
  'Shift-Cmd-ArrowDown': { cmd: 'cursorBottomSelect' },
  // mac 上 CM6 把 Ctrl-↑↓ 当翻页；Monaco 默认留给系统（调度中心），补上让两边一致
  'Ctrl-ArrowUp': { cmd: 'cursorPageUp', register: true },
  'Shift-Ctrl-ArrowUp': { cmd: 'cursorPageUpSelect', register: true },
  'Ctrl-ArrowDown': { cmd: 'cursorPageDown', register: true },
  'Shift-Ctrl-ArrowDown': { cmd: 'cursorPageDownSelect', register: true },
  'Cmd-Alt-ArrowUp': { cmd: 'editor.action.insertCursorAbove' },
  'Cmd-Alt-ArrowDown': { cmd: 'editor.action.insertCursorBelow' },
  'Alt-Backspace': { cmd: 'deleteWordLeft' },
  'Alt-Delete': { cmd: 'deleteWordRight' },
  'Cmd-Backspace': { cmd: 'deleteAllLeft' },
  'Cmd-Delete': { cmd: 'deleteAllRight' },
  // Emacs 风格的 Ctrl 键位，Monaco 在 mac 上也自带；Shift 变体（选择）没有，补上
  'Ctrl-b': { cmd: 'cursorLeft' },
  'Shift-Ctrl-b': { cmd: 'cursorLeftSelect', register: true },
  'Ctrl-f': { cmd: 'cursorRight' },
  'Shift-Ctrl-f': { cmd: 'cursorRightSelect', register: true },
  'Ctrl-p': { cmd: 'cursorUp' },
  'Shift-Ctrl-p': { cmd: 'cursorUpSelect', register: true },
  'Ctrl-n': { cmd: 'cursorDown' },
  'Shift-Ctrl-n': { cmd: 'cursorDownSelect', register: true },
  'Ctrl-a': { cmd: 'cursorLineStart' },
  'Shift-Ctrl-a': { cmd: 'cursorLineStartSelect' },
  'Ctrl-e': { cmd: 'cursorLineEnd' },
  'Shift-Ctrl-e': { cmd: 'cursorLineEndSelect' },
  'Ctrl-d': { cmd: 'deleteRight' },
  'Ctrl-h': { cmd: 'deleteLeft' },
  'Ctrl-k': { cmd: 'deleteAllRight' },
  'Ctrl-Alt-h': { cmd: 'deleteWordLeft', register: true },
  'Ctrl-o': { cmd: 'lineBreakInsert' },
  'Ctrl-t': { cmd: 'editor.action.transposeLetters' },
  'Ctrl-v': { cmd: 'cursorPageDown', register: true },
  'Alt-v': { cmd: 'cursorPageUp', register: true },
  'Shift-Alt-ArrowDown': { cmd: 'editor.action.copyLinesDownAction' },
  'Shift-Alt-ArrowUp': { cmd: 'editor.action.copyLinesUpAction' },
  'Cmd-Alt-[': noFoldInDiff,
  'Cmd-Alt-]': noFoldInDiff,
}

const win: Record<string, Rule> = {
  'Ctrl-ArrowLeft': { cmd: 'cursorWordLeft' },
  'Shift-Ctrl-ArrowLeft': { cmd: 'cursorWordLeftSelect' },
  'Ctrl-ArrowRight': { cmd: 'cursorWordEndRight' },
  'Shift-Ctrl-ArrowRight': { cmd: 'cursorWordEndRightSelect' },
  'Ctrl-Alt-ArrowUp': { cmd: 'editor.action.insertCursorAbove' },
  'Ctrl-Alt-ArrowDown': { cmd: 'editor.action.insertCursorBelow' },
  'Ctrl-Backspace': { cmd: 'deleteWordLeft' },
  'Ctrl-Delete': { cmd: 'deleteWordRight' },
  'Shift-Alt-ArrowDown': { cmd: 'editor.action.copyLinesDownAction' },
  'Shift-Alt-ArrowUp': { cmd: 'editor.action.copyLinesUpAction' },
  'Ctrl-Shift-[': noFoldInDiff,
  'Ctrl-Shift-]': noFoldInDiff,
}

// 某平台上的完整对照表，键已规范化
export function parity(isMac: boolean): Map<string, Rule> {
  const m = new Map<string, Rule>()
  for (const [k, r] of [...Object.entries(common), ...Object.entries(isMac ? mac : win)]) m.set(canon(k, isMac), r)
  return m
}

// CM6 键名 → Monaco KeyCode 的枚举名（只覆盖这份表里要注册的键）
const keyNames: Record<string, string> = {
  ArrowUp: 'UpArrow',
  ArrowDown: 'DownArrow',
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backspace: 'Backspace',
  Delete: 'Delete',
  '[': 'BracketLeft',
  ']': 'BracketRight',
}
export const monacoKeyName = (key: string): string | undefined =>
  keyNames[key] ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : undefined)

// Monaco 键位标签（ResolvedKeybinding.getUserSettingsLabel()，如 `cmd+k cmd+0`、`shift+alt+down`）→ 规范写法
const labelKeys: Record<string, string> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  space: 'Space',
}
const labelMods: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Cmd', meta: 'Cmd', win: 'Cmd' }
export function fromMonacoLabel(label: string, mac: boolean): string {
  return label
    .split(' ')
    .map((chord) => {
      const parts = chord.split('+')
      const key = parts.pop()!
      return [...parts.map((m) => labelMods[m] ?? m), labelKeys[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key)].join('-')
    })
    .map((c) => canon(c, mac))
    .join(' ')
}
