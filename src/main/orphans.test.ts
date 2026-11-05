import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Git } from './git'
import { attachmentTarget, checkOrphans, isAttachmentPath, removeOrphans } from './orphans'

function vault(files: Record<string, string>) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-orphans-'))
  const root = path.join(base, 'vault')
  mkdirSync(root)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    writeFileSync(path.join(root, p), c)
  }
  return { base, root }
}

const rels = (t: [string, string][]) => t.map(([r]) => r)

describe('isAttachmentPath / attachmentTarget', () => {
  it('只认 attachments/ 下的规范相对路径', () => {
    for (const ok of ['attachments/a b.png', 'attachments/sub/图 [1].png']) expect(isAttachmentPath(ok)).toBe(true)
    const bad = [
      'attachments/../package.json',
      'attachments/./../x',
      'attachments/./a.png',
      'attachments/sub/../../x',
      'attachments\\..\\x',
      'attachments/a\\b.png',
      'attachments/C:x',
      'C:/attachments/x',
      '/attachments/x',
      '/abs/attachments/x',
      'attachments/',
      'attachments//x',
      'attachments/x\0',
      'other/x.png',
      'attachments',
      undefined,
      42,
    ]
    for (const b of bad) expect(isAttachmentPath(b), String(b)).toBe(false)
  })

  it('真实父目录必须在真实 attachments/ 内；越界、没有 attachments/ 时为 null', async () => {
    const { root } = vault({ 'attachments/x.png': '', 'package.json': '{}' })
    expect(await attachmentTarget(root, 'attachments/x.png')).toBe(path.join(await realpath(root), 'attachments', 'x.png'))
    expect(await attachmentTarget(root, 'attachments/没有.png')).toBe(path.join(await realpath(root), 'attachments', '没有.png')) // 目标可以不存在（恢复用）
    expect(await attachmentTarget(root, 'attachments/../package.json')).toBeNull()
    expect(await attachmentTarget(root, 'attachments/./../package.json')).toBeNull()
    expect(await attachmentTarget(root, 'attachments\\..\\package.json')).toBeNull()
    expect(await attachmentTarget(root, path.join(root, 'package.json'))).toBeNull()
    expect(await attachmentTarget(vault({ 'a.md': '' }).root, 'attachments/x.png')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('attachments/ 的子目录是指向库内别处的链接时也拒绝', async () => {
    const { root } = vault({ 'attachments/a.png': '', 'notes/n.md': '' })
    symlinkSync(path.join(root, 'notes'), path.join(root, 'attachments', 'notes'))
    expect(await attachmentTarget(root, 'attachments/notes/n.md')).toBeNull()
  })
})

describe('checkOrphans', () => {
  it('只留下仍是孤儿、在 attachments/ 内的现存文件', async () => {
    const { root } = vault({ 'a.md': '', 'attachments/x.png': '', 'attachments/sub/y.png': '', 'attachments/used.png': '', 'other/z.png': '' })
    const orphans = new Set(['attachments/x.png', 'attachments/sub/y.png', 'attachments/gone.png', 'other/z.png', 'attachments/../a.md', 'a.md'])
    const paths = [...orphans, 'attachments/used.png', 'attachments/x.png']
    expect(rels(await checkOrphans(root, paths, orphans))).toEqual(['attachments/x.png', 'attachments/sub/y.png'])
  })

  it('没有 attachments/ 时什么都不删', async () => {
    const { root } = vault({ 'a.md': '' })
    expect(await checkOrphans(root, ['attachments/x.png'], new Set(['attachments/x.png']))).toEqual([])
  })

  // Windows 上建符号链接需要管理员或开发者模式，CI 跳过
  it.skipIf(process.platform === 'win32')('符号链接越界：attachments/ 或其子目录指向库外时拒绝，末级链接只回收链接本身', async () => {
    const { base, root } = vault({ 'attachments/a.png': '', 'notes/n.md': '' })
    mkdirSync(path.join(base, 'outside'))
    writeFileSync(path.join(base, 'outside', 'secret.png'), '')
    symlinkSync(path.join(base, 'outside'), path.join(root, 'attachments', 'linkdir'))
    symlinkSync(path.join(base, 'outside', 'secret.png'), path.join(root, 'attachments', 'evil.png'))
    const all = new Set(['attachments/linkdir/secret.png', 'attachments/evil.png', 'attachments/a.png'])
    const got = await checkOrphans(root, [...all], all)
    expect(rels(got)).toEqual(['attachments/evil.png', 'attachments/a.png'])
    expect(got[0][1]).toBe(path.join(await realpath(root), 'attachments', 'evil.png'))

    // attachments 本身是指向库外的链接：全部拒绝
    const v2 = vault({ 'a.md': '' })
    mkdirSync(path.join(v2.base, 'outside'))
    writeFileSync(path.join(v2.base, 'outside', 'b.png'), '')
    symlinkSync(path.join(v2.base, 'outside'), path.join(v2.root, 'attachments'))
    expect(await checkOrphans(v2.root, ['attachments/b.png'], new Set(['attachments/b.png']))).toEqual([])
    // attachments 指向库内别的目录：仍不能借道删 attachments/ 以外（真实路径不在真实 attachments/ 内的跳过）
    const v3 = vault({ 'notes/img/c.png': '', 'notes/n.md': '' })
    symlinkSync(path.join(v3.root, 'notes', 'img'), path.join(v3.root, 'attachments'))
    symlinkSync(path.join(v3.root, 'notes'), path.join(v3.root, 'notes', 'img', 'up'))
    const s3 = new Set(['attachments/c.png', 'attachments/up/n.md'])
    expect(rels(await checkOrphans(v3.root, [...s3], s3))).toEqual(['attachments/c.png'])
  })
})

describe('removeOrphans', () => {
  it('非 git 目录：一律移到回收站', async () => {
    const { root } = vault({ 'attachments/x.png': '', 'attachments/y.png': '' })
    const targets = await checkOrphans(root, ['attachments/x.png', 'attachments/y.png'], new Set(['attachments/x.png', 'attachments/y.png']))
    // 第二个回收失败：已删的一个照样经 progress 报出来
    const trash = vi.fn((p: string) => (p.endsWith('y.png') ? Promise.reject(new Error('busy')) : rm(p)))
    let n = 0
    await expect(removeOrphans(targets, null, trash, () => n++)).rejects.toThrow('busy')
    expect(n).toBe(1)
    expect(trash).toHaveBeenCalledTimes(2)
    expect(existsSync(path.join(root, 'attachments', 'x.png'))).toBe(false)
  })

  it('git 仓库（库是仓库子目录）：已跟踪的 git rm 并暂存，未跟踪的移到回收站；文件名里的通配符按字面', async () => {
    const { base, root: repo } = vault({ '笔记库/attachments/旧 图.png': 'a', '笔记库/attachments/[x].png': 'b', '笔记库/attachments/x.png': 'keep' })
    const globalConfig = path.join(base, 'gitconfig')
    writeFileSync(globalConfig, '')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
    const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env }).toString()
    sh('init', '-q')
    sh('add', '.')
    sh('commit', '-qm', 'init')
    const root = path.join(repo, '笔记库')
    writeFileSync(path.join(root, 'attachments', '新.png'), 'c')
    const git = new Git('git', process.env.PATH!, root, vi.fn(), env)
    const paths = ['attachments/旧 图.png', 'attachments/[x].png', 'attachments/新.png']
    const targets = await checkOrphans(root, paths, new Set(paths))
    const trash = vi.fn((p: string) => rm(p))
    expect(await removeOrphans(targets, git, trash)).toEqual(paths)
    expect(trash.mock.calls.map(([p]) => path.basename(p))).toEqual(['新.png'])
    // [x].png 若按通配符会匹配到 x.png：它必须原样留着
    expect(existsSync(path.join(root, 'attachments', 'x.png'))).toBe(true)
    expect(sh('-c', 'core.quotePath=false', 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual(
      ['D  "笔记库/attachments/旧 图.png"', 'D  笔记库/attachments/[x].png'].sort(),
    )
  })
})
