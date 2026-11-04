// 工作区对比用到的纯函数（不依赖 Monaco），便于单测

// a 变成 b 的最小单段替换（去掉公共前后缀），外部重载推给 Monaco 时用，保住光标和撤销栈。
// 边界只落在码点上：切开代理对的话 Monaco 会把范围扩到整个码点，插入文本却没扩，两边就错位了
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

export function minimalEdit(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p-- // 前缀停在高代理之后：退回到这个码点之前
  let q = 0
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++
  if (q > 0 && isLow(a.charCodeAt(a.length - q))) q-- // 后缀从低代理开始：让出这个码点
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) }
}

const mimes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export const imageMime = (p: string): string | undefined => mimes[p.split('.').pop()!.toLowerCase()]

// 第 col 列（从 0 起）所在的 Markdown 图片引用 `![alt](src "title")`，返回图片相对笔记库根的路径。
// src 按笔记所在目录解析（ADR 0001 的相对链接），以 / 开头的按库根；外链、越出笔记库、不是图片时为 null
export function imageAt(line: string, col: number, note: string): { path: string; start: number; end: number } | null {
  for (const m of line.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const start = m.index
    const end = start + m[0].length
    if (col < start || col >= end) continue
    let src = m[1].replace(/^<|>$/g, '').replace(/[?#].*$/, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null
    try {
      src = decodeURI(src)
    } catch {
      // 不是合法的百分号编码：按原文
    }
    const parts = src.startsWith('/') ? [] : note.split('/').slice(0, -1)
    for (const seg of src.split('/')) {
      if (seg === '..') {
        if (!parts.length) return null
        parts.pop()
      } else if (seg && seg !== '.') parts.push(seg)
    }
    const path = parts.join('/')
    return path && imageMime(path) ? { path, start, end } : null
  }
  return null
}
