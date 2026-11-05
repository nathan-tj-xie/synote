// 工作区对比用到的纯函数（不依赖 Monaco），便于单测
import { decodeComponent } from '../../shared/url'

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

// HTML 实体解码：数字实体和常用命名实体自己解；其余命名实体有 DOM 时交给浏览器（渲染进程），没有就保留原文
const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const ENTITY = '&(#\\d{1,7}|#x[\\da-f]{1,6}|[a-z][a-z\\d]{0,31});'
function decodeEntity(m: string, e: string): string {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd'
  }
  if (named[e]) return named[e]
  if (typeof document === 'undefined') return m
  const t = document.createElement('textarea')
  t.innerHTML = m // 已校验只是一个实体，不会带出标签
  return t.value
}
export const decodeEntities = (s: string) => s.replace(new RegExp(ENTITY, 'gi'), decodeEntity)

// 链接目标（CommonMark 的 link destination）：去尖括号，再一次扫描同时处理反斜杠转义和实体——
// 两者产出的字符不再被重新解释（`\&amp;` 是字面的 `&amp;`，`\\&amp;` 是 `\&`）。内联、引用式、diff 悬停都走它
export function destination(raw: string): string {
  const s = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  return s.replace(new RegExp(`\\\\([!-/:-@[-\`{-~])|${ENTITY}`, 'gi'), (m, esc: string | undefined, e: string | undefined) =>
    esc !== undefined ? esc : decodeEntity(m, e!),
  )
}

// 引用标签的匹配键（CommonMark）：折叠空白，Unicode case fold；不反转义（`[a\*b]` 只匹配 `[a\*b]`）。
// 传入的是标签内容，不含外层方括号（由调用方按语法树的 LinkLabel 边界取），所以末尾的转义 `\]` 不会被误删
export const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()

// 链接 / 图片引用的 src 解析成相对笔记库根的路径（ADR 0001 的相对链接）：按笔记所在目录解析，以 / 开头的按库根；
// 外链、越出笔记库时为 null。diff 悬停和实时预览共用
export function resolveLink(src: string, note: string): string | null {
  src = src.replace(/[?#].*$/, '') // 尖括号、转义、实体已由 destination 处理
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  const parts = src.startsWith('/') ? [] : note.split('/').slice(0, -1)
  for (const raw of src.split('/')) {
    // 按段解码（%23 → #、%26 → &）。解出 / 或 \ 的段（如 %2e%2e%2f）会改变路径结构，整条拒绝；
    // 解出的 `..` 和字面 `..` 一样按上一级处理，越出笔记库就拒绝。主进程读之前还会按真实路径再校验
    const seg = decodeComponent(raw)
    if (/[/\\]/.test(seg)) return null
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/') || null
}

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
