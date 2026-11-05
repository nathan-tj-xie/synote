import { describe, expect, it } from 'vitest'
import { relativeLink } from '../../shared/url'
import { bomOffset, decodeEntities, destination, imageAt, minimalEdit, normalizeLabel, resolveImage } from './diffUtil'

const apply = (a: string, e: ReturnType<typeof minimalEdit>) => (e ? a.slice(0, e.from) + e.insert + a.slice(e.to) : a)

describe('minimalEdit', () => {
  it('相同时为 null', () => expect(minimalEdit('abc', 'abc')).toBeNull())
  it('只替换中间不同的一段', () => expect(minimalEdit('# 标题\n正文\n', '# 标题\n改过的正文\n')).toEqual({ from: 5, to: 5, insert: '改过的' }))
  it('重复字符时前后缀不重叠', () => {
    for (const [a, b] of [['aaa', 'aa'], ['aa', 'aaaa'], ['', 'x'], ['x', ''], ['abba', 'aba']]) expect(apply(a, minimalEdit(a, b))).toBe(b)
  })
  // 😀 和 😁 的高代理码元相同：边界不能落在代理对中间（Monaco 会把范围扩到整个码点，插入文本却没扩）
  it('不切开代理对', () => {
    const isLow = (s: string, i: number) => /[\uDC00-\uDFFF]/.test(s[i] ?? '')
    for (const [a, b] of [['😀abc', '😁abc'], ['abc😀', 'abc😁'], ['x😀😀y', 'x😀😁y'], ['😀', '😀😀'], ['a😀', 'a']]) {
      const e = minimalEdit(a, b)!
      expect(apply(a, e)).toBe(b)
      expect([isLow(a, e.from), isLow(a, e.to)]).toEqual([false, false])
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(e.insert)).toBe(false)
    }
  })
})

describe('bomOffset', () => {
  it('前面多出的全是 BOM：返回个数', () => {
    expect(bomOffset('abc', 'abc')).toBe(0)
    expect(bomOffset('\uFEFFabc', 'abc')).toBe(1)
    expect(bomOffset('\uFEFF\uFEFFabc', '\uFEFFabc')).toBe(1)
    expect(bomOffset('\uFEFF\uFEFF', '')).toBe(2)
  })
  it('对不上为 null', () => {
    expect(bomOffset('abc', 'abcd')).toBeNull()
    expect(bomOffset('xabc', 'abc')).toBeNull()
    expect(bomOffset('\uFEFFabX', 'abc')).toBeNull()
    expect(bomOffset('\uFEFFxabc', 'abc')).toBeNull()
  })
})

describe('imageAt', () => {
  const line = '前文 ![图](../attachments/a%20b.png "标题") 中间 ![](https://x/y.png) ![](<c d.jpg>)'
  it('按笔记目录解析相对路径并解码', () => {
    const col = line.indexOf('![图]') + 3
    expect(imageAt(line, col, '日记/今天.md')).toMatchObject({ path: 'attachments/a b.png', start: line.indexOf('![图]') })
  })
  it('引用之外为 null', () => expect(imageAt(line, 0, '日记/今天.md')).toBeNull())
  it('外链为 null', () => expect(imageAt(line, line.indexOf('https'), 'a.md')).toBeNull())
  it('尖括号包住的路径', () => expect(imageAt(line, line.indexOf('<c'), 'a.md')?.path).toBe('c d.jpg'))
  it('越出笔记库为 null', () => expect(imageAt('![](../a.png)', 2, 'a.md')).toBeNull())
  it('以 / 开头按库根', () => expect(imageAt('![](/attachments/x.PNG)', 2, 'a/b/c.md')?.path).toBe('attachments/x.PNG'))
  it('不是图片为 null', () => expect(imageAt('![](note.md)', 2, 'a.md')).toBeNull())
})

describe('destination / normalizeLabel', () => {
  it('去尖括号、反转义、解码实体', () => {
    expect(destination('<a b.png>')).toBe('a b.png')
    expect(destination('a\\(1\\).png')).toBe('a(1).png')
    expect(destination('a&amp;b&#35;&#x41;.png')).toBe('a&b#A.png')
    expect(destination('a\\b.png')).toBe('a\\b.png') // 反斜杠后不是标点：保留
  })
  it('一次扫描：转义和实体产出的字符不再被重新解释', () => {
    expect(destination('a\\&amp;b.png')).toBe('a&amp;b.png') // 转义的 & 不再开启实体
    expect(destination('a&amp;b.png')).toBe('a&b.png')
    expect(destination('a\\\\&amp;b')).toBe('a\\&b') // 转义的反斜杠之后照常解实体
    expect(destination('&amp;lt;')).toBe('&lt;') // 实体解出的 & 不再开启实体
  })
  it('没有 DOM 时未知命名实体保留原文', () => expect(decodeEntities('&copy;')).toBe('&copy;'))
  it('标签：折叠空白、case fold、不反转义', () => {
    expect(normalizeLabel(' Foo \n Bar ')).toBe(normalizeLabel('foo bar'))
    expect(normalizeLabel('a\\]')).toBe('A\\]') // 不剥方括号：末尾的转义 ] 保留
    expect(normalizeLabel('ẞ')).toBe(normalizeLabel('ss'))
    expect(normalizeLabel('a\\*b')).not.toBe(normalizeLabel('a*b'))
  })
  it('diff 悬停的图片同样先解码', () => expect(imageAt('![](a\\(1\\).png)', 2, 'n.md')?.path).toBe('a(1).png'))
})

// 图片路径按段 decodeURIComponent（审查第 7 轮）
describe('resolveImage 百分号解码', () => {
  it('保留字符也解码', () => {
    expect(resolveImage('a%23b.png', '笔记/n.md')).toBe('笔记/a#b.png')
    expect(resolveImage('a%26b.png', 'n.md')).toBe('a&b.png')
    expect(resolveImage('a%20b%3Fc.png', 'n.md')).toBe('a b?c.png')
  })
  it('解出 / 的段整条拒绝，解出的 .. 越界也拒绝', () => {
    expect(resolveImage('%2e%2e%2fx.png', 'n.md')).toBeNull()
    expect(resolveImage('a%2Fb.png', 'n.md')).toBeNull()
    expect(resolveImage('%5c..%5cx.png', 'n.md')).toBeNull()
    expect(resolveImage('%2e%2e/x.png', 'n.md')).toBeNull()
    expect(resolveImage('%2e%2e/x.png', 'd/n.md')).toBe('x.png') // 库内的上一级照常
  })
  it('不是合法编码时按原文', () => expect(resolveImage('a%zz.png', 'n.md')).toBe('a%zz.png'))
})


describe('relativeLink', () => {
  it('按笔记所在目录计算', () => {
    expect(relativeLink('a.md', 'attachments/x.png')).toBe('attachments/x.png')
    expect(relativeLink('日记/今天.md', 'attachments/x.png')).toBe('../attachments/x.png')
    expect(relativeLink('a/b/c.md', 'a/x.png')).toBe('../x.png')
    expect(relativeLink('attachments/n.md', 'attachments/x.png')).toBe('x.png')
    // 首段带冒号时加 ./，否则会被当成 URI scheme
    expect(relativeLink('a.md', 'RFC:计划.md')).toBe('./RFC:计划.md')
    expect(relativeLink('x/a.md', 'x/RFC:计划.md')).toBe('./RFC:计划.md')
    expect(relativeLink('x/a.md', 'RFC:dir/b.md')).toBe('../RFC:dir/b.md')
  })
  it('编码空白和保留字符，非 ASCII 原样', () => {
    expect(relativeLink('我的 笔记/a.md', 'attachments/图 (1)#2%&?.png')).toBe('../attachments/图%20%281%29%232%25%26%3F.png')
  })
  it('解码后还原成原路径', () => {
    for (const [note, p] of [['x y/n.md', 'attachments/a b(1)#%&?c.png'], ['n.md', 'attachments/<中>.png']])
      expect(resolveImage(destination(relativeLink(note, p)), note)).toBe(p)
  })
})
