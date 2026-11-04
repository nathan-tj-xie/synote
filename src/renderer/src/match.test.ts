import { expect, it } from 'vitest'
import { formatKey, indexPaths, matchKey, searchPaths } from './match'

const ev = (key: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...m,
})

it('matches shortcuts exactly per platform', () => {
  expect(matchKey(ev('p', { metaKey: true }), 'Mod-p', true)).toBe(true)
  expect(matchKey(ev('p', { ctrlKey: true }), 'Mod-p', false)).toBe(true)
  expect(matchKey(ev('p', { ctrlKey: true }), 'Mod-p', true)).toBe(false)
  expect(matchKey(ev('P', { metaKey: true, shiftKey: true }), 'Mod-p', true)).toBe(false)
  expect(matchKey(ev('P', { metaKey: true, shiftKey: true }), 'Mod-Shift-p', true)).toBe(true)
  expect(formatKey('Mod-Shift-p', true)).toBe('⌘⇧P')
  expect(formatKey('Mod-Shift-p', false)).toBe('Ctrl+Shift+P')
})

it('updates quick-open results within 16 ms per keystroke on 10k files', () => {
  const paths = Array.from({ length: 10_000 }, (_, i) => `项目${i % 50}/子目录${i % 7}/笔记 ${i}.md`)
  const index = indexPaths(paths)
  const query = '项目3笔记 12'
  let worst = 0
  for (let i = 1; i <= query.length; i++) {
    // 每个按键取 3 次中最快的一次，排除 CI 机器上 GC 和调度的噪声
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const t = performance.now()
      searchPaths(query.slice(0, i), index)
      best = Math.min(best, performance.now() - t)
    }
    worst = Math.max(worst, best)
  }
  expect(searchPaths('笔记 1234', index)[0].id).toBe('项目34/子目录2/笔记 1234.md')
  expect(worst).toBeLessThan(16)
})
