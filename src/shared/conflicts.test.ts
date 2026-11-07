import { describe, expect, it } from 'vitest'
import { hasConflictMarkers } from './conflicts'

const two = ['前', '<<<<<<< HEAD', '本地 1', '本地 2', '=======', '远端', '>>>>>>> origin/main', '中', '<<<<<<< HEAD', '=======', '只有远端', '>>>>>>> origin/main', '后', ''].join('\n')

describe('hasConflictMarkers', () => {
  it('任何一行起止标记都算（手改到一半、只删了一半标记也不当作已解决）', () => {
    expect(hasConflictMarkers(two)).toBe(true)
    expect(hasConflictMarkers('a\n>>>>>>> origin/main\n')).toBe(true)
    expect(hasConflictMarkers('<<<<<<<\n')).toBe(true)
    expect(hasConflictMarkers('a\n||||||| base\n')).toBe(true)
  })
  it('setext 标题、引用、行中间的箭头不算', () => {
    expect(hasConflictMarkers('标题\n=======\n> 引用\n>>>> 嵌套引用\n文字 <<<<<<< 中间\n<<<<<<x\n')).toBe(false)
  })
  it('.gitattributes 设了更长的 conflict-marker-size 也认得', () => {
    const t = '<<<<<<<<< HEAD\na\n=========\nb\n>>>>>>>>> x\n'
    expect(hasConflictMarkers(t)).toBe(true)
  })
})
