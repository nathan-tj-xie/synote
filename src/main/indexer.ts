// 索引服务核心（S6）：链接图、文件 mtime/size、FTS5 trigram 全文放在同一个 SQLite 库（调研见 #10）
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as tick } from 'node:timers/promises'
import { parser } from '@lezer/markdown'
import type { Backlink, SearchHit, SearchMatch } from '../shared/api'
import { decodeComponent, destination, parseWiki, pickWiki, resolveLink, WIKI } from '../shared/url'
import { isHidden, toPosix } from './vault'

const VERSION = 2
const BATCH = 200

type Link = { dst: string; kind: 'note' | 'wiki' | 'att'; at: number } // at：在正文里第一次出现的偏移，反链的上下文用
type Stat = { mtime: number; size: number }

const isNote = (rel: string) => rel.endsWith('.md') && !isHidden(rel)
const isAtt = (rel: string) => rel.startsWith('attachments/') && !rel.split('/').some((p) => p.startsWith('.'))
const noteName = (rel: string) => (isNote(rel) ? path.posix.basename(rel, '.md') : null)

// 标准链接走 lezer（排除代码），[[...]] 只扫非代码区，附件引用在全文上宽松识别（宁可多算，不误判孤儿）。
// 链接地址和 [[...]] 的解析与实时预览、跳转共用 shared/url.ts
export function extractLinks(src: string, text: string): Link[] {
  const out = new Map<string, Link>()
  const add = (l: Link) => out.has(`${l.kind}\0${l.dst}`) || out.set(`${l.kind}\0${l.dst}`, l)
  const code: [number, number][] = []
  parser.parse(text).iterate({
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') {
        code.push([n.from, n.to])
        return false
      }
      if (n.name !== 'URL') return
      const href = destination(text.slice(n.from, n.to))
      if (href.startsWith('#')) return // 笔记内的锚点不算双链
      const dst = resolveLink(href, src)
      if (dst?.endsWith('.md')) add({ dst, kind: 'note', at: n.from })
    },
  })
  for (const m of text.matchAll(WIKI)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue
    const w = parseWiki(m[1])
    if (w?.path) add({ dst: w.path, kind: 'note', at: m.index })
    else if (w?.name) add({ dst: w.name, kind: 'wiki', at: m.index })
  }
  // <img src="..."> 有引号界定，路径里可以有空格；先认出来，下面的通用规则跳过这些范围
  const quoted: [number, number][] = []
  for (const m of text.matchAll(/\bsrc\s*=\s*(["'])[^"'\n]*?attachments\/([^"'\n]+)\1/gi)) {
    quoted.push([m.index, m.index + m[0].length])
    add({ dst: `attachments/${decodeComponent(m[2].trim())}`, kind: 'att', at: m.index }) // 引号里的首尾空白不属于路径
  }
  for (const m of text.matchAll(/attachments\/([^\s)"'<>\]|`]+)/g)) {
    if (quoted.some(([a, b]) => m.index >= a && m.index < b)) continue
    add({ dst: `attachments/${decodeComponent(m[1])}`, kind: 'att', at: m.index })
  }
  return [...out.values()]
}

// 只走笔记和 attachments/，跳过 .git 等隐藏目录
async function walk(root: string): Promise<Map<string, Stat>> {
  const out = new Map<string, Stat>()
  async function dir(rel: string): Promise<void> {
    const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
    await Promise.all(
      dirents.map(async (d) => {
        const p = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (p === 'attachments' || !isHidden(p)) await dir(p)
        } else if (d.isFile() && (isNote(p) || isAtt(p))) {
          const s = await fs.stat(path.join(root, p)).catch(() => null)
          if (s) out.set(p, { mtime: s.mtimeMs, size: s.size })
        }
      }),
    )
  }
  await dir('')
  return out
}

// shortcut: 每个文件最多列 20 处命中，有人要看全部时再做“展开更多”
const MAX_MATCHES = 20

// 列出正文里的每处命中：行号 + 列号（CRLF 下也和 CM6 的行对得上），每行截取命中前后一段做摘要
export function findMatches(body: string, q: string): SearchMatch[] {
  // shortcut: 假设 toLowerCase 不改变长度（个别字符如 İ 例外，列号会偏），遇到再按码点比较
  const lower = body.toLowerCase()
  const needle = q.toLowerCase()
  const out: SearchMatch[] = []
  let line = 1
  let lineStart = 0
  for (let i = lower.indexOf(needle); i >= 0 && out.length < MAX_MATCHES; i = lower.indexOf(needle, i + needle.length)) {
    for (let j = body.indexOf('\n', lineStart); j >= 0 && j < i; j = body.indexOf('\n', lineStart)) {
      line++
      lineStart = j + 1
    }
    let end = body.indexOf('\n', i)
    if (end < 0) end = body.length
    const col = i - lineStart
    const from = Math.max(lineStart, i - 40)
    const prefix = from > lineStart ? '…' : ''
    const text = prefix + body.slice(from, Math.min(end, i + q.length + 80)).replace(/\s/g, ' ').trimEnd()
    out.push({ line, col, text, start: prefix.length + i - from })
  }
  return out
}

export class Indexer {
  private db: DatabaseSync
  // 已进链接图、还没写进全文索引的正文；搜索时对它做内存扫描兜底
  private pending = new Map<string, string>()
  private flushing: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | null = null
  private settle: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    dbFile: string,
    private root: string,
    private onChange: (paths: string[]) => void = () => {},
  ) {
    this.db = new DatabaseSync(dbFile)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (user_version !== VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS fts;
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT, mtime REAL, size INTEGER);
        CREATE INDEX files_name ON files(name);
        CREATE TABLE links (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, pos INTEGER NOT NULL);
        CREATE INDEX links_src ON links(src);
        CREATE INDEX links_dst ON links(kind, dst);
        CREATE VIRTUAL TABLE fts USING fts5(body, tokenize = 'trigram');
        PRAGMA user_version = ${VERSION};
      `)
    }
  }

  // 打开库、外部改动、git 操作之后都调这个：stat 对账，变了的重新解析（S12 在 git 操作后调用）
  reconcile(): Promise<string[]> {
    const run = this.queue.then(() => this.doReconcile())
    this.queue = run.catch(() => {})
    return run
  }

  private async doReconcile(): Promise<string[]> {
    if (this.closed) return []
    const disk = await walk(this.root)
    const known = new Map(
      (this.db.prepare('SELECT path, mtime, size FROM files').all() as { path: string; mtime: number; size: number }[]).map(
        (r) => [r.path, r],
      ),
    )
    const gone = [...known.keys()].filter((p) => !disk.has(p))
    const dirty = [...disk].filter(([p, s]) => {
      const k = known.get(p)
      return !k || k.mtime !== s.mtime || k.size !== s.size
    })
    if (this.closed || (!gone.length && !dirty.length)) return []
    const texts = await Promise.all(
      dirty.map(([p]) => (isNote(p) ? fs.readFile(path.join(this.root, p), 'utf8').catch(() => null) : '')),
    )

    const delFile = this.db.prepare('DELETE FROM files WHERE path = ? RETURNING id')
    const delLinks = this.db.prepare('DELETE FROM links WHERE src = ?')
    const delFts = this.db.prepare('DELETE FROM fts WHERE rowid = ?')
    const upsert = this.db.prepare(
      'INSERT INTO files (path, name, mtime, size) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size',
    )
    const addLink = this.db.prepare('INSERT INTO links (src, dst, kind, pos) VALUES (?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const p of gone) {
        const row = delFile.get(p) as { id: number } | undefined
        if (row) delFts.run(row.id)
        delLinks.run(p)
        this.pending.delete(p)
      }
      dirty.forEach(([p, s], i) => {
        const text = texts[i]
        if (text === null) return // 读的时候已被删：下一轮对账再处理
        upsert.run(p, noteName(p), s.mtime, s.size)
        if (!isNote(p)) return
        delLinks.run(p)
        for (const l of extractLinks(p, text)) addLink.run(p, l.dst, l.kind, l.at)
        this.pending.set(p, text)
      })
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    const changed = [...gone, ...dirty.map(([p]) => p)]
    this.onChange(changed)
    this.flushing ??= this.flush().finally(() => (this.flushing = null))
    return changed
  }

  // 全文分批后台写入，批间让出事件循环，期间反链和搜索照常可用
  private async flush(): Promise<void> {
    const getId = this.db.prepare('SELECT id FROM files WHERE path = ?')
    const del = this.db.prepare('DELETE FROM fts WHERE rowid = ?')
    const ins = this.db.prepare('INSERT INTO fts (rowid, body) VALUES (?, ?)')
    while (this.pending.size && !this.closed) {
      const batch = [...this.pending].slice(0, BATCH)
      this.db.exec('BEGIN')
      for (const [p, body] of batch) {
        const row = getId.get(p) as { id: number } | undefined
        if (row) {
          del.run(row.id)
          ins.run(row.id, body)
        }
      }
      this.db.exec('COMMIT')
      for (const [p, body] of batch) if (this.pending.get(p) === body) this.pending.delete(p)
      await tick()
    }
  }

  // 等全文写完（测试和"重建索引"用）
  async idle(): Promise<void> {
    await this.queue
    while (this.flushing) await this.flushing
  }

  // 指向 p 的笔记，带第一处链接所在的行和这一行的文字（上下文片段）
  backlinks(p: string): Backlink[] {
    const name = noteName(p)
    // [[同名]] 指向多篇时由 pickWiki 选定（和实时预览、跳转同一规则），p 是被选中的那篇才算
    const same = name === null ? [] : (this.db.prepare('SELECT path FROM files WHERE name = ?').all(name) as { path: string }[])
    const wiki = name !== null && pickWiki(name, same.map((r) => r.path)) === p ? 1 : 0
    const rows = this.db
      .prepare(
        `SELECT src, min(pos) AS pos FROM links WHERE (kind = 'note' AND dst = :p) OR (:wiki AND kind = 'wiki' AND dst = :name)
         GROUP BY src ORDER BY src`,
      )
      .all({ p, name, wiki }) as { src: string; pos: number }[]
    const body = this.db.prepare('SELECT fts.body FROM fts JOIN files f ON f.id = fts.rowid WHERE f.path = ?')
    return rows.map(({ src, pos }) => {
      const text = this.pending.get(src) ?? (body.get(src) as { body: string } | undefined)?.body ?? ''
      const start = text.lastIndexOf('\n', pos - 1) + 1
      const end = text.indexOf('\n', pos)
      // shortcut: 片段只取链接所在的整行（过长截断），不按句子切，有人嫌长短不齐时再改
      const snippet = text.slice(start, end < 0 ? text.length : end).trim().slice(0, 200)
      return { path: src, line: text.slice(0, start).split('\n').length, text: snippet }
    })
  }

  attachmentRefs(p: string): number {
    const row = this.db.prepare("SELECT count(DISTINCT src) AS n FROM links WHERE kind = 'att' AND dst = ?").get(p) as { n: number }
    return row.n
  }

  orphans(): string[] {
    const rows = this.db
      .prepare(
        "SELECT path FROM files WHERE path LIKE 'attachments/%' AND path NOT IN (SELECT dst FROM links WHERE kind = 'att') ORDER BY path",
      )
      .all() as { path: string }[]
    return rows.map((r) => r.path)
  }

  // ≥ 3 字走 trigram MATCH（BM25 排序）；1–2 字只能 LIKE 全表扫描，按出现次数排序
  search(q: string, limit = 50): SearchHit[] {
    q = q.trim()
    if (!q) return []
    const fts = [...q].length >= 3
    // shortcut: LIKE 分支的次数用 replace() 数，区分大小写，英文大小写混写时偏少，只影响排序
    const sql = fts
      ? 'SELECT f.path, fts.body FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH :arg ORDER BY rank LIMIT :n'
      : `SELECT f.path, fts.body FROM fts JOIN files f ON f.id = fts.rowid WHERE fts.body LIKE :arg ESCAPE '\\'
         ORDER BY length(fts.body) - length(replace(fts.body, :q, '')) DESC, f.path LIMIT :n`
    const arg = fts ? `"${q.replaceAll('"', '""')}"` : `%${q.replace(/[\\%_]/g, '\\$&')}%`
    const params: Record<string, string | number> = { arg, n: limit + this.pending.size }
    if (!fts) params.q = q
    const rows = this.db.prepare(sql).all(params) as { path: string; body: string }[]
    const hits = rows.filter((r) => !this.pending.has(r.path)).map((r) => ({ path: r.path, matches: findMatches(r.body, q) }))
    const before = hits.length
    for (const [p, body] of this.pending) {
      const matches = findMatches(body, q)
      if (matches.length) hits.push({ path: p, matches })
    }
    // 有内存兜底的结果时没法和 BM25 比，统一由应用层按命中次数排（同 LIKE 分支），再截断
    if (hits.length > before) hits.sort((a, b) => b.matches.length - a.matches.length || (a.path < b.path ? -1 : 1))
    return hits.slice(0, limit)
  }

  async rebuild(): Promise<void> {
    await this.idle()
    this.db.exec('DELETE FROM files; DELETE FROM links; DELETE FROM fts')
    this.pending.clear()
    await this.reconcile()
  }

  // shortcut: 每批外部改动都全库 stat 对账（10k 约 100 ms）而不是按路径增量，事件多到成为瓶颈时再改
  watch(): void {
    let timer: NodeJS.Timeout | undefined
    this.watcher = watch(this.root, { recursive: true }, (_e, f) => {
      const rel = f ? toPosix(f.toString()) : ''
      if (rel.startsWith('.git/') || rel === '.git') return
      clearTimeout(timer)
      timer = setTimeout(() => !this.closed && this.reconcile().catch((e) => console.error('[index] reconcile failed', e)), 150)
    })
    // macOS 上 fs.watch 返回时 FSEvents 流还没启动（libuv 在另一个线程里异步创建），这段时间的改动没有事件；
    // 等流起来后再对账一次兜底。shortcut: 固定等 1 s（加压实测 300 ms 内已就绪），有就绪信号的 watcher 时改掉
    this.settle = setTimeout(() => !this.closed && this.reconcile().catch((e) => console.error('[index] reconcile failed', e)), 1000)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.settle)
    this.watcher?.close()
    this.db.close()
  }
}
