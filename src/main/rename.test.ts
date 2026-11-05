import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { applyEdits, findLinks } from '../shared/mdLinks'
import { linkTarget, movePath, parseWiki, pickWiki } from '../shared/url'
import { Git } from './git'
import { commitRename, planRename, rewriteEdits } from './rename'

// 只有一篇笔记时 [[名字]] 的解析：notes 是移动前的全部笔记
function rewrite(text: string, note: string, from: string, to: string, notes: string[] = []) {
  const wiki = (name: string, after: boolean) => pickWiki(name, after ? notes.map((p) => movePath(p, from, to)) : notes)
  return applyEdits(text, rewriteEdits(text, note, from, to, wiki))
}

describe('rewriteEdits', () => {
  it('指向被移动笔记的链接：子目录、..、空格、中文', () => {
    expect(rewrite('[b](sub/b.md)', 'a.md', 'sub/b.md', 'sub/c.md')).toBe('[b](sub/c.md)')
    expect(rewrite('[b](../笔记/目标%20笔记.md)', '日记/a.md', '笔记', '归档/笔记')).toBe('[b](../归档/笔记/目标%20笔记.md)')
    expect(rewrite('[b](b.md)', 'x/a.md', 'x/b.md', 'y z/b.md')).toBe('[b](../y%20z/b.md)')
    expect(rewrite('[b](<我的 笔记.md>)', 'a.md', '我的 笔记.md', '新 笔记.md')).toBe('[b](<新%20笔记.md>)')
    expect(rewrite('[根](/sub/b.md)', 'x/a.md', 'sub', 'dir')).toBe('[根](/dir/b.md)')
  })

  it('锚点、query、标题、图片、附件原样保留，只改路径那一段', () => {
    expect(rewrite('[b](sub/b.md#第二节 "标题")', 'a.md', 'sub', 'new')).toBe('[b](new/b.md#第二节 "标题")')
    expect(rewrite('![图](p.png?v=1)', 'n/a.md', 'n/p.png', 'n/q.png')).toBe('![图](q.png?v=1)')
    expect(rewrite('![图](../attachments/x.png)', 'n/a.md', 'n', 'm/n')).toBe('![图](../../attachments/x.png)')
  })

  it('引用式定义改在定义处，几处使用只改一次；未用的定义也改', () => {
    const text = '[一][r] 和 [r][] 和 [r]\n\n[r]: sub/b.md#h\n[unused]: <sub/b.md>\n'
    expect(rewrite(text, 'a.md', 'sub/b.md', 'c.md')).toBe('[一][r] 和 [r][] 和 [r]\n\n[r]: c.md#h\n[unused]: <c.md>\n')
  })

  it('被移动笔记自身的出站链接：仍指向原目标', () => {
    const text = '[a](../a.md) [同目录](c.md) [自身](#标题) [外链](https://x.com/a.md) [b](b.md)'
    expect(rewrite(text, 'x/b.md', 'x/b.md', 'y/z/b.md')).toBe('[a](../../a.md) [同目录](../../x/c.md) [自身](#标题) [外链](https://x.com/a.md) [b](b.md)')
    // 文件夹整体移动：内部互链不变
    expect(rewrite('[c](c.md) [a](../a.md)', 'x/b.md', 'x', 'y/x')).toBe('[c](c.md) [a](../../a.md)')
  })

  it('不相干的、代码里的、切不准的不动', () => {
    const text = '[o](other.md) `[b](b.md)`\n\n```\n[b](b.md)\n```\n[esc](b.md\\#x)'
    expect(rewrite(text, 'a.md', 'b.md', 'c.md')).toBe(text)
    // 实体里的 # 让切分落错位置：和整条地址的解析对不上，不改
    expect(rewrite('[e](b&#46;md)', 'a.md', 'b.md', 'c.md')).toBe('[e](b&#46;md)')
  })

  it('[[...]] 移动后仍能解析到同一篇就保持原样，否则按 ADR 0001 改写成标准链接', () => {
    const notes = ['a.md', 'x/b.md', 'y/b.md']
    // 移动后同名仍唯一 / 仍选中同一篇
    expect(rewrite('[[b]] [[b#标题|别名]]', 'a.md', 'x/b.md', 'z/b.md', ['a.md', 'x/b.md'])).toBe('[[b]] [[b#标题|别名]]')
    expect(rewrite('[[b]]', 'a.md', 'y/b.md', 'z/b.md', notes)).toBe('[[b]]')
    // 改名后不再叫 b；同名里换了一篇被选中；路径写法失效
    expect(rewrite('[[b#My Title|别名]]', 'a.md', 'x/b.md', 'x/c.md', ['a.md', 'x/b.md'])).toBe('[别名](x/c.md#my-title)')
    expect(rewrite('[[b]]', 'a.md', 'x/b.md', 'z/b.md', notes)).toBe('[b](z/b.md)')
    expect(rewrite('[[x/b]]', 'a.md', 'x', 'w', notes)).toBe('[x/b](w/b.md)')
    // 新改出来的同名笔记抢走了原来的 [[c]]
    expect(rewrite('[[c]]', 'a.md', 'x/b.md', 'a/c.md', ['a.md', 'x/b.md', 'z/c.md'])).toBe('[c](z/c.md)')
  })
})

// 临时笔记库：files 写到磁盘，返回根目录和逐字节快照
function vault(files: Record<string, string>) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'synote-rename-')), 'vault')
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    writeFileSync(path.join(root, p), c)
  }
  return root
}
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out[path.relative(root, path.join(f.parentPath, f.name)).split(path.sep).join('/')] = readFileSync(path.join(f.parentPath, f.name)).toString('base64')
  return out
}
const run = async (root: string, from: string, to: string, ops?: Parameters<typeof commitRename>[2]) =>
  commitRename(await planRename(root, from, to), () => fs.rename(path.join(root, from), path.join(root, to)), ops)

// 全库的失效链接：标准链接按 linkTarget、[[...]] 按 parseWiki + pickWiki 解析，目标不存在的
function broken(root: string): string[] {
  const all = Object.keys(snapshot(root))
  const notes = all.filter((p) => p.endsWith('.md'))
  const out: string[] = []
  for (const n of notes) {
    const text = readFileSync(path.join(root, n), 'utf8')
    for (const l of findLinks(parser.parse(text), text)) {
      const w = l.kind === 'wiki' ? parseWiki(l.href) : null
      const t = w ? (w.path ?? pickWiki(w.name!, notes)) : linkTarget(l.href, n)?.path
      if (t && !l.href.startsWith('http') && !existsSync(path.join(root, t))) out.push(`${n}: ${text.slice(l.from, l.to)}`)
    }
  }
  return out
}

const library = {
  'index.md': '[日记](日记/今天.md) [[今天]] [图](日记/图%201.png) [[日记/今天#标题]]\n\n[ref]: 日记/今天.md#标题\n用 [引用][ref]\n',
  '日记/今天.md': '# 标题\n[首页](../index.md) [同目录](明天.md) ![](图%201.png) ![](../attachments/a.png) [[index]]\n',
  '日记/明天.md': '[今天](今天.md#标题) [b](../b/b.md)\r\n',
  '日记/图 1.png': 'png',
  'b/b.md': '[今天](../日记/今天.md)',
  'attachments/a.png': 'a',
}

describe('planRename + commitRename', () => {
  it('移动文件夹后全库没有失效链接，[[...]] 保持原样且能解析', async () => {
    const root = vault({ ...library, '归档/.keep': '' })
    expect(broken(root)).toEqual([])
    const plans = await planRename(root, '日记', '归档/日记')
    expect(plans.map((p) => p.path)).toEqual(['b/b.md', 'index.md', '日记/今天.md', '日记/明天.md'])
    await run(root, '日记', '归档/日记')
    expect(broken(root)).toEqual([])
    const index = readFileSync(path.join(root, 'index.md'), 'utf8')
    expect(index).toBe('[日记](归档/日记/今天.md) [[今天]] [图](归档/日记/图%201.png) [日记/今天#标题](归档/日记/今天.md#标题)\n\n[ref]: 归档/日记/今天.md#标题\n用 [引用][ref]\n')
    // 内部互链不变，CRLF 原样，只改了指向库外的那条
    expect(readFileSync(path.join(root, '归档/日记/明天.md'), 'utf8')).toBe(library['日记/明天.md'].replace('../b/b.md', '../../b/b.md'))
    expect(readdirSync(root, { recursive: true }).filter((f) => String(f).includes('.tmp'))).toEqual([])
  })

  it('重命名笔记：保留权限位', async () => {
    const root = vault(library)
    await fs.chmod(path.join(root, 'index.md'), 0o600)
    await run(root, '日记/今天.md', '日记/昨天.md')
    expect(broken(root)).toEqual([])
    expect(readFileSync(path.join(root, 'index.md'), 'utf8')).toContain('[今天](日记/昨天.md)')
    if (process.platform !== 'win32') expect(statSync(path.join(root, 'index.md')).mode & 0o777).toBe(0o600)
  })

  it('中途某个文件写失败：全库与操作前逐字节一致，不留临时文件', async () => {
    for (const fail of ['writeFile', 'rename'] as const) {
      const root = vault(library)
      const before = snapshot(root)
      let n = 0
      // 第二次调用失败（rename 时第一篇已覆盖，要回滚）
      const ops = { ...fs, [fail]: (...a: unknown[]) => (++n === 2 ? Promise.reject(new Error('injected')) : (fs[fail] as (...a: unknown[]) => Promise<void>)(...a)) }
      await expect(run(root, '日记', 'b/日记', ops)).rejects.toThrow('injected')
      expect(snapshot(root)).toEqual(before)
    }
  })

  it('移动失败：已覆盖的笔记全部回滚', async () => {
    const root = vault(library)
    const before = snapshot(root)
    const plans = await planRename(root, '日记', 'x/日记')
    await expect(commitRename(plans, () => Promise.reject(new Error('mv failed')))).rejects.toThrow('mv failed')
    expect(snapshot(root)).toEqual(before)
  })

  it('读取后被改过：整个放弃，什么都不写', async () => {
    const root = vault(library)
    const plans = await planRename(root, '日记', 'b/日记')
    writeFileSync(path.join(root, 'index.md'), '外部改了 [日记](日记/今天.md)')
    const before = snapshot(root)
    await expect(commitRename(plans, () => fs.rename(path.join(root, '日记'), path.join(root, 'b/日记')))).rejects.toThrow('changed since read: index.md')
    expect(snapshot(root)).toEqual(before)
  })

  it('不合法的 UTF-8 笔记要改写时拒绝', async () => {
    const root = vault({ 'a.md': '', 'b.md': '' })
    writeFileSync(path.join(root, 'a.md'), Buffer.concat([Buffer.from('[b](b.md) '), Buffer.from([0xff])]))
    await expect(planRename(root, 'b.md', 'c.md')).rejects.toThrow('not valid UTF-8')
  })

  it('git 仓库：git mv 保留历史，未跟踪的文件随文件夹移动', async () => {
    const root = vault(library)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root }).toString()
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(path.join(root, '日记/草稿.md'), '[首页](../index.md)')
    const g = new Git('git', process.env.PATH ?? '', root)
    await commitRename(await planRename(root, '日记', 'b/日记'), async () => void (await g.mv('日记', 'b/日记')))
    expect(broken(root)).toEqual([])
    expect(readFileSync(path.join(root, 'b/日记/草稿.md'), 'utf8')).toBe('[首页](../../index.md)')
    expect(git('-c', 'core.quotepath=off', 'status', '--porcelain').split('\n').filter((l) => l.startsWith('R')).length).toBe(3)
  })
})
