// git 冲突标记（S16）：冲突视图的行内接受按钮、保存时判断是否已解决（#9 决定 3）、完成合并前的全库复查都用这里

// 一个冲突块：start / base / mid / end 是 <<<<<<< / ||||||| / ======= / >>>>>>> 所在的行（从 1 起，没有 base 段时为 null）；
// ours / theirs 是两侧的原文（含行尾换行）
export type Conflict = { start: number; base: number | null; mid: number; end: number; ours: string; theirs: string }

// 每行连同行尾换行
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const marker = (line: string, c: string) => new RegExp(`^\\${c}{7}(?: |$)`).test(line.replace(/\r?\n$/, ''))

// 只认完整的块；不完整的（如 setext 标题下面的 =======）跳过
export function parseConflicts(text: string): Conflict[] {
  const lines = linesOf(text)
  const res: Conflict[] = []
  let start = 0
  let base: number | null = null
  let mid = 0
  for (let i = 1; i <= lines.length; i++) {
    const l = lines[i - 1]
    if (marker(l, '<')) [start, base, mid] = [i, null, 0]
    else if (!start) continue
    else if (!mid && base === null && marker(l, '|')) base = i
    else if (!mid && /^={7}\r?\n?$/.test(l)) mid = i
    else if (mid && marker(l, '>')) {
      const join = (a: number, b: number) => lines.slice(a, b - 1).join('')
      res.push({ start, base, mid, end: i, ours: join(start, base ?? mid), theirs: join(mid, i) })
      start = 0
    }
  }
  return res
}

// 用一侧（或先 ours 后 theirs 两侧都要）替换整个块
export function resolveConflict(text: string, c: Conflict, take: 'ours' | 'theirs' | 'both'): string {
  const lines = linesOf(text)
  const body = take === 'ours' ? c.ours : take === 'theirs' ? c.theirs : c.ours + c.theirs
  return lines.slice(0, c.start - 1).join('') + body + lines.slice(c.end).join('')
}

// 只要还有一行起止标记就不算解决：比 parseConflicts 严，手改到一半删掉部分标记时不会被当作已解决而自动 git add。
// ======= 单独不算（Markdown 的 setext 标题）
export const hasConflictMarkers = (text: string) => /^(<{7}|>{7}|\|{7})(?: |\r?$)/m.test(text)
