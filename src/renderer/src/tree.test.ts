import { expect, it } from 'vitest'
import { buildChildren, ROOT } from './tree'

it('groups entries by parent with folders first', () => {
  const kids = buildChildren([
    { path: 'a.md', dir: false },
    { path: 'b', dir: true },
    { path: 'b/c.md', dir: false },
    { path: 'b/d', dir: true },
  ])
  expect(kids.get(ROOT)).toEqual(['b', 'a.md'])
  expect(kids.get('b')).toEqual(['b/d', 'b/c.md'])
  expect(kids.get('b/d')).toEqual([])
})
