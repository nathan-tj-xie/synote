import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Entry } from '../shared/api'

// 文件树中隐藏：点开头的文件 / 文件夹（.git、.synote 等）和根目录下的 attachments/
export function isHidden(rel: string): boolean {
  const parts = rel.split('/')
  return parts[0] === 'attachments' || parts.some((p) => p.startsWith('.'))
}

const collator = new Intl.Collator('zh-CN', { numeric: true })

export async function scanEntries(root: string): Promise<Entry[]> {
  const out: Entry[] = []
  async function walk(rel: string): Promise<void> {
    const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    const kids: Entry[] = []
    for (const d of dirents) {
      const p = rel ? `${rel}/${d.name}` : d.name
      if (isHidden(p) || !(d.isDirectory() || d.isFile())) continue
      kids.push({ path: p, dir: d.isDirectory() })
    }
    out.push(...kids)
    await Promise.all(kids.filter((k) => k.dir).map((k) => walk(k.path)))
  }
  await walk('')
  return out.sort((a, b) => collator.compare(a.path, b.path))
}

// 渲染进程传来的相对路径必须落在笔记库内
export function resolveInVault(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const back = path.relative(root, abs)
  if (!rel || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`path outside vault: ${rel}`)
  return abs
}

// 真实路径 a 是否在真实库根 r 之内（含 r 自身）
function within(r: string, a: string): boolean {
  const back = path.relative(r, a)
  return back !== '..' && !back.startsWith(`..${path.sep}`) && !path.isAbsolute(back)
}

// 读之前再按真实路径查一次：resolveInVault 只看字面，符号链接（文件本身或路径上的某个目录）可能指向库外。
// 目标的真实路径必须仍在库的真实路径之内，否则拒绝
export async function realInVault(root: string, rel: string): Promise<string> {
  const abs = resolveInVault(root, rel)
  const [r, a] = await Promise.all([fs.realpath(root), fs.realpath(abs)])
  if (a === r || !within(r, a)) throw new Error(`path outside vault: ${rel}`)
  return a
}

// 回收 / 新建用：真实父目录必须在库内，返回「真实父目录 + 末级名」。末级是链接时返回的就是链接本身（回收链接，不回收目标）
export async function realParentInVault(root: string, rel: string): Promise<string> {
  const abs = resolveInVault(root, rel)
  const [r, dir] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(abs))])
  if (!within(r, dir)) throw new Error(`path outside vault: ${rel}`)
  return path.join(dir, path.basename(abs))
}

// 写入用：父目录同上；末级已是符号链接时写入会跟随它，所以它的目标也必须在库内（悬空链接同样拒绝）
export async function writeTarget(root: string, rel: string): Promise<string> {
  const p = await realParentInVault(root, rel)
  const st = await fs.lstat(p).catch(() => null)
  return st?.isSymbolicLink() ? realInVault(root, rel) : p
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

// "未命名.md"、"未命名 1.md"……取第一个不存在的
export function uniqueNoteName(existing: Set<string>, dir: string, base: string): string {
  for (let i = 0; ; i++) {
    const name = `${base}${i ? ` ${i}` : ''}.md`
    const p = dir ? `${dir}/${name}` : name
    if (!existing.has(p)) return p
  }
}
