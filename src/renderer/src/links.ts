// 双链（S8）在渲染进程这一侧：库内笔记列表、链接解析成目标、输入 [[ 时的补全。
// 解析规则都在 shared/url.ts，和索引（反链）共用；这里只补上渲染进程才有的笔记列表
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { linkTarget, parseWiki, pickWiki, relativeLink, type LinkTarget } from '../../shared/url'
import { indexPaths, searchPaths, type PathIndex } from './match'
import { useVault } from './store'

// 链接的原始写法：标准链接为经 destination 解码的地址，[[...]] 为方括号内的文字
export type Href = { href: string } | { wiki: string }

let cache: { entries: unknown; notes: string[]; index: PathIndex | null } | null = null
function notes() {
  const entries = useVault.getState().vault?.entries
  if (cache?.entries !== entries) cache = { entries, notes: (entries ?? []).filter((e) => !e.dir && e.path.endsWith('.md')).map((e) => e.path), index: null }
  return cache!
}

// 链接指向的文件与锚点；外链、越出笔记库、没有同名笔记的 [[名字]] 为 null
export function resolveHref(h: Href, note: string): LinkTarget | null {
  if ('href' in h) return linkTarget(h.href, note)
  const w = parseWiki(h.wiki)
  const path = w && (w.path ?? pickWiki(w.name!, notes().notes))
  return path ? { path, anchor: w!.anchor } : null
}

// [[ 之后按快速切换的模糊匹配列出笔记，选中后写入标准相对链接 `[名字](相对路径.md)`（ADR 0001），不写 [[...]]
const source =
  (note: string): CompletionSource =>
  (ctx) => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*$/)
    if (!m) return null
    const n = notes()
    const hits = searchPaths(m.text.slice(2), (n.index ??= indexPaths(n.notes))).slice(0, 50)
    return {
      from: m.from,
      filter: false,
      options: hits.map((h) => ({
        label: h.id,
        apply: (view, _c, from, to) => {
          const name = h.id.slice(h.id.lastIndexOf('/') + 1, -3).replace(/[\\[\]]/g, '\\$&')
          const insert = `[${name}](${relativeLink(note, h.id)})`
          // 已经手动敲了收尾的 ]] 就一起换掉
          const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to
          view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' })
        },
      })),
    }
  }

export const noteCompletion = (note: string): Extension => autocompletion({ override: [source(note)], icons: false })
