// 工作区对比用到的纯函数（不依赖 Monaco），便于单测
import { destination, resolveLink } from '../../shared/url'

// 链接解析在 shared/url.ts（渲染、跳转、索引共用），这里转出给已有调用方
export { decodeEntities, destination, resolveLink } from '../../shared/url'

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

// doc 是否恰好等于「若干个 BOM + visible」，是的话返回 BOM 的个数（Monaco 藏起来的那部分），否则 null
export function bomOffset(doc: string, visible: string): number | null {
  const n = doc.length - visible.length
  if (n < 0 || !doc.endsWith(visible)) return null
  for (let i = 0; i < n; i++) if (doc.charCodeAt(i) !== 0xfeff) return null
  return n
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

// Markdown 反斜杠转义（ASCII 标点）还原成字符本身
export const unescapeMd = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1')

// 引用标签的匹配键（CommonMark）：折叠空白，Unicode case fold；不反转义（`[a\*b]` 只匹配 `[a\*b]`）。
// 传入的是标签内容，不含外层方括号（由调用方按语法树的 LinkLabel 边界取），所以末尾的转义 `\]` 不会被误删
export const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()

// 同上，不是图片时也为 null
export function resolveImage(src: string, note: string): string | null {
  const path = resolveLink(src, note)
  return path && imageMime(path) ? path : null
}

// 第 col 列（从 0 起）所在的 Markdown 图片引用 `![alt](src "title")`，返回图片相对笔记库根的路径
export function imageAt(line: string, col: number, note: string): { path: string; start: number; end: number } | null {
  for (const m of line.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|(?:\\.|[^)\s\\])+)(?:\s+"[^"]*")?\s*\)/g)) {
    const start = m.index
    const end = start + m[0].length
    if (col < start || col >= end) continue
    const path = resolveImage(destination(m[1]), note)
    return path ? { path, start, end } : null
  }
  return null
}

// 图片字节 → data URL（CSP 只放行 'self' 和 data:，不能用 blob:）
export const dataUrl = (bytes: Uint8Array, type: string) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  })

// shortcut: 直接用整张原图的 data URL，超过 8 MiB 不显示；有大图需求时再在主进程缩放
export const MAX_IMAGE = 8 << 20
