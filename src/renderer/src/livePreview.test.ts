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
    expect(srcs).toEqual(['a b.png', 'x.png', 'y.png'])
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


// 节点覆盖表（@lezer/markdown + markdownLanguage 的 GFM 等扩展）：光标在别处时，范围内的类型只显示渲染结果，
// 范围外的保持源码。每行：[类型, 正文, 行内插件替换掉的片段, blocks 替换掉的片段]
const coverage: [string, string, string[], string[]][] = [
  ['ATX 标题', '# 题 #', ['# ', ' #'], []],
  ['Setext 标题', '题\n===', ['==='], []],
  ['强调 / 加粗', '*a* **b** _c_', ['*', '*', '**', '**', '_', '_'], []],
  ['删除线', '~~a~~', ['~~', '~~'], []],
  ['行内代码', '`a`', ['`', '`'], []],
  ['链接', '[a](b.md "t")', ['[', '](b.md "t")'], []],
  ['引用式链接', '[a][r]\n\n[r]: b.md', ['[', '][r]'], []],
  ['图片', '![a](b.png)', ['![a](b.png)'], []],
  ['自动链接', '<https://x.com> <u@x.com>', ['<', '>', '<', '>'], []],
  ['GFM 裸链接', 'www.a.com https://b.com', [], []],
  ['反斜杠转义', '\\*a\\*', ['\\', '\\'], []],
  ['反斜杠硬换行', 'a\\\nb', ['\\'], []],
  ['空格硬换行', 'a  \nb', [], []],
  ['HTML 实体', '&amp; &#35;', ['&amp;', '&#35;'], []],
  ['无序列表', '- a\n* b', ['-', '*'], []],
  ['有序列表（编号保持原文）', '1. a', [], []],
  ['任务列表', '- [ ] a\n- [x] b', ['- ', '[ ]', '- ', '[x]'], []],
  ['引用', '> a', ['> '], []],
  ['分隔线', '***', ['***'], []],
  ['围栏代码块', '```js\nx\n```', ['```js', '```'], []],
  ['缩进代码块（只加底色）', '    x', [], []],
  ['表格', '| a |\n|---|\n| 1 |', [], ['| a |\n|---|\n| 1 |']],
  // 范围外，保持源码
  ['HTML 块', '<div>\n*a*\n</div>', [], []],
  ['行内 HTML / 注释 / 处理指令', '<b>t</b> <!-- c --> <?p?>', [], []],
  ['Emoji 短码', ':smile:', [], []],
  ['上标 / 下标', '^a^ ~b~', [], []],
  ['脚注', 'x[^1]\n\n[^1]: 注', [], []],
  ['引用定义行', '[r]: b.md', [], []],
  // 容器里跨行
  ['引用里跨行的强调', '> *a\n> b*', ['> ', '*', '> ', '*'], []],
  ['列表里跨行的删除线 / 行内代码', '- ~~a\n  b~~ `c\n  d`', ['-', '~~', '~~', '`', '`'], []],
  ['引用里跨行的链接', '> [跨\n> 行](a.md)', ['> '], ['[跨\n> 行](a.md)']],
  ['列表里跨行的图片', '- ![替\n  代](a.png)', ['-'], ['![替\n  代](a.png)']],
  ['引用里的 Setext 标题', '> 题\n> ===', ['> ', '> ==='], []],
  ['任务项里跨行的引用式链接', '- [ ] [跨\n  行][r]\n\n[r]: a.md', ['- ', '[ ]'], ['[跨\n  行][r]']],
]

describe('节点覆盖表', () => {
  for (const [name, text, inline, blocks] of coverage)
    it(name, () => {
      const s = state(1, `首行\n\n${text}`)
      const from = s.doc.line(3).from
      expect(replaced(s, buildInline(s, from, s.doc.length))).toEqual(inline)
      expect(replaced(s, buildBlocks(s))).toEqual(blocks)
    })

  // 被替换的范围换成什么：跨行链接 / 图片的文字去掉 `>` 和缩进，自动链接、裸链接加链接样式
  const widgets = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    const out: string[] = []
    for (const set of [buildInline(s, 0, s.doc.length), buildBlocks(s)])
      set.between(0, s.doc.length, (a, b, d) => {
        const w = d.spec.widget as { text?: string; alt?: string; entity?: string } | undefined
        if (w) out.push(w.text ?? w.alt ?? w.entity ?? '')
        else if (d.spec.class === 'cm-lp-link') out.push(`link:${s.sliceDoc(a, b)}`)
      })
    return out.filter(Boolean)
  }
  it('跨行链接的文字去掉引用标记和续行缩进', () => {
    expect(widgets('> [跨\n> 行](a.md)')).toEqual(['跨 行'])
    expect(widgets('> > [深\n> > 层](a.md)')).toEqual(['深 层'])
    expect(widgets('- [跨\n  行 \\]](a.md)')).toEqual(['跨 行 ]'])
    expect(widgets('> ![替\n> 代](a.png)')).toEqual(['替 代'])
  })
  it('自动链接只显示地址、裸链接加链接样式、实体保留原文交给浏览器解码', () => {
    expect(widgets('<https://x.com> www.a.com &amp;')).toEqual(['link:https://x.com', 'link:www.a.com', '&amp;'])
  })
})

// 链接目标与引用标签按 CommonMark 统一处理（审查第 5 轮）
describe('目标解码与标签匹配', () => {
  // 图片 widget 拿到的地址；链接的显示用 replaced 判断
  const srcs = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    const out: string[] = []
    buildInline(s, 0, s.doc.length).between(0, s.doc.length, (_a, _b, d) => {
      const w = d.spec.widget as { src?: string } | undefined
      if (w?.src !== undefined) out.push(w.src)
    })
    return out
  }
  it('内联图片：反转义、实体、尖括号', () => {
    expect(srcs('![x](a\\(1\\).png)')).toEqual(['a(1).png'])
    expect(srcs('![x](a&amp;b.png)')).toEqual(['a&b.png'])
    expect(srcs('![x](<a b.png>)')).toEqual(['a b.png'])
  })
  it('引用式图片：同样三例', () => {
    expect(srcs('![x][p]\n\n[p]: a\\(1\\).png')).toEqual(['a(1).png'])
    expect(srcs('![x][p]\n\n[p]: a&amp;b.png')).toEqual(['a&b.png'])
    expect(srcs('![x][p]\n\n[p]: <a b.png>')).toEqual(['a b.png'])
  })
  it('带转义标点的标签匹配自身定义（不反转义）', () => {
    const s = state(1, '首行\n\n[x][a\\*b] ![y][a\\*b]\n\n[a\\*b]: note.png')
    const r = replaced(s, buildInline(s, s.doc.line(3).from, s.doc.line(3).to))
    expect(r).toEqual(['[', '][a\\*b]', '![y][a\\*b]'])
    // 反转义后的 `[a*b]` 不是同一个标签
    const t = state(1, '首行\n\n[x][a*b]\n\n[a\\*b]: note.md')
    expect(replaced(t, buildInline(t, t.doc.line(3).from, t.doc.line(3).to))).toEqual([])
  })
  it('大小写、空白差异能匹配', () => {
    expect(srcs('![x][Foo  Bar]\n\n[foo bar]: a.png')).toEqual(['a.png'])
    expect(srcs('![x][ẞ]\n\n[ss]: b.png')).toEqual(['b.png']) // Unicode case fold：ẞ ≡ ss
    expect(srcs('![x][跨\n行]\n\n[跨 行]: c.png')).toEqual([])  // 跨行图片由 blocks 处理，行内插件不出
  })
})

