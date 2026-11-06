import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachmentName, isHidden, numberedName, realInVault, realParentInVault, resolveInVault, saveAttachment, scanEntries, uniqueNoteName, writeTarget } from './vault'

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

  // 写入、新建、回收：父目录被换成指向库外的链接时都拒绝；回收库内指向库外的链接只移走链接本身
  it.skipIf(process.platform === 'win32')('write / create / trash stay inside the real vault', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'synote-'))
    const root = path.join(base, 'vault')
    const outside = path.join(base, 'outside')
    mkdirSync(path.join(root, 'a'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(path.join(root, 'a', 'n.md'), 'in')
    writeFileSync(path.join(outside, 'n.md'), 'out')
    expect(await writeTarget(root, 'a/n.md')).toMatch(/n\.md$/)
    // 打开 a/n.md 之后，目录 a 被换成指向库外的链接
    rmSync(path.join(root, 'a'), { recursive: true })
    symlinkSync(outside, path.join(root, 'a'))
    await expect(writeTarget(root, 'a/n.md')).rejects.toThrow('outside vault') // 保存
    await expect(realParentInVault(root, 'a/未命名.md')).rejects.toThrow('outside vault') // 新建
    await expect(realParentInVault(root, 'a/n.md')).rejects.toThrow('outside vault') // 回收
    expect(readFileSync(path.join(outside, 'n.md'), 'utf8')).toBe('out')

    // 末级本身是指向库外的链接：不能经它写，悬空的也不行；回收时拿到的是链接本身
    symlinkSync(path.join(outside, 'n.md'), path.join(root, 'link.md'))
    symlinkSync(path.join(outside, 'missing.md'), path.join(root, 'dangling.md'))
    await expect(writeTarget(root, 'link.md')).rejects.toThrow('outside vault')
    await expect(writeTarget(root, 'dangling.md')).rejects.toThrow()
    const victim = await realParentInVault(root, 'link.md')
    expect(lstatSync(victim).isSymbolicLink()).toBe(true)
    unlinkSync(victim) // 相当于 shell.trashItem 移走这一项
    expect(existsSync(path.join(root, 'link.md'))).toBe(false)
    expect(readFileSync(path.join(outside, 'n.md'), 'utf8')).toBe('out')
    // 新文件：父目录在库内即可
    expect(await writeTarget(root, 'new.md')).toMatch(/new\.md$/)
  })

  it('names attachments per #8', () => {
    expect(attachmentName(null, new Date(2026, 0, 2, 3, 4, 5))).toBe('image-20260102-030405.png')
    expect(attachmentName('my doc  v2.pdf', new Date())).toBe('my-doc--v2.pdf')
    expect(attachmentName('../../etc/passwd', new Date())).toBe('passwd') // 只取末段
    expect(attachmentName('a\\b c.png', new Date())).toBe('b-c.png')
    expect(attachmentName('..', new Date())).toBe('attachment')
    expect(numberedName('a.png', 0)).toBe('a.png')
    expect(numberedName('a.png', 2)).toBe('a-2.png')
    expect(numberedName('a.tar.gz', 1)).toBe('a.tar-1.gz')
    expect(numberedName('README', 1)).toBe('README-1')
  })

  it('saves attachments: reuses same content, numbers clashes, never overwrites', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'synote-'))
    const png = new Uint8Array([1, 2, 3])
    expect(await saveAttachment(root, 'a.png', png)).toBe('attachments/a.png') // attachments/ 不存在时自动建
    expect(await saveAttachment(root, 'b.png', png)).toBe('attachments/a.png') // 名字不同、内容相同：复用
    expect(await saveAttachment(root, 'a.png', new Uint8Array([3, 2, 1]))).toBe('attachments/a-1.png') // 同大小不同内容
    expect(await saveAttachment(root, 'a.png', new Uint8Array([9]))).toBe('attachments/a-2.png')
    expect(await saveAttachment(root, 'a.png', new Uint8Array([3, 2, 1]))).toBe('attachments/a-1.png')
    expect([...readFileSync(path.join(root, 'attachments/a.png'))]).toEqual([1, 2, 3])
    expect(readdirSync(path.join(root, 'attachments')).sort()).toEqual(['a-1.png', 'a-2.png', 'a.png'])
  })

  // S17：工作区里是 LFS 指针（内容没下载）的附件，用指针的 oid（即内容的 SHA-256）和大小去重，不再写一份
  it('reuses an LFS pointer whose oid and size match the new content', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'synote-'))
    mkdirSync(path.join(root, 'attachments'))
    const big = new Uint8Array(5000).fill(7)
    const oid = createHash('sha256').update(big).digest('hex')
    const ptr = (o: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${size}\n`
    writeFileSync(path.join(root, 'attachments/p.png'), ptr(oid, 5000))
    writeFileSync(path.join(root, 'attachments/q.png'), ptr('0'.repeat(64), 5000))
    expect(await saveAttachment(root, 'new.png', big)).toBe('attachments/p.png')
    expect(await saveAttachment(root, 'other.png', new Uint8Array(5000).fill(8))).toBe('attachments/other.png') // oid 不同
    // 指针文本本身被当作新内容粘贴进来时，按普通内容比较（和指针文件逐字节相同）
    expect(await saveAttachment(root, 'x.png', new TextEncoder().encode(ptr(oid, 5000)))).toBe('attachments/p.png')
    expect(readFileSync(path.join(root, 'attachments/p.png'), 'utf8')).toBe(ptr(oid, 5000)) // 指针原样不动
  })

  it.skipIf(process.platform === 'win32')('refuses an attachments/ that links outside the vault', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'synote-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'synote-out-'))
    symlinkSync(outside, path.join(root, 'attachments'))
    await expect(saveAttachment(root, 'a.png', new Uint8Array([1]))).rejects.toThrow('outside vault')
    expect(readdirSync(outside)).toEqual([])
  })
})
