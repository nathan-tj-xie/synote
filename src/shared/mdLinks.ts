// 从 lezer Markdown 语法树里认出链接（S8）：索引（反链）和实时预览共用，两边对「哪里是链接、指向什么地址」不各认各的。
// 地址再交给 url.ts 的 resolveLink / linkTarget / parseWiki 解析成路径
import type { SyntaxNode, Tree } from '@lezer/common'
import { destination, WIKI } from './url'

// 内容不按 Markdown 渲染的节点：里面的 `[..](..)`、`[[..]]` 不是链接。引用定义本身也不算链接（地址算在使用处）
export const RAW = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'Comment', 'ProcessingInstructionBlock', 'LinkReference'])
// 引用定义所在的块级容器（linkRefs 只往这些节点里走）
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

// 引用标签的匹配键（CommonMark）：折叠空白，Unicode case fold；不反转义（`[a\*b]` 只匹配 `[a\*b]`）。
// 传入的是标签内容，不含外层方括号（由调用方按语法树的 LinkLabel 边界取），所以末尾的转义 `\]` 不会被误删
export const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()

// 取源码：text 取原文；label 取标签内容（实时预览跨行时去掉续行的引用标记），默认同 text
export type Source = { text: (from: number, to: number) => string; label?: (from: number, to: number) => string }

// 引用定义 `[ref]: 地址`：标签按 normalizeLabel 归一，地址存原文（用时再经 destination 解码），重复定义以第一个为准
export function linkRefs(tree: Tree, src: Source): Map<string, string> {
  const label = src.label ?? src.text
  const refs = new Map<string, string>()
  tree.iterate({
    enter(n) {
      if (n.name !== 'LinkReference') return CONTAINERS.has(n.name)
      const l = n.node.getChild('LinkLabel')
      const url = n.node.getChild('URL')
      const key = l && normalizeLabel(label(l.from + 1, l.to - 1))
      if (key && url && !refs.has(key)) refs.set(key, src.text(url.from, url.to))
      return false
    },
  })
  return refs
}

// Link / Image 节点的地址（经 destination 解码）：内联写法取 URL 子节点，`[文]()` 为空串；
// 引用写法（`[文][ref]`、`[ref][]`、`[ref]`）按标签查定义，查不到或是脚注 `[^1]` 时为 null（那就不是链接）
export function linkHref(n: SyntaxNode, refs: () => Map<string, string>, src: Source): string | null {
  const marks = n.getChildren('LinkMark')
  if (marks.length < 2) return null
  const url = n.getChild('URL')
  if (url) return destination(src.text(url.from, url.to))
  if (marks.length > 2) return ''
  const label = src.label ?? src.text
  const l = n.getChild('LinkLabel')
  const key = normalizeLabel(l && l.to - l.from > 2 ? label(l.from + 1, l.to - 1) : label(marks[0].to, marks[1].from))
  const target = key.startsWith('^') ? undefined : refs().get(key)
  return target === undefined ? null : destination(target)
}

// 从 pos 起的 [[...]] 是否落在代码等原样节点或标准链接里（那就不是双链）。
// lezer 会把里层的 `[...]` 认成引用式 Link（不管有没有定义），那个不算
export function wikiBlocked(tree: Tree, pos: number): boolean {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent)
    if (RAW.has(n.name) || ((n.name === 'Link' || n.name === 'Image') && n.from !== pos + 1)) return true
  return false
}

// text（在文档里从 offset 开始）中的 [[...]]；inner 是方括号里的文字
export function wikiLinks(tree: Tree, text: string, offset = 0): { from: number; to: number; inner: string }[] {
  const out: { from: number; to: number; inner: string }[] = []
  for (const m of text.matchAll(WIKI)) {
    const from = offset + m.index
    if (!wikiBlocked(tree, from)) out.push({ from, to: from + m[0].length, inner: m[1] })
  }
  return out
}

// 整篇里的链接、图片和 [[...]]，按出现位置排序；from 是使用处（引用式也是），href 对 [[...]] 是方括号里的文字
export type FoundLink = { kind: 'link' | 'image' | 'wiki'; from: number; to: number; href: string }
export function findLinks(tree: Tree, doc: string): FoundLink[] {
  const src: Source = { text: (a, b) => doc.slice(a, b) }
  let refs: Map<string, string> | undefined
  const getRefs = () => (refs ??= linkRefs(tree, src))
  const out: FoundLink[] = []
  tree.iterate({
    enter(n) {
      if (RAW.has(n.name)) return false
      if (n.name !== 'Link' && n.name !== 'Image') return
      const href = linkHref(n.node, getRefs, src)
      if (href !== null) out.push({ kind: n.name === 'Link' ? 'link' : 'image', from: n.from, to: n.to, href })
    },
  })
  for (const w of wikiLinks(tree, doc)) out.push({ kind: 'wiki', from: w.from, to: w.to, href: w.inner })
  return out.sort((a, b) => a.from - b.from)
}
