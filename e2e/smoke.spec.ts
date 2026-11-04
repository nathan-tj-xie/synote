import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 临时笔记库 + 独立 userData，启动后等文件树出来；给了 recent 时按它写最近列表，不等文件树
async function launch(files: Record<string, string>, recent?: (vault: string) => string[]) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(vault)
  mkdirSync(userData)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, p)), { recursive: true })
    writeFileSync(path.join(vault, p), c)
  }
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify(recent?.(vault) ?? [vault]))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  if (!recent) await expect(win.getByRole('tree')).toBeVisible()
  return { app, win, vault }
}

// 另建一个笔记库，.synote/config.json 是 FIFO：主进程开这个库时读配置会一直卡住，release() 写入后才放行，
// 用来把“开库进行中”的窗口拉长到测试可控（Windows 没有 mkfifo）
function blockedVault(base: string, name: string, files: Record<string, string>) {
  const dir = path.join(base, name)
  mkdirSync(path.join(dir, '.synote'), { recursive: true })
  for (const [p, c] of Object.entries(files)) writeFileSync(path.join(dir, p), c)
  const fifo = path.join(dir, '.synote', 'config.json')
  execFileSync('mkfifo', [fifo])
  // 非阻塞打开写端：读端（主进程）还没打开时 ENXIO，轮询到读端就绪再写
  const release = () =>
    expect
      .poll(() => {
        try {
          const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
          writeSync(fd, '{}')
          closeSync(fd)
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
  return { dir, release }
}

// 从欢迎页依次点开几个库：最近列表第一项不存在，自动打开失败后停在欢迎页
async function launchWelcome(dirs: string[]) {
  const { app, win } = await launch({}, (v) => [v + '-missing', ...dirs])
  for (const d of dirs) await win.getByRole('button', { name: d }).click()
  return { app, win }
}

// 主进程下一次写 recent.json（切库 commit 的第一步）时停 ms 毫秒，把“commit 进行中”的窗口拉长；返回是否已停住
async function holdRecentWrite(app: ElectronApplication, ms: number) {
  await app.evaluate((_m, ms) => {
    const fs = process.getBuiltinModule('node:fs').promises
    const orig = fs.writeFile
    const g = globalThis as { held?: boolean }
    g.held = false
    fs.writeFile = (async (file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('recent.json') && !g.held) {
        g.held = true
        await new Promise((r) => setTimeout(r, ms))
      }
      return (orig as (...a: unknown[]) => Promise<void>)(file, ...rest)
    }) as typeof fs.writeFile
  }, ms)
  return () => app.evaluate(() => (globalThis as { held?: boolean }).held)
}

// 把主进程的 file:read / file:write 换成第一次（all 时每次）调用晚 ms 毫秒才回的版本，用来复现 IPC 乱序；
// read 立即读盘、晚回结果（拿到的是旧快照），write 晚落盘。替换后不经过主进程的笔记库校验
async function slowFirstCall(app: ElectronApplication, channel: 'file:read' | 'file:write', ms: number, all = false) {
  await app.evaluate(
    ({ ipcMain }, { channel, ms, all }) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const g = globalThis as { slow?: { calls: number; done: number } }
      const slow = (g.slow = { calls: 0, done: 0 })
      const wait = () => new Promise((r) => setTimeout(r, slow.calls++ === 0 || all ? ms : 0))
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_e, vault: string, rel: string, content: string) => {
        const file = `${vault}/${rel}`
        try {
          if (channel === 'file:write') return await wait().then(() => fs.writeFile(file, content))
          const text = fs.readFile(file, 'utf8')
          await wait()
          return await text
        } finally {
          slow.done++
        }
      })
    },
    { channel, ms, all },
  )
  return (key: 'calls' | 'done') => app.evaluate((_m, key) => (globalThis as { slow?: Record<string, number> }).slow![key], key)
}

// 点标签切换：点左边的文字。点中心的话，悬停后才显示的 × 可能正好在中心（Windows 字体更窄），点成关闭
const clickTab = (win: Page, name: string) => win.getByRole('tab', { name }).click({ position: { x: 14, y: 17 } })

// 冒烟测试：打开笔记库 → 文件树 → 编辑并自动保存 → 外部改动重新加载
test('open vault, edit, save, reload external change', async () => {
  const { app, win, vault } = await launch({ '日记/今天.md': '# 今天\n', 'attachments/a.png': '' })

  const tree = win.getByRole('tree')
  await expect(tree.getByRole('treeitem', { name: '日记' })).toBeVisible()
  await expect(tree.getByText('attachments')).toHaveCount(0)

  await tree.getByRole('treeitem', { name: '日记' }).click()
  await tree.getByRole('treeitem', { name: '今天.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toContainText('# 今天')

  await editor.click()
  await win.keyboard.press('End')
  await win.keyboard.type('写点东西')
  const file = path.join(vault, '日记', '今天.md')
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 5000 }).toContain('写点东西')

  writeFileSync(file, '# 外部改的\n')
  await expect(editor).toContainText('# 外部改的', { timeout: 5000 })

  // 非 git 目录：上面的笔记库本身就不是 git 仓库，没有报错即可；打开库不创建 .synote/config.json，写配置时才创建
  await expect(win.getByRole('alert')).toHaveCount(0)
  expect(existsSync(path.join(vault, '.synote'))).toBe(false)
  await win.evaluate((v) => window.synote.writeConfig(v, { k: 1 }), vault)
  expect(JSON.parse(readFileSync(path.join(vault, '.synote', 'config.json'), 'utf8'))).toEqual({ k: 1 })
  await win.waitForTimeout(500) // 等 watcher 推送刷新文件树
  await expect(tree.getByText('.synote')).toHaveCount(0)
  await app.close()
})

// 自动保存的旧内容晚于 ⌘S 的新内容落盘时，磁盘上不能是旧内容
test('overlapping saves never leave stale content on disk', async () => {
  const { app, win, vault } = await launch({ 'a.md': '' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const slow = await slowFirstCall(app, 'file:write', 1500)

  await win.locator('.cm-content').click()
  await win.keyboard.type('旧')
  await expect.poll(() => slow('calls')).toBe(1) // 自动保存“旧”已发出，还没落盘
  await win.keyboard.type('新')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(2)
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('旧新')
  await expect(win.locator('[title="未保存"]')).toHaveCount(0)
  await app.close()
})

// 外部改动触发重新加载，读文件期间用户输入了：保留用户输入，不用读到的旧快照覆盖
test('external reload does not clobber input typed while reading', async () => {
  const { app, win, vault } = await launch({ 'a.md': '原文' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('原文')
  const slow = await slowFirstCall(app, 'file:read', 1500)

  writeFileSync(path.join(vault, 'a.md'), '外部')
  await expect.poll(() => slow('calls'), { timeout: 5000 }).toBe(1)
  await editor.click()
  await win.keyboard.press('End')
  await win.keyboard.type('输入')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(1)
  await win.waitForTimeout(500) // 给渲染进程处理读到的结果
  await expect(editor).toHaveText('原文输入')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('原文输入')
  await app.close()
})

// 快速切换与命令面板：快捷键都走命令注册表
test('quick open and command palette', async () => {
  const { app, win } = await launch({ '项目/深层/会议纪要.md': '# 会议纪要\n', '随手记.md': '' })

  await win.keyboard.press('ControlOrMeta+p')
  const input = win.getByRole('combobox', { name: '快速切换' })
  await input.fill('会议')
  await expect(win.getByRole('option')).toHaveCount(1)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(win.locator('.cm-content')).toContainText('# 会议纪要')

  await win.keyboard.press('ControlOrMeta+Shift+p')
  const cmd = win.getByRole('combobox', { name: '命令面板' })
  await cmd.fill('新建')
  await cmd.press('Enter')
  await expect(win.getByRole('tab', { name: '未命名' })).toBeVisible()

  await expect(win.getByRole('alert')).toHaveCount(0)
  await app.close()
})

// 面板打开期间外部增删文件：文件列表和命令的可用条件跟着变
test('palette follows file list and command availability while open', async () => {
  const { app, win, vault } = await launch({ 'a.md': '' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()

  await win.keyboard.press('ControlOrMeta+Shift+p')
  await expect(win.getByRole('option', { name: '保存' })).toBeVisible()
  rmSync(path.join(vault, 'a.md'))
  await expect(win.getByRole('option', { name: '保存' })).toHaveCount(0, { timeout: 5000 })
  await expect(win.getByRole('option', { name: '移到回收站' })).toHaveCount(0)
  await win.keyboard.press('Escape')

  await win.keyboard.press('ControlOrMeta+p')
  await win.getByRole('combobox', { name: '快速切换' }).fill('新来')
  await expect(win.getByRole('option')).toHaveCount(0)
  writeFileSync(path.join(vault, '新来的.md'), '')
  await expect(win.getByRole('option', { name: '新来的.md' })).toBeVisible({ timeout: 5000 })
  await app.close()
})

// 连续打开两个笔记库：串行交接，最后一次调用生效（界面、主进程 root、最近列表一致）
test('opening vaults in quick succession: last call wins', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const slowVault = path.join(base, 'slow') // 目录嵌套很深，逐层 readdir，扫描慢
  const fastVault = path.join(base, 'fast')
  mkdirSync(path.join(slowVault, ...Array.from({ length: 400 }, () => 'd')), { recursive: true })
  mkdirSync(fastVault)
  writeFileSync(path.join(fastVault, '只在快库.md'), '快')

  const { app, win } = await launchWelcome([slowVault, fastVault])
  await expect(win.getByRole('treeitem', { name: '只在快库.md' })).toBeVisible({ timeout: 5000 })
  await win.waitForTimeout(500)
  await expect(win.getByRole('treeitem', { name: '只在快库.md' })).toBeVisible()
  expect(await win.evaluate((v) => window.synote.readFile(v, '只在快库.md'), fastVault)).toBe('快')
  expect((await win.evaluate(() => window.synote.recentVaults()))[0]).toBe(fastVault)
  await app.close()
})

// 索引服务：utility process 里的 node:sqlite 能用，反链 / 搜索 / 孤儿 / 重建索引走通
test('index service in utility process', async () => {
  const { app, win, vault } = await launch({ 'a.md': '去看 [b](b.md)，实时预览', 'b.md': '', 'attachments/orphan.png': '' })

  await expect.poll(() => win.evaluate((v) => window.synote.backlinks(v, 'b.md').catch(() => []), vault), { timeout: 5000 }).toEqual(['a.md'])
  await expect.poll(() => win.evaluate((v) => window.synote.search(v, '实时预览').then((h) => h.map((x) => x.path)), vault)).toEqual(['a.md'])
  expect(await win.evaluate((v) => window.synote.orphans(v), vault)).toEqual(['attachments/orphan.png'])
  // 查别的库：主进程拒绝
  expect(await win.evaluate(() => window.synote.orphans('/elsewhere').then(() => 'ok', (e) => String(e)))).toContain('笔记库已切换')

  writeFileSync(path.join(vault, 'b.md'), '![](attachments/orphan.png)')
  await expect.poll(() => win.evaluate((v) => window.synote.orphans(v), vault), { timeout: 5000 }).toEqual([])

  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.keyboard.type('重建索引')
  await win.keyboard.press('Enter')
  await expect.poll(() => win.evaluate((v) => window.synote.backlinks(v, 'b.md'), vault)).toEqual(['a.md'])
  await app.close()
})

// 全文搜索（S7）：⌘⇧F 打开搜索视图 → 输入即搜 → 点击命中打开文件并选中命中处
test('full-text search opens file at match', async () => {
  const { app, win } = await launch({ 'a.md': '# 标题\n\n第三行有实时预览\n', 'b.md': '无关内容' })

  await win.keyboard.press('ControlOrMeta+Shift+f')
  const input = win.getByRole('textbox', { name: '搜索' })
  await expect(input).toBeFocused()
  await input.fill('实时预览')
  const list = win.getByRole('list', { name: '搜索' })
  await expect(list.getByRole('listitem')).toHaveCount(2, { timeout: 5000 }) // 文件行 + 一处命中
  await list.getByRole('listitem').filter({ hasText: '第三行有' }).click()

  await expect(win.getByRole('tab', { name: 'a' })).toBeVisible()
  await expect(win.locator('.cm-content')).toContainText('第三行有实时预览')
  expect(await win.evaluate(() => getSelection()?.toString())).toBe('实时预览')
  await expect(win.getByRole('alert')).toHaveCount(0)
  await app.close()
})

// 点了搜索结果、文件还没读完就切走：之后普通打开这个文件不再跳到旧的命中处
test('abandoned search reveal does not apply on a later plain open', async () => {
  const { app, win, vault } = await launch({ 'a.md': '第一行\n第二行有目标\n', 'b.md': '别的' })
  const slow = await slowFirstCall(app, 'file:read', 3000)

  await win.keyboard.press('ControlOrMeta+Shift+f')
  await win.getByRole('textbox', { name: '搜索' }).fill('目标')
  await win.getByRole('list', { name: '搜索' }).getByRole('listitem').filter({ hasText: '第二行有' }).click({ timeout: 5000 })
  await win.keyboard.press('ControlOrMeta+p')
  await win.getByRole('combobox', { name: '快速切换' }).fill('b.md')
  await win.keyboard.press('Enter')
  await expect(win.locator('.cm-content')).toHaveText('别的')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(2) // b 先读完，a 后读完

  await clickTab(win, 'a')
  await expect(win.locator('.cm-content')).toContainText('第二行有目标')
  expect(await win.evaluate(() => getSelection()?.toString())).toBe('')
  await app.close()
})

// 新打开的文件还没读完时，视图里仍是上一篇：这时的输入和 ⌘S 不能写进新文件
test('typing while another note loads never writes into it', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'A 的内容', 'b.md': 'B 的内容' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toHaveText('A 的内容')
  const slow = await slowFirstCall(app, 'file:read', 2000)

  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect.poll(() => slow('calls')).toBe(1)
  await win.locator('.cm-content').click()
  await win.keyboard.type('打字')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(1)
  await expect(win.locator('.cm-content')).toHaveText('B 的内容')
  await win.waitForTimeout(800) // 等过自动保存的 500 ms
  expect(readFileSync(path.join(vault, 'b.md'), 'utf8')).toBe('B 的内容')
  await app.close()
})

// 新文件读完前继续编辑仍显示着的旧文件：新文件读完后，旧文件的自动保存要写最新正文
test('edits to the old note while the next one loads are kept', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'A', 'b.md': 'B' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('A')
  const slow = await slowFirstCall(app, 'file:read', 1000)

  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect.poll(() => slow('calls')).toBe(1)
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('后来')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(1)
  await expect(editor).toHaveText('B')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('A后来')
  await clickTab(win, 'a')
  await expect(editor).toHaveText('A后来')
  await expect(win.locator('[title="未保存"]')).toHaveCount(0)
  await app.close()
})

// 新文件还在读时关掉视图里的旧文件：编辑器变成只读占位，不留一个能输入却不会保存的视图
test('closing the shown note while another loads leaves no editable view', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'A', 'b.md': 'B' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('A')
  const slow = await slowFirstCall(app, 'file:read', 1500)

  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect.poll(() => slow('calls')).toBe(1)
  await win.getByRole('tab', { name: 'a' }).hover() // 非活动标签的关闭按钮悬停时才显示
  await win.getByRole('tab', { name: 'a' }).getByRole('button', { name: '关闭' }).click()
  await expect(editor).toHaveText('')
  await expect(editor).toHaveAttribute('contenteditable', 'false')
  await expect(editor).toHaveText('B', { timeout: 5000 })
  await app.close()
})

// 点了搜索结果、文件没读完就关掉标签：之后再打开这个文件不跳到旧的命中处
test('closing a loading search target drops the pending reveal', async () => {
  const { app, win, vault } = await launch({ 'a.md': '第一行\n第二行有目标\n' })
  const slow = await slowFirstCall(app, 'file:read', 1500)

  await win.keyboard.press('ControlOrMeta+Shift+f')
  await win.getByRole('textbox', { name: '搜索' }).fill('目标')
  await win.getByRole('list', { name: '搜索' }).getByRole('listitem').filter({ hasText: '第二行有' }).click({ timeout: 5000 })
  await win.getByRole('tab', { name: 'a' }).getByRole('button', { name: '关闭' }).click()
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(1)

  await win.keyboard.press('ControlOrMeta+p')
  await win.getByRole('combobox', { name: '快速切换' }).fill('a.md')
  await win.keyboard.press('Enter')
  await expect(win.locator('.cm-content')).toContainText('第二行有目标')
  expect(await win.evaluate(() => getSelection()?.toString())).toBe('')
  await app.close()
})

// 关掉加载中的标签后回到之前编辑过的文件：视图里的新正文不能被缓存里的旧快照换掉
test('closing a loading tab never restores a stale snapshot', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' })
  const editor = win.locator('.cm-content')
  await win.getByRole('treeitem', { name: 'c.md' }).click()
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(editor).toHaveText('A')
  await clickTab(win, 'c')
  await expect(editor).toHaveText('C')
  await clickTab(win, 'a')
  await expect(editor).toHaveText('A')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('新')
  const slow = await slowFirstCall(app, 'file:read', 1500)

  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect.poll(() => slow('calls')).toBe(1)
  await win.getByRole('tab', { name: 'b' }).getByRole('button', { name: '关闭' }).click() // 标签顺序 c a b，关 b 回到 a
  await expect(win.getByRole('tab', { name: 'a', selected: true })).toBeVisible()
  // 立刻接着输入：旧快照哪怕只显示一瞬间，输入也会落在旧正文上
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('又')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('A新又')
  await expect(editor).toHaveText('A新又')
  await app.close()
})

// 点了 A 又点了 B：A 开好后编辑，在 500 ms 防抖内 B 开好。切库前先把 A 的输入落盘，
// 再换掉整个编辑器（两库都有 x.md 也不沿用 A 的标签和正文），不写错库
test('switching vaults first saves pending input, then drops the old editor state', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'A 的 x' })
  const b = blockedVault(base, 'b', { 'x.md': 'B 的 x', 'B 独有.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('A 的 x')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  await b.release() // 还在 500 ms 防抖内
  await expect(win.getByRole('treeitem', { name: 'B 独有.md' })).toBeVisible()
  expect(readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('A 的 x改')
  await expect(win.getByText('笔记库已切换')).toHaveCount(0) // 欢迎页自动打开不存在的库留下的提示不算
  await expect(win.getByRole('tab')).toHaveCount(0)
  await win.keyboard.type('又')
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(800) // 过了自动保存的 500 ms
  expect(readFileSync(path.join(b.dir, 'x.md'), 'utf8')).toBe('B 的 x')
  expect(readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('A 的 x改')
  // 切库之后还以 A 的名义写：主进程拒绝并报错
  const stale = await win.evaluate((d) => window.synote.writeFile(d, 'x.md', '迟到').then(() => 'ok', (e) => String(e)), a.dir)
  expect(stale).toContain('笔记库已切换')
  await app.close()
})

// B 开库失败（扫描时读不了子目录）：A 的 watcher 和索引都还在，外部改动照常重载，搜索照常可用
test('a failed vault open leaves the current vault intact', async () => {
  test.skip(process.platform === 'win32', 'mkfifo / chmod')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'A 独有词' })
  const bDir = path.join(base, 'b')
  mkdirSync(path.join(bDir, 'locked'), { recursive: true })
  chmodSync(path.join(bDir, 'locked'), 0)
  const { app, win } = await launchWelcome([a.dir, bDir])
  await a.release()
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(win.getByRole('alert')).toContainText('EACCES', { timeout: 5000 }) // B 打开失败
  await expect(win.getByRole('treeitem', { name: 'x.md' })).toBeVisible()

  writeFileSync(path.join(a.dir, 'x.md'), '外部改的')
  await expect(win.locator('.cm-content')).toHaveText('外部改的', { timeout: 5000 })
  await win.keyboard.press('ControlOrMeta+Shift+f')
  await win.getByRole('textbox', { name: '搜索' }).fill('外部改的')
  await expect(win.getByRole('list', { name: '搜索' }).getByRole('listitem')).toHaveCount(2, { timeout: 5000 })
  chmodSync(path.join(bDir, 'locked'), 0o755)
  await app.close()
})

// B 还在打开时搜索：查的是界面上的 A，而不是 B 的索引
test('searching while another vault opens queries the shown vault', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'a.md': 'A 独有词' })
  const b = blockedVault(base, 'b', { 'b.md': 'B 独有词' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  await expect(win.getByRole('treeitem', { name: 'a.md' })).toBeVisible()
  await win.keyboard.press('ControlOrMeta+Shift+f')
  const input = win.getByRole('textbox', { name: '搜索' })
  const list = win.getByRole('list', { name: '搜索' })
  await input.fill('A 独有词')
  await expect(list.getByRole('listitem').first()).toContainText('a.md', { timeout: 5000 })
  await input.fill('B 独有词')
  await expect(win.getByText('没有匹配项')).toBeVisible({ timeout: 5000 })
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await b.release()
  await app.close()
})

// 切到 B 之后，再收到 A 的（迟到）文件树事件：丢弃，不把 A 的文件塞进 B 的文件树
test('late events from the old vault are ignored', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'A 的文件.md': '' })
  const b = blockedVault(base, 'b', { 'B 的文件.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  await b.release()
  await expect(win.getByRole('treeitem', { name: 'B 的文件.md' })).toBeVisible()
  await app.evaluate(({ BrowserWindow }, root) => {
    const payload = { root, entries: [{ path: 'A 的文件.md', dir: false }], changed: ['A 的文件.md'] }
    BrowserWindow.getAllWindows()[0].webContents.send('vault:changed', payload)
  }, a.dir)
  await win.waitForTimeout(500)
  await expect(win.getByRole('treeitem', { name: 'B 的文件.md' })).toBeVisible()
  await expect(win.getByRole('treeitem', { name: 'A 的文件.md' })).toHaveCount(0)
  await app.close()
})

// 交接期间（最终冲刷之后、commit 返回之前）编辑器只读：这时的输入不进编辑器，A 的正文完整
test('the editor is read-only while the vault switch commits', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'A 的 x' })
  const b = blockedVault(base, 'b', { 'B 的文件.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('A 的 x')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  const held = await holdRecentWrite(app, 1500)
  await b.release()
  await expect.poll(held).toBe(true) // commit 进行中
  await win.keyboard.type('丢')
  await editor.click()
  await win.keyboard.press('Shift+Alt+ArrowDown') // 复制当前行这类命令也不能改正文
  await expect(editor).toHaveText('A 的 x改')
  expect(readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('A 的 x改')
  await expect(win.getByRole('treeitem', { name: 'B 的文件.md' })).toBeVisible({ timeout: 5000 })
  await expect(win.getByText('笔记库已切换')).toHaveCount(0)
  await app.close()
})

// commit 前 B 被删：B 的 watcher 建不起来，A 原样保留（外部改动照常重载），编辑器恢复可编辑
test('a failed commit keeps the current vault and makes the editor editable again', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'A 的 x', 'y.md': 'A 的 y' })
  const b = blockedVault(base, 'b', { 'B 的文件.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  const editor = win.locator('.cm-content')
  await win.getByRole('treeitem', { name: 'y.md' }).click()
  await expect(editor).toHaveText('A 的 y')
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(editor).toHaveText('A 的 x')
  const held = await holdRecentWrite(app, 1500)
  await b.release()
  await expect.poll(held).toBe(true)
  await clickTab(win, 'y') // 锁定期间切走：x 的锁定状态进了缓存
  await expect(editor).toHaveText('A 的 y')
  rmSync(b.dir, { recursive: true })
  await expect(win.getByRole('alert')).toContainText('ENOENT', { timeout: 5000 })
  await expect(win.getByRole('treeitem', { name: 'x.md' })).toBeVisible()

  await clickTab(win, 'x') // 切回来要能正常输入
  await expect(editor).toHaveText('A 的 x')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('又')
  await expect.poll(() => readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('A 的 x又')
  writeFileSync(path.join(a.dir, 'x.md'), '外部改的')
  await expect(editor).toHaveText('外部改的', { timeout: 5000 })
  await app.close()
})

// prepare 扫描之后、B 的 watcher 建立之前新增的文件：切过去后补扫，文件树里能看到
test('files added to the new vault before its watcher starts still show up', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': '' })
  const b = blockedVault(base, 'b', { 'B 的文件.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  await expect(win.getByRole('treeitem', { name: 'x.md' })).toBeVisible()
  await win.waitForTimeout(300) // B 的 prepare 已扫完（卡在读配置）
  writeFileSync(path.join(b.dir, '后来的.md'), '')
  await win.waitForTimeout(1500) // 拉开时间，免得 B 的 watcher 启动时还能收到这次写入的事件
  await b.release()
  await expect(win.getByRole('treeitem', { name: 'B 的文件.md' })).toBeVisible()
  await expect(win.getByRole('treeitem', { name: '后来的.md' })).toBeVisible({ timeout: 5000 })
  await app.close()
})

// 切到 B 并编辑 B 的 x.md 之后，才收到 A 的 x.md 的保存回执（同样的正文）：回执不能清掉 B 的未保存标记。
// 主进程写盘换成按库延迟的版本：A 的写 1 s 后回，B 的写 10 s 内不回
test('a save receipt from the old vault does not clear dirty in the new one', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'S' })
  const b = blockedVault(base, 'b', { 'x.md': 'S' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  const editor = win.locator('.cm-content')
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(editor).toHaveText('S')
  await app.evaluate(({ ipcMain }, slowA) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    ipcMain.removeHandler('file:write')
    ipcMain.handle('file:write', async (_e, vault: string, rel: string, content: string) => {
      await new Promise((r) => setTimeout(r, vault === slowA ? 1000 : 10_000))
      await fs.writeFile(`${vault}/${rel}`, content)
    })
  }, a.dir)
  const held = await holdRecentWrite(app, 800)
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await b.release()
  await expect.poll(held).toBe(true)
  await win.keyboard.type('改') // 交接期间的输入（只读时进不去；进得去的话，换库时按 A 发出，1 s 后回执）
  await expect(win.getByRole('treeitem', { name: 'x.md' })).toBeVisible({ timeout: 5000 })
  await expect(win.getByRole('tab')).toHaveCount(0)
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(editor).toHaveText('S')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  await win.waitForTimeout(1500) // A 的回执（若有）已到，B 的写还没回
  await expect(win.locator('[title="未保存"]')).toHaveCount(1)
  await app.close()
})

// git 基础（S12）：缺提交身份时给出命令；找不到 git 时显示引导
test('git view: missing identity and missing git', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  const globalConfig = path.join(base, 'gitconfig')
  mkdirSync(vault)
  mkdirSync(userData)
  writeFileSync(globalConfig, '')
  writeFileSync(path.join(vault, '新 笔记.md'), '')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  writeFileSync(path.join(userData, 'settings.json'), '{损坏') // 设置文件损坏时照常查找 git
  const env = { ...process.env, SYNOTE_USER_DATA: userData, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  execFileSync('git', ['init', '-q'], { cwd: vault, env })

  let app = await electron.launch({ args: ['.'], env })
  let win = await app.firstWindow()
  await win.getByRole('button', { name: 'Git' }).click()
  await expect(win.getByText('1 处更改')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText('git config --global user.email')).toBeVisible()
  // 面板开着时外部新增文件，更改数靠主进程推送更新
  writeFileSync(path.join(vault, '另一篇.md'), '')
  await expect(win.getByText('2 处更改')).toBeVisible({ timeout: 10_000 })
  await app.close()

  // 登录 shell 失败、当前 PATH 为空：没有可用的 git，文件树照常可用
  app = await electron.launch({ args: ['.'], env: { ...env, PATH: '', SHELL: '/usr/bin/false' } })
  win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()
  await win.getByRole('button', { name: 'Git' }).click()
  await expect(win.getByText('没有找到 git')).toBeVisible()
  await win.getByRole('button', { name: '重新检测' }).click()
  await expect(win.getByText('没有找到 git')).toBeVisible()
  await expect(win.getByRole('button', { name: '手动指定 git 路径…' })).toBeVisible()
  await app.close()
})

// CM6 用 VSCode 键位表（ADR 0003）：⌘D 逐个选中相同的词
test('editor uses VSCode keymap', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'ab ab' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await win.locator('.cm-content').click()
  await win.keyboard.press('ControlOrMeta+Home')
  await win.keyboard.press('ControlOrMeta+d')
  await win.keyboard.press('ControlOrMeta+d')
  await win.keyboard.type('x')
  await expect(win.locator('.cm-content')).toHaveText('x x')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('x x')
  await app.close()
})
