import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { tableTrailingSpace } from './gfmTable'
import { buildBlocks, buildInline, livePreview } from './livePreview'

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
  // 带上 livePreview：buildInline 跳过 blocks 字段已整段替换的范围，和运行时一致
  const s0 = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage, extensions: [tableTrailingSpace] }), livePreview(null)] })
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
  ['引用里的 Setext 标题', '> 题\n> ===', ['> ', '> ', '==='], []],
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
  it('标签末尾是转义的 ]：简写、折叠、图片都匹配定义', () => {
    const s = state(1, '首行\n\n[a\\]] [a\\]][] ![a\\]]\n\n[a\\]]: b.png')
    // 两个链接都只藏方括号，显示文字里的转义反斜杠另由 Escape 藏掉（显示为 `a]`）；图片整块替换
    expect(replaced(s, buildInline(s, s.doc.line(3).from, s.doc.line(3).to)).sort()).toEqual(['[', ']', '[', '][]', '![a\\]]', '\\', '\\'].sort())
    expect(srcs('![a\\]]\n\n[a\\]]: b.png')).toEqual(['b.png'])
  })
  it('大小写、空白差异能匹配', () => {
    expect(srcs('![x][Foo  Bar]\n\n[foo bar]: a.png')).toEqual(['a.png'])
    expect(srcs('![x][ẞ]\n\n[ss]: b.png')).toEqual(['b.png']) // Unicode case fold：ẞ ≡ ss
    expect(srcs('![x][跨\n行]\n\n[跨 行]: c.png')).toEqual([])  // 跨行图片由 blocks 处理，行内插件不出
  })
})

// 容器行首标记逐行统一处理（审查第 6 轮）：光标移开后，引用里的各种块都不残留 `>`
describe('引用里的块不残留引用标记', () => {
  // 光标在首行时用户看到的文字：去掉替换范围（widget 记为 ▢）
  const visible = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    const cuts: [number, number, string][] = []
    for (const set of [buildInline(s, 0, s.doc.length), buildBlocks(s)])
      set.between(0, s.doc.length, (a, b, d) => void (a < b && !d.spec.class && !d.spec.attributes && cuts.push([a, b, d.spec.widget ? '▢' : ''])))
    cuts.sort((x, y) => x[0] - y[0])
    let out = ''
    let pos = 0
    for (const [a, b, w] of cuts) {
      if (a < pos) continue // 被更大的范围盖住
      out += s.sliceDoc(pos, a) + w
      pos = b
    }
    return (out + s.sliceDoc(pos)).split('\n').slice(2)
  }
  const noQuote = (lines: string[]) => expect(lines.filter((l) => /^\s*>/.test(l))).toEqual([])
  it('围栏代码块', () => {
    const v = visible('> ```js\n> let x = 1\n> ```')
    noQuote(v)
    expect(v).toEqual(['▢', 'let x = 1', '']) // 开围栏换成语言标签，闭围栏藏掉
  })
  it('缩进代码块（代码内的缩进保留）', () => {
    const v = visible('>     code\n>     more')
    noQuote(v)
    expect(v).toEqual(['    code', '    more'])
  })
  it('表格', () => noQuote(visible('> | a |\n> |---|\n> | 1 |')))
  it('Setext 标题', () => expect(visible('> 题\n> ===')).toEqual(['题', '']))
  it('嵌套引用里的代码块：只藏容器标记，代码里的 > 保留', () => {
    expect(visible('> > ```\n> > > x\n> > ```')).toEqual(['▢', '> x', ''])
  })
  it('引用里的列表续行：缩进不动', () => expect(visible('> - a\n>   b')).toEqual(['▢ a', '  b']))
  it('引用里的 ATX 标题', () => expect(visible('> # 题')).toEqual(['题']))
  it('列表里的引用：内层 > 也藏', () => {
    expect(visible('- > 引用')).toEqual(['▢ 引用'])
    expect(visible('1. > 引用')).toEqual(['1. 引用'])
    expect(visible('> - > 引用\n>   > 续')).toEqual(['▢ 引用', '  续'])
  })
  it('光标在这行时显示源码', () => {
    const s = state(4, '首行\n\n> ```js\n> let x = 1\n> ```')
    expect(replaced(s, buildInline(s, 0, s.doc.length))).toEqual([])
  })
})


// 生成式：随机组合 3 层以内的引用 / 有序列表 / 无序列表 / 任务项，里面放各种块（审查第 7 轮）。
// 光标不在其中时，用户可见文字里没有作为引用标记的 `>`（代码内容 `a > b` 里的除外）；光标所在行显示源码
describe('容器嵌套的生成式测试', () => {
  // mulberry32：固定种子，结果可复现
  let seed = 0x5eed23
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  // 容器：首行标记、续行前缀
  const containers = [
    { first: '> ', cont: '> ' },
    { first: '- ', cont: '  ' },
    { first: '1. ', cont: '   ' },
    { first: '- [ ] ', cont: '  ' },
  ] as const
  const blocks = [
    ['段落', ['p 文字 **粗**', '续行 *斜*']],
    ['围栏代码块', ['```js', 'a > b', '```']],
    ['表格', ['| h | i | j |', '|---|:-:|--:|', '|  | c | |']],
    ['Setext 标题', ['题', '===']],
    ['ATX 标题', ['## 题']],
  ] as const

  for (let i = 0; i < 1200; i++) {
    const depth = 1 + Math.floor(rand() * 3)
    const stack = Array.from({ length: depth }, () => pick(containers))
    const [kind, body] = pick(blocks)
    // 任务标记后面只能是段落文字：`- [ ] > x`、`- [ ] ```js` 里的 `>`、围栏都是普通文字，不是嵌套块。
    // 所以任务项只作最内层，且只放段落
    const task = stack.findIndex((c) => c.first === '- [ ] ')
    if (task !== -1 && (task !== depth - 1 || kind !== '段落')) continue
    // 表格的每一行（含对齐行）随机加行尾空白（空格 / Tab / 混合）。行首空白会改变缩进、破坏容器结构，所以只加行尾
    const pad = () => pick(['', ' ', '  ', '\t', ' \t '])
    const lines = body.map((text, j) => stack.map((c) => (j === 0 ? c.first : c.cont)).join('') + text + (kind === '表格' ? pad() : ''))
    const name = `#${i} ${stack.map((c) => c.first.trim()).join(' ')} ${kind}`
    if (!stack.some((c) => c.first === '> ')) continue
    it(name, () => {
      const src = `首行\n\n${lines.join('\n')}`
      // 光标在首行：可见文字里不应有引用标记
      const s = state(1, src)
      const cuts: [number, number][] = []
      for (const set of [buildInline(s, 0, s.doc.length), buildBlocks(s)])
        set.between(0, s.doc.length, (a, b, d) => void (a < b && !d.spec.class && !d.spec.attributes && cuts.push([a, b])))
      cuts.sort((x, y) => x[0] - y[0])
      let shown = ''
      let pos = 0
      for (const [a, b] of cuts) {
        if (a < pos) continue
        shown += s.sliceDoc(pos, a)
        pos = Math.max(pos, b)
      }
      shown += s.sliceDoc(pos)
      expect(shown.replace(/a > b/g, '')).not.toContain('>')
      // 列表项首行就是表格：生成的所有容器都从这一行开始，首行上的列表标记都要由表格 widget 画出来（不被整行替换吞掉）
      if (kind === '表格') {
        const widgets: string[][] = []
        buildBlocks(s).between(0, s.doc.length, (_a, _b, d) => void widgets.push((d.spec.widget as { markers: string[] }).markers))
        expect(widgets).toEqual([stack.filter((c) => c.first !== '> ').map((c) => (c.first === '- ' ? '•' : '1.'))])
        const rows: string[][][] = []
        buildBlocks(s).between(0, s.doc.length, (_a, _b, d) => void rows.push((d.spec.widget as { rows: string[][] }).rows))
        expect(rows).toEqual([[['h', 'i', 'j'], ['', 'c', '']]]) // 空单元格不丢、不错列
      }
      // 光标在块的第一行：这一行原样显示源码
      const t = state(3, src)
      const hidden: string[] = []
      for (const set of [buildInline(t, 0, t.doc.length), buildBlocks(t)])
        set.between(t.doc.line(3).from, t.doc.line(3).to, (a, b, d) => void (a < b && !d.spec.class && !d.spec.attributes && hidden.push(t.sliceDoc(a, b))))
      expect(hidden).toEqual([])
    })
  }
})

// 列表项首行就是表格（审查第 8 轮）：列表标记在表格替换的整行里，由表格 widget 画出来
describe('列表项以表格开头', () => {
  const markers = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    const out: string[][] = []
    buildBlocks(s).between(0, s.doc.length, (_a, _b, d) => void out.push((d.spec.widget as { markers: string[] }).markers))
    return out
  }
  it('有序 / 无序 / 嵌套', () => {
    expect(markers('7. | a |\n   |---|\n   | b |')).toEqual([['7.']])
    expect(markers('- | a |\n  |---|\n  | b |')).toEqual([['•']])
    expect(markers('- 1. | a |\n     |---|\n     | b |')).toEqual([['•', '1.']])
    expect(markers('> - | a |\n>   |---|\n>   | b |')).toEqual([['•']])
  })
  it('表格在列表项续行上时不画标记', () => expect(markers('- 项\n\n  | a |\n  |---|\n  | b |')).toEqual([[]]))
})

// 表格空单元格（审查第 9 轮）：按 `|` 切分，按表头列数补齐 / 截断
describe('表格单元格', () => {
  const table = (text: string) => {
    const s = state(1, `首行\n\n${text}`)
    const out: { rows: string[][]; align: (string | null)[] }[] = []
    buildBlocks(s).between(0, s.doc.length, (_a, _b, d) => void out.push(d.spec.widget as { rows: string[][]; align: (string | null)[] }))
    return out.map((w) => ({ rows: w.rows, align: w.align }))
  }
  it('中间空', () => expect(table('| a | b | c |\n|---|---|---|\n| | x | |')[0].rows).toEqual([['a', 'b', 'c'], ['', 'x', '']]))
  it('首尾空', () => expect(table('a | b | c\n--|---|--\n| | x | |')[0].rows).toEqual([['a', 'b', 'c'], ['', 'x', '']]))
  // GFM：行首、行尾的 | 只是可省略的边界，不是空单元格
  it('省略行首行尾的 |', () => expect(table('a | b | c\n--|---|--\n | x |\nx | y')[0].rows).toEqual([['a', 'b', 'c'], ['x', '', ''], ['x', 'y', '']]))
  it('空表头', () => expect(table('| | b |\n|---|---|\n| 1 | 2 |')[0].rows).toEqual([['', 'b'], ['1', '2']]))
  it('行比表头少列补空、多列截断', () =>
    expect(table('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')[0].rows).toEqual([['a', 'b'], ['1', ''], ['1', '2']]))
  it('行首 / 行尾带空格、Tab、混合空白', () => {
    expect(table('| a | b |  \n|---|---|\n| 1 | 2 |')[0].rows).toEqual([['a', 'b'], ['1', '2']])
    expect(table('| a | b |\t\n|---|---|\n| 1 | 2 | \t ')[0].rows).toEqual([['a', 'b'], ['1', '2']])
    expect(table('  | a | b |\n |---|---|\n\t| 1 | 2 |')[0].rows).toEqual([['a', 'b'], ['1', '2']])
    expect(table('| a | b | \t\n|---|---|\n| | x |  ')[0].rows).toEqual([['a', 'b'], ['', 'x']]) // 末尾的空单元格仍在
  })
  // 对齐行带行尾空白（gfmTable.ts 修正了 @lezer/markdown 的这个 bug）
  it('对齐行带行尾空格、Tab、两者', () => {
    for (const tail of [' ', '  ', '\t', ' \t', '\t '])
      expect(table(`| a | b |\n|---|:-:|${tail}\n| 1 | 2 |`)).toEqual([{ rows: [['a', 'b'], ['1', '2']], align: [null, 'center'] }])
    expect(table('a | b\n--|-- \n1 | 2')[0].rows).toEqual([['a', 'b'], ['1', '2']]) // 省略首尾 |
    expect(table('> | a |\n> |---|\t\n> | 1 |')[0].rows).toEqual([['a'], ['1']]) // 引用里
    expect(table('前面的段落\n| a |\n|---| \n| 1 |')[0].rows).toEqual([['a'], ['1']]) // 打断段落
  })
  it('转义的 | 不切分', () => expect(table('| a | b |\n|---|---|\n| x \\| y | z |')[0].rows).toEqual([['a', 'b'], ['x | y', 'z']]))
  it('对齐按列应用', () => expect(table('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')[0].align).toEqual(['left', 'center', 'right']))
})

