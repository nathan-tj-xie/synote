import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildInline, buildTables } from './livePreview'

const doc = [
  '# 标题', // 0
  '**粗** *斜* ~~删~~ `码` [名字](a.md) ![图](x.png)',
  '- 项目',
  '- [ ] 任务',
  '> 引用',
  '---',
  '```js',
  'let a = 1',
  '```',
  '',
  '| a | b |',
  '|:--|--:|',
  '| 1 | 2 |',
].join('\n')

// 光标放在第 cursorLine 行（从 1 起）行首
function state(cursorLine: number, text = doc) {
  const s0 = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] })
  const s = s0.update({ selection: { anchor: s0.doc.line(cursorLine).from } }).state
  ensureSyntaxTree(s, s.doc.length)
  return s
}

// 被替换（隐藏或换成 widget）掉的源码片段
function replaced(s: EditorState, set: DecorationSet): string[] {
  const out: string[] = []
  set.between(0, s.doc.length, (from, to, d) => {
    if (from < to && !d.spec.class && !d.spec.attributes) out.push(s.sliceDoc(from, to))
  })
  return out
}

describe('buildInline', () => {
  it('光标不在的行隐藏标记、链接只留文字', () => {
    const s = state(10)
    expect(replaced(s, buildInline(s, 0, s.doc.length))).toEqual(
      ['# ', '**', '**', '*', '*', '~~', '~~', '`', '`', '[', '](a.md)', '![图](x.png)', '-', '- ', '[ ]', '> ', '---', '```js', '```'],
    )
  })
  it('光标所在行显示源码', () => {
    const s = state(2)
    const r = replaced(s, buildInline(s, 0, s.doc.length))
    expect(r).toContain('# ')
    expect(r).not.toContain('**')
    expect(r).not.toContain('](a.md)')
  })
  it('光标在代码块里时围栏显示源码', () => {
    const s = state(8)
    const r = replaced(s, buildInline(s, 0, s.doc.length))
    expect(r).not.toContain('```js')
    expect(r).not.toContain('```')
  })
  it('只构建给定范围', () => {
    const s = state(10)
    expect(replaced(s, buildInline(s, 0, s.doc.line(1).to))).toEqual(['# '])
  })
})

describe('buildTables', () => {
  it('光标不在表格时整块替换，在表格里时显示源码', () => {
    const s = state(1)
    expect(replaced(s, buildTables(s))).toEqual([doc.slice(doc.indexOf('| a'))])
    const t = state(11)
    expect(replaced(t, buildTables(t))).toEqual([])
  })
})

describe('嵌套表格', () => {
  const nested = ['正文', '', '> | a | b |', '> |---|--:|', '> | 1 | 2 |', '', '- 项', '', '  | c |', '  |---|', '  | 3 |', ''].join('\n')
  it('引用、列表里的表格按整行替换（含 `> ` 和缩进）', () => {
    const s = state(1, nested)
    expect(replaced(s, buildTables(s))).toEqual(['> | a | b |\n> |---|--:|\n> | 1 | 2 |', '  | c |\n  |---|\n  | 3 |'])
  })
  it('光标在嵌套表格里时显示源码', () => {
    const s = state(4, nested)
    expect(replaced(s, buildTables(s))).toEqual(['  | c |\n  |---|\n  | 3 |'])
  })
})

describe('跨行链接与图片', () => {
  const r = (text: string) => {
    const s = state(1, `首行\n${text}`)
    return replaced(s, buildInline(s, 0, s.doc.length))
  }
  it('目标跨行的链接整个显示源码', () => expect(r('[名字](\na.md)')).toEqual([]))
  it('文字跨行的链接正常渲染：只藏标记和目标', () => expect(r('[跨\n行](a.md)')).toEqual(['[', '](a.md)']))
  it('跨行的图片整个显示源码', () => expect(r('![替\n代](a.png)')).toEqual([]))
  it('单行图片整块替换', () => expect(r('![图](a.png)')).toEqual(['![图](a.png)']))
})
