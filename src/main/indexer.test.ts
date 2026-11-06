import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { extractLinks, findMatches, Indexer } from './indexer'

describe('extractLinks', () => {
  test('standard links, wikilinks and loose attachment refs, skipping code', () => {
    const text = [
      '[a](../b/c%20d.md#h) [web](https://x.com/a.md) [self](#top)',
      '![img](../attachments/p.png) <img src="attachments/q.png">',
      '[[同名]] [[dir/sub|别名]] [[x#标题]]',
      '`[[行内代码]]` ',
      '```',
      '[fake](fake.md) [[围栏]]',
      '```',
      '[用][ref]',
      '',
      '[ref]: ./r.md',
      '[unused]: ./u.md',
    ].join('\n')
    const links = extractLinks('n/note.md', text).map((l) => `${l.kind}:${l.dst}`)
    expect(links.sort()).toEqual(
      // 宽松规则在每个可能的切点都算一处（p.png) 是多出来的，多算不会误判孤儿）
      ['note:b/c d.md', 'att:attachments/p.png', 'att:attachments/p.png)', 'att:attachments/q.png', 'wiki:同名', 'note:dir/sub.md', 'wiki:x', 'note:n/r.md'].sort(),
    )
  })

  test('reference links count where they are used, every use, not at the definition', () => {
    const text = ['全写 [目标][r]', '折叠 [r][] 简写 [r]', '', '另一处 [又][R]', '', '[r]: sub/t.md', '[^1]: 脚注.md'].join('\n')
    const at = extractLinks('n.md', text).map((l) => `${l.kind}:${l.dst}@${text.slice(0, l.at).split('\n').length}`)
    expect(at).toEqual(['note:sub/t.md@1', 'note:sub/t.md@2', 'note:sub/t.md@2', 'note:sub/t.md@4'])
  })

  test('reserved characters are percent-decoded, <img src> may contain spaces', () => {
    const text = '[b](b%23x.md#h) [q](q%3F.md?v=1) <img src="attachments/a b.png"> <img src=\'../attachments/c%20d.png\'>'
    const links = extractLinks('note.md', text).map((l) => `${l.kind}:${l.dst}`)
    expect(links.sort()).toEqual(['note:b#x.md', 'note:q?.md', 'att:attachments/a b.png', 'att:attachments/c d.png'].sort())
  })
})

// 附件引用和渲染进程同一套解析：文件名里的 [ ] ( )、?query / #fragment、百分号编码、尖括号、实体、引用式、按笔记目录解析；
// 代码块里的同样要算上（只能走宽松规则）
test('attachment refs keep brackets and parens, drop query and fragment', () => {
  const files = ['report[1].pdf', 'a(1).png', 'book.pdf', 'x.png', 'y z.png', 'r&d.png', 'ref.png', 'img.png']
  const text = [
    '[报告](../attachments/report[1].pdf) ![](../attachments/a(1).png) [书](/attachments/book.pdf#page=2)',
    '![](../attachments/x.png?v=1) ![](<../attachments/y z.png>) ![](../attachments/r&amp;d.png) ![图][id]',
    '<img src="../attachments/img.png?w=1">',
    '',
    '[id]: ../attachments/ref.png "标题"',
  ].join('\n')
  const atts = (src: string, t: string) => new Set(extractLinks(src, t).filter((l) => l.kind === 'att').map((l) => l.dst))
  const got = atts('sub/n.md', text)
  for (const f of files) expect(got).toContain(`attachments/${f}`)
  const fenced = atts('n.md', '```\n![](attachments/report[1].pdf) ![](attachments/a(1).png) [](attachments/book.pdf#p=2) ![](attachments/y%20z.png)\n```')
  for (const f of ['report[1].pdf', 'a(1).png', 'book.pdf', 'y z.png']) expect(fenced).toContain(`attachments/${f}`)
})

test('<img src> with surrounding whitespace still counts as a reference', () => {
  const links = extractLinks('note.md', '<img src=" attachments/a.png "> <img src="attachments/b c.png\t">').map((l) => `${l.kind}:${l.dst}`)
  expect(links.sort()).toEqual(['att:attachments/a.png', 'att:attachments/b c.png'])
})

describe('findMatches', () => {
  test('line, column and per-line snippet for every occurrence, CRLF-safe', () => {
    const body = '第一行 Foo\r\n第二行 foo 和 FOO\n' + 'x'.repeat(60) + 'foo'
    const m = findMatches(body, 'foo')
    expect(m.map((x) => [x.line, x.col])).toEqual([[1, 4], [2, 4], [2, 10], [3, 60]])
    for (const x of m) expect(x.text.slice(x.start, x.start + 3).toLowerCase()).toBe('foo')
    expect(m[0].text).toBe('第一行 Foo')
    expect(m[3].text.startsWith('…')).toBe(true)
  })
})

describe('Indexer', () => {
  let idx: Indexer | null = null
  afterEach(() => idx?.close())

  function setup(files: Record<string, string>) {
    const base = mkdtempSync(path.join(tmpdir(), 'synote-index-'))
    const root = path.join(base, 'vault')
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
      writeFileSync(path.join(root, p), c)
    }
    const onChange = vi.fn()
    idx = new Indexer(path.join(base, 'index.db'), root, onChange)
    return { root, base, idx, onChange, write: (p: string, c: string) => writeFileSync(path.join(root, p), c) }
  }

  test('backlinks, attachment refs, orphans and search', async () => {
    const { idx } = setup({
      'a.md': '链接到 [b](b.md) 和 [[c]]，![](attachments/used.png) ![](attachments/lfs.png)',
      'sub/c.md': '实时预览很好用 Hello World',
      'b.md': '',
      'attachments/used.png': 'x',
      'attachments/orphan.png': 'y',
      // LFS 指针（S17）：引用和孤儿照样按路径判断，不因内容是指针而算缺失或孤儿
      'attachments/lfs.png': `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 9\n`,
      '.git/x.md': '[b](../b.md)',
    })
    await idx.reconcile()
    await idx.idle()
    expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['a.md'])
    expect(idx.backlinks('sub/c.md').map((b) => b.path)).toEqual(['a.md'])
    expect(idx.attachmentRefs('attachments/used.png')).toBe(1)
    expect(idx.attachmentRefs('attachments/lfs.png')).toBe(1)
    expect(idx.orphans()).toEqual(['attachments/orphan.png'])
    expect(idx.search('时预览').map((h) => h.path)).toEqual(['sub/c.md'])
    expect(idx.search('预览').map((h) => h.path)).toEqual(['sub/c.md']) // 2 字走 LIKE
    expect(idx.search('hello').map((h) => h.path)).toEqual(['sub/c.md'])
    expect(idx.search('100%')).toEqual([])
    expect(idx.search('hello')[0].matches).toEqual([{ line: 1, col: 8, text: '实时预览很好用 Hello World', start: 8 }])
  })

  test('backlinks list each line that links, reference links at the use site', async () => {
    const { idx } = setup({ 'a.md': '正文 [目标][r]\n\n别处 [[t]] 和 [再][r]\n\n[r]: t.md', 't.md': '' })
    await idx.reconcile()
    await idx.idle()
    expect(idx.backlinks('t.md')).toEqual([
      { path: 'a.md', line: 1, text: '正文 [目标][r]' },
      { path: 'a.md', line: 3, text: '别处 [[t]] 和 [再][r]' },
    ])
  })

  test('backlinks carry the line of each link; [[name]] resolves to the smallest path', async () => {
    const { idx } = setup({
      'a.md': '# A\r\n\r\n前文 [去 b](sub/b%20b.md#第二节) 后文\r\n[再一次](sub/b%20b.md)',
      'w.md': '首行\n\n见 [[b b|别名]]',
      'x/b b.md': '',
      'sub/b b.md': '',
      'c.md': '[[x/b b]]',
    })
    await idx.reconcile()
    await idx.idle()
    expect(idx.backlinks('sub/b b.md')).toEqual([
      { path: 'a.md', line: 3, text: '前文 [去 b](sub/b%20b.md#第二节) 后文' },
      { path: 'a.md', line: 4, text: '[再一次](sub/b%20b.md)' },
      { path: 'w.md', line: 3, text: '见 [[b b|别名]]' },
    ])
    expect(idx.backlinks('x/b b.md').map((b) => b.path)).toEqual(['c.md'])
  })

  // 孤儿 = 全库引用计数为 0（S11）：删掉最后一处引用变孤儿，撤销、挪到别的笔记、代码块里的引用都算回来；删笔记也会让附件变孤儿
  test('orphans follow reference edits', async () => {
    const { idx, write, root } = setup({
      'a.md': '![](attachments/p.png)',
      'sub/b.md': '```\n![](../attachments/q.png)\n```',
      'c.md': '[文档](attachments/r.pdf)',
      'attachments/p.png': '',
      'attachments/q.png': '',
      'attachments/r.pdf': '',
    })
    await idx.reconcile()
    expect(idx.orphans()).toEqual([])
    write('a.md', '没有引用了')
    await idx.reconcile()
    expect(idx.orphans()).toEqual(['attachments/p.png'])
    write('sub/b.md', '![](../attachments/p.png) ```\n![](../attachments/q.png)\n```')
    await idx.reconcile()
    expect(idx.orphans()).toEqual([])
    rmSync(path.join(root, 'c.md'))
    await idx.reconcile()
    expect(idx.orphans()).toEqual(['attachments/r.pdf'])
  })

  // 大小写别名（codex #47 第二轮）：不区分大小写的文件系统上 report.png 也指向 Report.PNG，统一按引用存在处理
  test('references match attachments case-insensitively', async () => {
    const { idx } = setup({ 'a.md': '![](attachments/report.png)', 'b.md': '见 PHOTO.jpg', 'attachments/Report.PNG': '', 'attachments/photo.JPG': '' })
    await idx.reconcile()
    await idx.idle()
    expect(idx.orphans()).toEqual(['attachments/photo.JPG'])
    expect(idx.referenced(['attachments/Report.PNG', 'attachments/photo.JPG'])).toEqual(['attachments/Report.PNG'])
    expect(idx.mentioned(['attachments/photo.JPG'])).toEqual(['attachments/photo.JPG'])
  })

  // 第二道防线：文件名原样或百分号编码出现在任一正文里就算提到（含还没写进全文索引的）
  test('mentioned finds attachment names anywhere in note text', async () => {
    const { idx, write } = setup({ 'a.md': '截图见 shot.png', 'b.md': 'y%20z.png', 'attachments/shot.png': '', 'attachments/y z.png': '', 'attachments/none.png': '' })
    await idx.reconcile()
    await idx.idle()
    expect(idx.orphans()).toEqual(['attachments/none.png', 'attachments/shot.png', 'attachments/y z.png'])
    expect(idx.mentioned(idx.orphans())).toEqual(['attachments/shot.png', 'attachments/y z.png'])
    write('a.md', '提到 none.png')
    await idx.reconcile() // 不等 idle：新正文可能还在内存里
    expect(idx.mentioned(['attachments/none.png'])).toEqual(['attachments/none.png'])
  })

  test('short queries are ranked by occurrence count', async () => {
    const { idx } = setup({ 'a.md': '预览', 'b.md': '预览 预览 预览', 'c.md': '预览 预览' })
    await idx.reconcile()
    await idx.idle()
    expect(idx.search('预览').map((h) => h.path)).toEqual(['b.md', 'c.md', 'a.md'])
  })

  test('search falls back to in-memory scan before full text is written', async () => {
    const { idx } = setup({ 'a.md': '尚未写入全文索引' })
    await idx.reconcile() // 不等 idle：全文还在后台写
    expect(idx.search('全文索引').map((h) => h.path)).toEqual(['a.md'])
    await idx.idle()
    expect(idx.search('全文索引').map((h) => h.path)).toEqual(['a.md'])
  })

  test('in-memory fallback hits are ranked with indexed hits, not cut off', async () => {
    const files = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`n${String(i).padStart(2, '0')}.md`, '关键词']))
    const { idx } = setup(files)
    await idx.reconcile()
    await idx.idle()
    // 模拟分批写全文的批间状态：n50 的新正文还在内存里，全文索引里是旧的（首批在 reconcile 返回前就同步写完了，没法靠时序构造）
    idx['pending'].set('n50.md', '关键词 关键词 关键词')
    for (const q of ['关键词', '关键']) {
      const hits = idx.search(q)
      expect(hits).toHaveLength(50)
      expect(hits[0].path).toBe('n50.md')
    }
  })

  test('reopening an existing index only re-reads changed files', async () => {
    const { base, root, idx: first, onChange } = setup({ 'a.md': '[b](b.md)', 'b.md': '' })
    await first.reconcile()
    await first.idle()
    first.close()
    writeFileSync(path.join(root, 'b.md'), '[a](a.md)')
    idx = new Indexer(path.join(base, 'index.db'), root, onChange)
    expect(await idx.reconcile()).toEqual(['b.md'])
    expect(idx.backlinks('a.md').map((b) => b.path)).toEqual(['b.md'])
  })

  test('rebuild', async () => {
    const { idx } = setup({ 'a.md': '[b](b.md)' })
    await idx.reconcile()
    await idx.rebuild()
    await idx.idle()
    expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['a.md'])
  })

  // FSEvents 流启动前的改动收不到事件：watch() 之后补一次对账兜底
  test('changes in the watcher startup window are caught by a follow-up reconcile', async () => {
    const { idx, write } = setup({ 'a.md': '', 'b.md': '' })
    idx.watch()
    await idx.reconcile()
    idx['watcher']!.close() // 模拟启动窗口里事件全丢
    write('a.md', '[b](b.md)')
    await vi.waitFor(() => expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['a.md']), { timeout: 3000, interval: 100 })
  })

  // 验收：外部编辑器改动、删除、改名文件后索引正确更新（走真实 fs.watch）
  test('external edit, delete and rename via watcher', async () => {
    const { root, idx, write, onChange } = setup({ 'a.md': '', 'b.md': '', 'dir/c.md': '[b](../b.md) 旧内容' })
    await idx.reconcile()
    idx.watch()
    const settled = async (check: () => void) => {
      await vi.waitFor(check, { timeout: 3000, interval: 50 })
      await idx.idle()
    }
    // macOS 上 fs.watch 返回时 FSEvents 流还没真正启动（libuv 在另一个线程里异步创建，只报启动之后的事件），
    // 紧接着的写入会丢；先反复写探针文件，直到 watcher 确实收到一次，再开始验收步骤。间隔要大于 150 ms 的防抖
    let n = 0
    await vi.waitFor(
      () => {
        if (onChange.mock.calls.some(([paths]) => paths.includes('probe.md'))) return
        write('probe.md', String(n++))
        throw new Error('watcher not live yet')
      },
      { timeout: 3000, interval: 300 },
    )
    await idx.idle()

    write('a.md', '[b](b.md) 新内容')
    await settled(() => expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['a.md', 'dir/c.md']))
    expect(idx.search('新内容').map((h) => h.path)).toEqual(['a.md'])

    rmSync(path.join(root, 'a.md'))
    await settled(() => expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['dir/c.md']))
    expect(idx.search('新内容')).toEqual([])

    renameSync(path.join(root, 'dir'), path.join(root, 'moved'))
    await settled(() => expect(idx.backlinks('b.md').map((b) => b.path)).toEqual(['moved/c.md']))
    expect(idx.search('旧内容').map((h) => h.path)).toEqual(['moved/c.md'])
  })
})

// 性能验收（10k 篇），默认不跑：SYNOTE_BENCH=1 pnpm test indexer
test.runIf(process.env.SYNOTE_BENCH)('bench 10k notes', { timeout: 120_000 }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-bench-'))
  const root = path.join(base, 'vault')
  mkdirSync(path.join(root, 'attachments'), { recursive: true })
  for (let d = 0; d < 100; d++) mkdirSync(path.join(root, `d${d}`))
  for (let i = 0; i < 10_000; i++) {
    const body = `# 笔记 ${i}\n\n${'这是一段用于基准测试的中文正文，混有 English words。'.repeat(35)}\n[next](../d${(i + 1) % 100}/n${i + 1}.md) [[n${i + 7}]] ![](../attachments/a${i % 3000}.png)\n`
    writeFileSync(path.join(root, `d${i % 100}`, `n${i}.md`), body)
  }
  for (let i = 0; i < 3000; i++) writeFileSync(path.join(root, 'attachments', `a${i}.png`), '')
  const db = path.join(base, 'index.db')

  let t = performance.now()
  const first = new Indexer(db, root)
  await first.reconcile()
  const linksReady = performance.now() - t
  expect(first.backlinks('d1/n1.md').map((b) => b.path)).toEqual(['d0/n0.md'])
  await first.idle()
  const full = performance.now() - t
  first.close()

  t = performance.now()
  const again = new Indexer(db, root)
  await again.reconcile()
  const reopen = performance.now() - t
  // 每条都命中全部 10k 篇，是最坏情况
  const searches = Object.fromEntries(
    ['基准测试', 'English words', '中文', 'En'].map((q) => {
      t = performance.now()
      expect(again.search(q)).toHaveLength(50)
      return [q, performance.now() - t]
    }),
  )
  again.close()
  const fmt = Object.entries(searches).map(([q, ms]) => `"${q}" ${ms | 0}ms`).join(', ')
  console.log(`[bench] links ready ${linksReady | 0}ms, full ${full | 0}ms, reopen+reconcile ${reopen | 0}ms, search ${fmt}`)
  expect(linksReady).toBeLessThan(1500)
  expect(reopen).toBeLessThan(500)
  for (const ms of Object.values(searches)) expect(ms).toBeLessThan(200)
})
