import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { buildBlocks, buildInline } from './livePreview'

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

describe('buildBlocks：表格', () => {
  it('光标不在表格时整块替换，在表格里时显示源码', () => {
    const s = state(1)
    expect(replaced(s, buildBlocks(s))).toEqual([doc.slice(doc.indexOf('| a'))])
    const t = state(11)
    expect(replaced(t, buildBlocks(t))).toEqual([])
  })
})

describe('嵌套表格', () => {
  const nested = ['正文', '', '> | a | b |', '> |---|--:|', '> | 1 | 2 |', '', '- 项', '', '  | c |', '  |---|', '  | 3 |', ''].join('\n')
  it('引用、列表里的表格按整行替换（含 `> ` 和缩进）', () => {
    const s = state(1, nested)
    expect(replaced(s, buildBlocks(s))).toEqual(['> | a | b |\n> |---|--:|\n> | 1 | 2 |', '  | c |\n  |---|\n  | 3 |'])
  })
  it('光标在嵌套表格里时显示源码', () => {
    const s = state(4, nested)
    expect(replaced(s, buildBlocks(s))).toEqual(['  | c |\n  |---|\n  | 3 |'])
  })
})

describe('跨行链接与图片', () => {
  const both = (text: string, cursorLine = 1) => {
    const s = state(cursorLine, `首行\n${text}\n\n[ref]: b.png`)
    return { inline: replaced(s, buildInline(s, 0, s.doc.length)), blocks: replaced(s, buildBlocks(s)) }
  }
  it('目标跨行的链接整段替换成文字，行内插件不碰', () =>
    expect(both('[名字](\na.md) 后')).toEqual({ inline: [], blocks: ['[名字](\na.md)'] }))
  it('文字跨行的链接整段替换', () => expect(both('[跨\n行](a.md)')).toEqual({ inline: [], blocks: ['[跨\n行](a.md)'] }))
  it('跨行的图片整段替换', () => expect(both('![替\n代](a.png)')).toEqual({ inline: [], blocks: ['![替\n代](a.png)'] }))
  it('嵌在强调里的跨行链接也替换', () => expect(both('**[跨\n行](a.md)**').blocks).toEqual(['[跨\n行](a.md)']))
  it('光标进入其中任意一行时整段显示源码', () => {
    expect(both('[名字](\na.md)', 2).blocks).toEqual([])
    expect(both('[名字](\na.md)', 3).blocks).toEqual([])
  })
  it('单行图片仍由行内插件整块替换', () => expect(both('![图](a.png)')).toEqual({ inline: ['![图](a.png)'], blocks: [] }))
})

describe('引用式链接与图片', () => {
  const doc2 = ['首行', '![图][Ref] ![b][] ![c] [文][ref] [没定义][nope] [普通]', '', '[ref]:  <a b.png> "t"', '[B]: x.png', '[c]: y.png', '> [跨]: z.png', ''].join('\n')
  it('按引用定义解析地址：图片整块替换，链接只藏标记；没有定义的保持源码', () => {
    const s = state(1, doc2)
    const set = buildInline(s, 0, s.doc.line(2).to)
    expect(replaced(s, set)).toEqual(['![图][Ref]', '![b][]', '![c]', '[', '][ref]'])
    // 图片 widget 拿到的是引用定义里的地址（尖括号写法、标签不分大小写）
    const srcs: string[] = []
    set.between(0, s.doc.length, (_a, _b, d) => {
      const w = d.spec.widget as { src?: string } | undefined
      if (w?.src !== undefined) srcs.push(w.src)
    })
    expect(srcs).toEqual(['<a b.png>', 'x.png', 'y.png'])
  })
  it('跨行的引用式图片也解析', () => {
    const s = state(1, '首行\n![跨\n行][跨]\n\n> [跨]: z.png')
    expect(replaced(s, buildBlocks(s))).toEqual(['![跨\n行][跨]'])
  })
})

describe('各种容器里的跨行链接与图片', () => {
  const blocksOf = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    return replaced(s, buildBlocks(s))
  }
  it('任务项', () => expect(blocksOf('- [ ] [跨\n  行](a.md)')).toEqual(['[跨\n  行](a.md)']))
  it('Setext 标题', () => expect(blocksOf('[跨\n行](a.md)\n===')).toEqual(['[跨\n行](a.md)']))
  it('引用、有序列表、嵌套列表、引用里的任务项', () => {
    expect(blocksOf('> ![替\n> 代](a.png)')).toEqual(['![替\n> 代](a.png)'])
    expect(blocksOf('1. [跨\n   行](a.md)')).toEqual(['[跨\n   行](a.md)'])
    expect(blocksOf('- 外\n  - [跨\n    行](a.md)')).toEqual(['[跨\n    行](a.md)'])
    expect(blocksOf('> - [ ] *[跨\n>   行](a.md)*')).toEqual(['[跨\n>   行](a.md)'])
  })
  it('代码块、HTML 块里的不是链接', () => {
    expect(blocksOf('```\n[跨\n行](a.md)\n```')).toEqual([])
    expect(blocksOf('<div>\n[跨\n行](a.md)\n</div>')).toEqual([])
  })
})

