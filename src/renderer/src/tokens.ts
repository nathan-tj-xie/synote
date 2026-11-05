import { tokens } from '../../shared/tokens'

export function applyTokens(el: HTMLElement = document.documentElement) {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v)
}

// 同一份 token 生成 Monaco 主题的颜色（ADR 0005），其余沿用 vs-dark
export const monacoColors = (): Record<string, string> => ({
  'editor.background': tokens.bg,
  'editor.foreground': tokens.fg,
  'editorGutter.background': tokens.bg,
  'editorCursor.foreground': tokens.fg,
  'editor.selectionBackground': tokens.bgSelected,
  'editor.lineHighlightBackground': tokens.bgRaised,
  'editorLineNumber.foreground': tokens.fgMuted,
  'editorLineNumber.activeForeground': tokens.fg,
  'editorWidget.background': tokens.bgRaised,
  'editorWidget.border': tokens.border,
  'editorHoverWidget.background': tokens.bgRaised,
  'editorHoverWidget.border': tokens.border,
  'focusBorder': tokens.accent,
  'scrollbarSlider.background': `${tokens.border}99`,
  'diffEditor.insertedLineBackground': tokens.diffInserted,
  'diffEditor.insertedTextBackground': tokens.diffInserted,
  'diffEditor.removedLineBackground': tokens.diffRemoved,
  'diffEditor.removedTextBackground': tokens.diffRemoved,
  'diffEditor.border': tokens.border,
})

// 语法高亮色同样取这份 token（与 CM6 实时预览的代码块一致）；Monaco 规则的颜色不带 #
export const monacoRules = (): { token: string; foreground: string; fontStyle?: string }[] =>
  (
    [
      ['keyword', tokens.synKeyword],
      ['string', tokens.synString],
      ['number', tokens.synNumber],
      ['comment', tokens.synComment, 'italic'],
      ['type', tokens.synType],
      ['tag', tokens.synTag],
      ['attribute.name', tokens.synTag],
      ['predefined', tokens.synFunction],
    ] as const
  ).map(([token, c, fontStyle]) => ({ token, foreground: c.slice(1), ...(fontStyle && { fontStyle }) }))

