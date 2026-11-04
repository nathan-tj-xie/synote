import { describe, expect, it } from 'vitest'
import { imageAt, minimalEdit } from './diffUtil'

const apply = (a: string, e: ReturnType<typeof minimalEdit>) => (e ? a.slice(0, e.from) + e.insert + a.slice(e.to) : a)

describe('minimalEdit', () => {
  it('相同时为 null', () => expect(minimalEdit('abc', 'abc')).toBeNull())
  it('只替换中间不同的一段', () => expect(minimalEdit('# 标题\n正文\n', '# 标题\n改过的正文\n')).toEqual({ from: 5, to: 5, insert: '改过的' }))
  it('重复字符时前后缀不重叠', () => {
    for (const [a, b] of [['aaa', 'aa'], ['aa', 'aaaa'], ['', 'x'], ['x', ''], ['abba', 'aba']]) expect(apply(a, minimalEdit(a, b))).toBe(b)
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
