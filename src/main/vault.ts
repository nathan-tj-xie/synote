import { createHash } from 'node:crypto'
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

// 附件命名（#8）：拖入的保留原名、空白换成 -；name 为 null 是剪贴板图片，按本地时间命名 image-YYYYMMDD-HHmmss.png。
// 名字来自渲染进程，只取末段，防止带出目录
export function attachmentName(name: string | null, now: Date): string {
  if (name === null) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `image-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`
  }
  const base = name.split(/[/\\]/).pop()!.replace(/\s/g, '-')
  return base && base !== '.' && base !== '..' ? base : 'attachment'
}

// 重名时在扩展名前追加 -1、-2……
export function numberedName(name: string, i: number): string {
  if (!i) return name
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)}-${i}${ext}`
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// 把附件写进库根的 attachments/，返回相对库根的路径。attachments/ 里已有 SHA-256 相同的文件就直接复用（先按大小筛，
// 只对同样大小的算哈希）；否则从 name 起找第一个空位，wx 写入不覆盖已有文件。调用方负责串行，避免并发写出两份
export async function saveAttachment(root: string, name: string, bytes: Uint8Array): Promise<string> {
  await fs.mkdir(await realParentInVault(root, 'attachments'), { recursive: true })
  // 真实父目录校验：attachments 被换成指向库外的链接时这里就拒绝
  const dir = path.dirname(await realParentInVault(root, `attachments/${name}`))
  const hash = sha256(bytes)
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (!d.isFile()) continue // 链接、子目录不算（扁平目录，链接可能指向库外）
    const p = path.join(dir, d.name)
    if ((await fs.stat(p)).size === bytes.length && sha256(await fs.readFile(p)) === hash) return `attachments/${d.name}`
  }
  for (let i = 0; ; i++) {
    const rel = `attachments/${numberedName(name, i)}`
    try {
      await fs.writeFile(await realParentInVault(root, rel), bytes, { flag: 'wx' })
      return rel
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}
