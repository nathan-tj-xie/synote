import { parser } from '@lezer/markdown'

// 链接解析：主进程（索引的链接抽取、反链）和渲染进程（实时预览、跳转、补全、图片路径）共用这一份，不另起一套。
// 链接路径的百分号解码
// 用 decodeURIComponent 而不是 decodeURI：后者不解 %23、%26、%3F 等保留字符，而文件名里可以有 # & ?。
// 不是合法的百分号编码时保留原文
export function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// decodeComponent 的逆过程，只编码会让链接失效或解码出歧义的 ASCII 字符（空白、% ( ) < > # ? & \ 等）；
// 非 ASCII 保持原样（ADR 0001），这样在 GitHub 上可点、索引和实时预览解码后还原成原路径
export const encodeSegment = (s: string) =>
  s.replace(/[\x00-\x20%()<>#?&\\\x7f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

// 从笔记 note 指向 target（都相对库根）的标准相对链接，按笔记所在目录计算
export function relativeLink(note: string, target: string): string {
  const from = note.split('/').slice(0, -1)
  const to = target.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].map(encodeSegment).join('/')
}

// 把 from（文件或文件夹）移到 to 之后，p 的新路径；不在 from 之下的不变（S9）
export const movePath = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)

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

// 链接 / 图片引用的 src 解析成相对笔记库根的路径（ADR 0001 的相对链接）：按笔记所在目录解析，以 / 开头的按库根；
// 外链、越出笔记库时为 null。索引、diff 悬停、实时预览和跳转共用
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


// 链接指向的笔记库内文件与标题锚点（锚点已解码；没有时为 null）。href 是经 destination 解码的地址，
// 只有锚点（`#标题`）时指向笔记自身
export type LinkTarget = { path: string; anchor: string | null }
export function linkTarget(href: string, note: string): LinkTarget | null {
  const hash = href.indexOf('#')
  const anchor = hash >= 0 ? decodeComponent(href.slice(hash + 1)) || null : null
  const path = href.startsWith('#') ? note : resolveLink(href, note)
  return path ? { path, anchor } : null
}

// `[[目标#标题|别名]]` 的方括号内文字（ADR 0001：读取时识别、从不写入）。目标含 / 时按库根路径（补 .md），
// 否则按笔记名，由 pickWiki 选具体文件；text 是实时预览显示的文字
export type Wiki = { path: string | null; name: string | null; anchor: string | null; text: string }
export const WIKI = /\[\[([^\]\n]+)\]\]/g
export function parseWiki(inner: string): Wiki | null {
  const bar = inner.indexOf('|')
  const raw = bar >= 0 ? inner.slice(0, bar) : inner
  const hash = raw.indexOf('#')
  const target = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
  const anchor = hash >= 0 ? raw.slice(hash + 1).trim() || null : null
  const text = (bar >= 0 ? inner.slice(bar + 1) : raw).trim() || raw.trim()
  if (!target) return null
  if (!target.includes('/')) return { path: null, name: target.replace(/\.md$/, ''), anchor, text }
  const path = resolveLink(target.endsWith('.md') ? target : `${target}.md`, '')
  return path ? { path, name: null, anchor, text } : null
}

// [[同名]] 指向多篇时取路径最小的那篇；没有同名笔记时为 null
export function pickWiki(name: string, notes: Iterable<string>): string | null {
  let best: string | null = null
  for (const p of notes)
    if (p.endsWith('.md') && p.slice(p.lastIndexOf('/') + 1, -3) === name && (best === null || p < best)) best = p
  return best
}

// GitHub 的标题锚点（github-slugger）：转小写，去掉字母、数字、连接符、空格、- 以外的字符，空格换成 -；
// 非 ASCII（中文）保留。同一篇里重复的依次加 -1、-2（已被占用的后缀继续往后数）
export const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text) => {
    const base = slug(text)
    let s = base
    while (seen.has(s)) {
      const n = seen.get(base)! + 1
      seen.set(base, n)
      s = `${base}-${n}`
    }
    seen.set(s, 0)
    return s
  }
}

// 标题按 GitHub 渲染后的文字算 slug：去掉 `#`、强调、代码、链接地址、HTML 标签等标记，只留显示的文字；
// 中间的空白原样保留（github-slugger 不压缩连续空格：`Hello  World` → `hello--world`）
const MARKUP = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel', 'StrikethroughMark', 'HTMLTag'])

// 正文里每个标题的锚点和所在行（从 1 起）
export function headingAnchors(text: string): { slug: string; line: number }[] {
  const next = slugger()
  const out: { slug: string; line: number }[] = []
  const tree = parser.parse(text)
  tree.iterate({
    enter(n) {
      if (!/^(ATX|Setext)Heading/.test(n.name)) return
      const cuts: [number, number][] = []
      n.node.cursor().iterate((c) => {
        if (!MARKUP.has(c.name)) return
        cuts.push([c.from, c.to])
        return false
      })
      let s = ''
      let pos = n.from
      for (const [a, b] of cuts) {
        s += text.slice(pos, a)
        pos = b
      }
      s += text.slice(pos, n.to)
      const plain = decodeEntities(s.replace(/\\([!-/:-@[-`{-~])/g, '$1')).trim()
      out.push({ slug: next(plain), line: text.slice(0, n.from).split('\n').length })
      return false
    },
  })
  return out
}

// 锚点所在的行：先按原样比，再按 GitHub 的写法（小写）比；找不到为 null
export function anchorLine(text: string, anchor: string): number | null {
  const all = headingAnchors(text)
  return (all.find((h) => h.slug === anchor) ?? all.find((h) => h.slug === slug(anchor)))?.line ?? null
}
