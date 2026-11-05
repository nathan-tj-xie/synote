import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isHidden, realInVault, resolveInVault, scanEntries, uniqueNoteName } from './vault'

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

  // Windows 上建符号链接需要管理员或开发者模式，CI 跳过
  it.skipIf(process.platform === 'win32')('rejects symlinks that point outside the vault', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'synote-'))
    const root = path.join(base, 'vault')
    mkdirSync(path.join(root, 'attachments'), { recursive: true })
    mkdirSync(path.join(base, 'outside'))
    writeFileSync(path.join(base, 'outside', 'secret.png'), 'x')
    writeFileSync(path.join(root, 'attachments', 'a.png'), 'x')
    symlinkSync(path.join(base, 'outside', 'secret.png'), path.join(root, 'attachments', 'evil.png'))
    symlinkSync(path.join(base, 'outside'), path.join(root, 'linkdir'))
    symlinkSync(path.join(root, 'attachments', 'a.png'), path.join(root, 'inside.png'))
    await expect(realInVault(root, 'attachments/evil.png')).rejects.toThrow('outside vault')
    await expect(realInVault(root, 'linkdir/secret.png')).rejects.toThrow('outside vault')
    await expect(realInVault(root, '../outside/secret.png')).rejects.toThrow('outside vault')
    // 库内的链接照常可读；库根自身是符号链接也不误伤
    expect(await realInVault(root, 'inside.png')).toMatch(/a\.png$/)
    symlinkSync(root, path.join(base, 'alias'))
    expect(await realInVault(path.join(base, 'alias'), 'attachments/a.png')).toMatch(/a\.png$/)
  })
})
