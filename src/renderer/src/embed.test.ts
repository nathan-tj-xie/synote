import { GFM, parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { blockMath, inlineMath } from './embed'

const md = parser.configure([GFM, inlineMath])

// 文本里被认成行内公式的源码片段
function maths(text: string): string[] {
  const out: string[] = []
  md.parse(text).iterate({ enter: (n) => void (n.name === 'InlineMath' && out.push(text.slice(n.from, n.to))) })
  return out
}

describe('行内公式定界（Pandoc / GitHub 规则）', () => {
  it('普通公式', () => {
    expect(maths('设 $x^2$ 与 $\\alpha$。')).toEqual(['$x^2$', '$\\alpha$'])
  })
  it('$5 到 $10 不是公式', () => {
    expect(maths('价格从 $5 到 $10 不等')).toEqual([])
    expect(maths('$5 and $10')).toEqual([])
  })
  it('开头 $ 后是空白、结尾 $ 前是空白都不算', () => {
    expect(maths('$ x$')).toEqual([])
    expect(maths('$x $')).toEqual([])
  })
  it('结尾 $ 后紧跟数字不算结尾', () => {
    expect(maths('$x$1')).toEqual([])
    // 跳过后紧跟数字的 $，接着找下一个合格的结尾
    expect(maths('$x$1 和 $y$')).toEqual(['$x$1 和 $y$'])
  })
  it('\\$ 是字面量', () => {
    expect(maths('\\$5 和 \\$10')).toEqual([])
    expect(maths('\\$x$')).toEqual([])
    expect(maths('$a\\$b$')).toEqual(['$a\\$b$'])
  })
  it('$$...$$ 写在行内也是公式，空的 $$ 不是', () => {
    expect(maths('前 $$x + y$$ 后')).toEqual(['$$x + y$$'])
    expect(maths('$$')).toEqual([])
  })
  it('代码里的 $ 不是公式', () => {
    expect(maths("`$x$` 和\n\n```\n$y$\n```")).toEqual([])
  })
  it('不跨行', () => {
    expect(maths('$a\nb$')).toEqual([])
  })
})

describe('blockMath', () => {
  it('三行写法与单行写法', () => {
    expect(blockMath(['$$', 'x^2', '$$'])).toEqual([{ first: 0, last: 2, src: 'x^2' }])
    expect(blockMath(['$$x$$'])).toEqual([{ first: 0, last: 0, src: 'x' }])
  })
  it('段落中间的块级公式，前后是正文', () => {
    expect(blockMath(['正文', '$$', 'a', '$$', '后文'])).toEqual([{ first: 1, last: 3, src: 'a' }])
  })
  it('空公式', () => {
    expect(blockMath(['$$', '$$'])).toEqual([{ first: 0, last: 1, src: '' }])
  })
  it('没闭合不算', () => {
    expect(blockMath(['$$', 'a'])).toEqual([])
    expect(blockMath(['$$a$$ b $$'])).toEqual([])
  })
})
