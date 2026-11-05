// 重命名 / 移动时改写引用（S9，ADR 0001）：在内存里算出每篇笔记的改写，再原子地写盘并执行移动，失败时回滚
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parser } from '@lezer/markdown'
import { applyEdits, linkUrls, wikiLinks, type Edit } from '../shared/mdLinks'
import { destination, encodeSegment, movePath, parseWiki, pickWiki, relativeLink, resolveLink, slug } from '../shared/url'
import { realParentInVault, scanEntries } from './vault'

// 笔记 note 在 from → to 之后要改的源码片段。只改链接目标的路径那一段，锚点、query、尖括号、标题等其余字节不动；
// 移动后仍解析到同一目标的不改。wiki(name, after) 是移动前 / 后 [[name]] 选中的笔记
export function rewriteEdits(text: string, note: string, from: string, to: string, wiki: (name: string, after: boolean) => string | null): Edit[] {
  const tree = parser.parse(text)
  const moved = movePath(note, from, to)
  const edits: Edit[] = []
  for (const u of linkUrls(tree, text)) {
    const raw = text.slice(u.from, u.to)
    const angle = raw.startsWith('<') && raw.endsWith('>')
    const start = u.from + (angle ? 1 : 0)
    const inner = angle ? raw.slice(1, -1) : raw
    const cut = inner.search(/[?#]/)
    const rawPath = cut < 0 ? inner : inner.slice(0, cut)
    const p = destination(rawPath)
    const old = p ? resolveLink(p, note) : null
    // 切出来的路径和整条地址的解析结果对不上（转义、实体写出的 # ?）就切不准，宁可不改
    if (!old || resolveLink(destination(raw), note) !== old) continue
    const target = movePath(old, from, to)
    if (resolveLink(p, moved) === target) continue
    let next = p.startsWith('/') ? `/${target.split('/').map(encodeSegment).join('/')}` : relativeLink(moved, target)
    if (p.endsWith('/')) next += '/'
    edits.push({ from: start, to: start + rawPath.length, insert: next })
  }
  for (const w of wikiLinks(tree, text)) {
    const k = parseWiki(w.inner)
    const old = k && (k.path ?? wiki(k.name!, false))
    if (!old) continue
    const target = movePath(old, from, to)
    if ((k.path ?? wiki(k.name!, true)) === target) continue
    // 移动后 [[...]] 会指向别处或失效：按 ADR 0001 改写成标准相对链接（Synote 从不写入 [[...]]），锚点按 GitHub slug
    const anchor = k.anchor ? `#${encodeSegment(slug(k.anchor))}` : ''
    edits.push({ from: w.from, to: w.to, insert: `[${k.text.replace(/[\\[\]]/g, '\\$&')}](${relativeLink(moved, target)}${anchor})` })
  }
  return edits.sort((a, b) => a.from - b.from)
}

// 一篇要改写的笔记：读到的原始字节（回滚用、写前比对用）、正文、改写和权限位
export type NotePlan = { path: string; abs: string; bytes: Buffer; before: string; edits: Edit[]; mode: number }

const noteName = (p: string) => p.slice(p.lastIndexOf('/') + 1, -3)

// 读全库笔记，算出 from → to 要改写的那些（按路径排序）。不合法的 UTF-8 笔记要改写时整个操作拒绝（写回会损坏字节）
// shortcut: 每次都在主进程里同步解析所有含链接的笔记，10k 库会让主进程卡几秒；变慢时改用索引的 links 表预筛候选
export async function planRename(root: string, from: string, to: string): Promise<NotePlan[]> {
  const notes = (await scanEntries(root)).filter((e) => !e.dir && e.path.endsWith('.md')).map((e) => e.path)
  const group = (paths: string[]) => {
    const m = new Map<string, string[]>()
    for (const p of paths) m.set(noteName(p), [...(m.get(noteName(p)) ?? []), p])
    return m
  }
  const groups = [group(notes), group(notes.map((p) => movePath(p, from, to)))]
  const wiki = (name: string, after: boolean) => pickWiki(name, groups[+after].get(name) ?? [])
  const out: NotePlan[] = []
  await Promise.all(
    notes.map(async (p) => {
      const bytes = await fs.readFile(path.join(root, p))
      const before = bytes.toString('utf8')
      // 链接地址只出现在 `](`、引用定义 `]:` 和 `[[` 之后，没有这些的笔记不用解析
      const edits = /\]\(|\]:|\[\[/.test(before) ? rewriteEdits(before, p, from, to, wiki) : []
      if (!edits.length) return
      if (!Buffer.from(before).equals(bytes)) throw new Error(`not valid UTF-8, cannot rewrite links in ${p}`)
      const abs = await realParentInVault(root, p)
      out.push({ path: p, abs, bytes, before, edits, mode: (await fs.stat(abs)).mode })
    }),
  )
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

export type Ops = Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'unlink' | 'chmod'>

let tmpSeq = 0
// 临时文件和目标同目录（同一文件系统，rename 是原子的），点开头：文件树、索引都不看
const tmpOf = (abs: string) => path.join(path.dirname(abs), `.${path.basename(abs)}.synote-${process.pid}-${++tmpSeq}.tmp`)

async function put(ops: Ops, abs: string, data: string | Buffer, mode: number): Promise<void> {
  const tmp = tmpOf(abs)
  try {
    await ops.writeFile(tmp, data, { flag: 'wx' })
    await ops.chmod(tmp, mode)
    await ops.rename(tmp, abs)
  } catch (e) {
    await ops.unlink(tmp).catch(() => {})
    throw e
  }
}

// 原子地执行一次重命名：
// 1. 每篇要改写的笔记逐字节比对，自 planRename 读取后被改过就整个放弃（什么都没写）；
// 2. 改写后的正文全部写成同目录的临时文件，任何一个写失败就删掉临时文件放弃（什么都没改）；
// 3. 临时文件逐个 rename 覆盖原文件，再执行 move（先改写、后移动：移到新位置的笔记已是改写后的内容）。
//    第 3 步任何一处失败，已覆盖的笔记用读取时的原始字节（含权限位）写回，未用的临时文件删掉，move 没有发生。
// 回滚的边界：只恢复笔记内容和位置，不恢复 mtime；move 本身要么完成要么没发生（git mv 先拿 index 锁、检查完才动工作区）；
// 比对和覆盖之间仍有极短的窗口，期间外部写入会被覆盖；回滚本身失败时报错并列出没能恢复的文件
export async function commitRename(plans: NotePlan[], move: () => Promise<void>, ops: Ops = fs): Promise<void> {
  for (const p of plans) if (!(await ops.readFile(p.abs)).equals(p.bytes)) throw new Error(`changed since read: ${p.path}`)
  const tmps: string[] = []
  try {
    for (const p of plans) {
      tmps.push(tmpOf(p.abs))
      await ops.writeFile(tmps.at(-1)!, applyEdits(p.before, p.edits), { flag: 'wx' })
      await ops.chmod(tmps.at(-1)!, p.mode)
    }
  } catch (e) {
    await Promise.all(tmps.map((t) => ops.unlink(t).catch(() => {})))
    throw e
  }
  let done = 0
  try {
    for (; done < plans.length; done++) await ops.rename(tmps[done], plans[done].abs)
    await move()
  } catch (e) {
    await Promise.all(tmps.slice(done).map((t) => ops.unlink(t).catch(() => {})))
    const lost: string[] = []
    for (const p of plans.slice(0, done)) await put(ops, p.abs, p.bytes, p.mode).catch(() => lost.push(p.path))
    if (lost.length) throw new Error(`rename failed (${e}) and rollback failed for: ${lost.join(', ')}`)
    throw e
  }
}
