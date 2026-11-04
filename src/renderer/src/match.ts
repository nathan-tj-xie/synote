// 命令面板 / 快速切换用到的纯函数：快捷键匹配与文件名模糊匹配，便于单测
import fuzzysort, { type Snapshot } from 'fuzzysort'

export const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

// 'Mod-Shift-p' 与按键事件是否完全匹配（修饰键多一个少一个都不算）
export function matchKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, key: string, mac = isMac): boolean {
  const parts = key.split('-')
  const has = (m: string) => parts.includes(m)
  const mod = has('Mod')
  return (
    e.key.toLowerCase() === parts.at(-1)!.toLowerCase() &&
    e.metaKey === (mac ? mod : false) &&
    e.ctrlKey === (mac ? false : mod) &&
    e.shiftKey === has('Shift') &&
    e.altKey === has('Alt')
  )
}

export function formatKey(key: string, mac = isMac): string {
  const names: Record<string, [string, string]> = { Mod: ['⌘', 'Ctrl'], Shift: ['⇧', 'Shift'], Alt: ['⌥', 'Alt'] }
  const parts = key.split('-').map((p) => names[p]?.[mac ? 0 : 1] ?? p.toUpperCase())
  return parts.join(mac ? '' : '+')
}

export type Hit = { id: string; text: string; indexes: readonly number[] }

export type PathIndex = { paths: readonly string[]; snap: Snapshot }

// 建索引并预热：fuzzysort 首次查询要完成 snapshot 并触发 JIT，冷启动约 30–80 ms，放在空闲时做掉
export function indexPaths(paths: readonly string[]): PathIndex {
  const snap = fuzzysort.snapshot(paths)
  const s = paths[0]
  // 单字、连续、非连续、带空格的多词各走一条代码路径，都要预热到
  if (s) for (let r = 0; r < 3; r++) for (const w of [s[0], s.slice(0, 2), s[0] + s.at(-1), `${s[0]} ${s.at(-1)}`]) fuzzysort.go(w, snap, { limit: 200 })
  return { paths, snap }
}

// 快速切换的匹配；空查询列出全部（列表是虚拟化的）
export function searchPaths(query: string, { paths, snap }: PathIndex): Hit[] {
  if (!query.trim()) return paths.map((p) => ({ id: p, text: p, indexes: [] }))
  return fuzzysort.go(query, snap, { limit: 200 }).map((r) => ({ id: r.target, text: r.target, indexes: r.indexes }))
}
