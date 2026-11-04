import type { Entry } from '../../shared/api'

export const ROOT = '/'

// 扁平条目 → 父路径到子路径列表；文件夹在前，保持 entries 的排序
export function buildChildren(entries: Entry[]): Map<string, string[]> {
  const kids = new Map<string, string[]>([[ROOT, []]])
  const dirs = new Set(entries.filter((e) => e.dir).map((e) => e.path))
  for (const e of entries) if (e.dir) kids.set(e.path, [])
  for (const e of entries) {
    const i = e.path.lastIndexOf('/')
    const parent = i < 0 ? ROOT : e.path.slice(0, i)
    kids.get(parent)?.push(e.path)
  }
  for (const list of kids.values()) list.sort((a, b) => Number(dirs.has(b)) - Number(dirs.has(a)))
  return kids
}

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
