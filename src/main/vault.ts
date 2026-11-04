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
