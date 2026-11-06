import { describe, expect, it } from 'vitest'
import { hasConflictMarkers, parseConflicts, resolveConflict } from './conflicts'

const two = ['前', '<<<<<<< HEAD', '本地 1', '本地 2', '=======', '远端', '>>>>>>> origin/main', '中', '<<<<<<< HEAD', '=======', '只有远端', '>>>>>>> origin/main', '后', ''].join('\n')

describe('parseConflicts', () => {
  it('按行号（从 1 起）列出每个冲突块的 ours / theirs 范围', () => {
    expect(parseConflicts(two)).toEqual([
      { start: 2, base: null, mid: 5, end: 7, ours: '本地 1\n本地 2\n', theirs: '远端\n' },
      { start: 9, base: null, mid: 10, end: 12, ours: '', theirs: '只有远端\n' },
    ])
  })

  it('diff3 风格（||||||| 段）：ours 不含 base', () => {
    const t = ['<<<<<<< HEAD', '本地', '||||||| base', '原来', '=======', '远端', '>>>>>>> x'].join('\n')
    expect(parseConflicts(t)).toEqual([{ start: 1, base: 3, mid: 5, end: 7, ours: '本地\n', theirs: '远端\n' }])
  })

  it('不完整的块、setext 标题的 ======= 不算冲突块；CRLF 也能识别', () => {
    expect(parseConflicts('标题\n=======\n正文\n')).toEqual([])
    expect(parseConflicts('<<<<<<< HEAD\na\n=======\nb\n')).toEqual([])
    expect(parseConflicts('<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> x\r\n')).toMatchObject([{ start: 1, mid: 3, end: 5, ours: 'a\r\n', theirs: 'b\r\n' }])
  })
})

describe('resolveConflict', () => {
  it('接受当前 / 传入 / 两者：只替换这一块，其余原样保留', () => {
    const [a, b] = parseConflicts(two)
    expect(resolveConflict(two, a, 'ours')).toBe(two.replace('<<<<<<< HEAD\n本地 1\n本地 2\n=======\n远端\n>>>>>>> origin/main\n', '本地 1\n本地 2\n'))
    expect(resolveConflict(two, a, 'theirs')).toBe(two.replace('<<<<<<< HEAD\n本地 1\n本地 2\n=======\n远端\n>>>>>>> origin/main\n', '远端\n'))
    expect(resolveConflict(two, b, 'both')).toBe(two.replace('<<<<<<< HEAD\n=======\n只有远端\n>>>>>>> origin/main\n', '只有远端\n'))
    const all = resolveConflict(resolveConflict(two, b, 'theirs'), a, 'both')
    expect(all).toBe('前\n本地 1\n本地 2\n远端\n中\n只有远端\n后\n')
    expect(hasConflictMarkers(all)).toBe(false)
  })

  it('块在文末且没有结尾换行', () => {
    const t = 'x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> y'
    expect(resolveConflict(t, parseConflicts(t)[0], 'theirs')).toBe('x\nb\n')
  })
})

describe('hasConflictMarkers', () => {
  it('任何一行起止标记都算（手改到一半、只删了一半标记也不当作已解决）', () => {
    expect(hasConflictMarkers(two)).toBe(true)
    expect(hasConflictMarkers('a\n>>>>>>> origin/main\n')).toBe(true)
    expect(hasConflictMarkers('<<<<<<<\n')).toBe(true)
    expect(hasConflictMarkers('a\n||||||| base\n')).toBe(true)
  })
  it('setext 标题、引用、行中间的箭头不算', () => {
    expect(hasConflictMarkers('标题\n=======\n> 引用\n>>>> 嵌套引用\n文字 <<<<<<< 中间\n<<<<<<<<< 八个\n')).toBe(false)
  })
})
