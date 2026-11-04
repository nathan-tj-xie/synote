import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isHidden, resolveInVault, scanEntries, uniqueNoteName } from './vault'

describe('vault', () => {
  it('scans entries and hides attachments/ and dotfiles', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'synote-'))
    for (const d of ['日记', 'attachments', '.git', '.synote', '项目/sub']) mkdirSync(path.join(root, d), { recursive: true })
    for (const f of ['a.md', '日记/1.md', 'attachments/x.png', '.git/HEAD', '项目/sub/b.md', '项目/attachments.md'])
      writeFileSync(path.join(root, f), '')
    const paths = (await scanEntries(root)).map((e) => `${e.path}${e.dir ? '/' : ''}`)
    expect(paths.sort()).toEqual(['a.md', '日记/', '日记/1.md', '项目/', '项目/attachments.md', '项目/sub/', '项目/sub/b.md'].sort())
  })

  it('only hides top-level attachments', () => {
    expect(isHidden('attachments/a.png')).toBe(true)
    expect(isHidden('notes/attachments/a.png')).toBe(false)
    expect(isHidden('notes/.obsidian/x')).toBe(true)
  })

  it('rejects paths outside the vault', () => {
    expect(() => resolveInVault('/v', '../etc/passwd')).toThrow()
    expect(() => resolveInVault('/v', '/etc/passwd')).toThrow()
    expect(() => resolveInVault('/v', '')).toThrow()
    expect(resolveInVault('/v', 'a/b.md')).toBe(path.resolve('/v/a/b.md'))
  })

  it('picks the first free untitled name', () => {
    expect(uniqueNoteName(new Set(), '', '未命名')).toBe('未命名.md')
    expect(uniqueNoteName(new Set(['d/未命名.md', 'd/未命名 1.md']), 'd', '未命名')).toBe('d/未命名 2.md')
  })
})
