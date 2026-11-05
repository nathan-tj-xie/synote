import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
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

// 主进程下一次写 recent.json（切库 commit 的第一步）时停 ms 毫秒，把“commit 进行中”的窗口拉长；返回是否已停住。
// match 换成别的路径片段可以拖慢别的写入（如附件）
async function holdRecentWrite(app: ElectronApplication, ms: number, match = 'recent.json') {
  await app.evaluate((_m, { ms, match }) => {
    const fs = process.getBuiltinModule('node:fs').promises
    const orig = fs.writeFile
    const g = globalThis as { held?: boolean }
    g.held = false
    fs.writeFile = (async (file: string, ...rest: unknown[]) => {
      if (String(file).includes(match) && !g.held) {
        g.held = true
        await new Promise((r) => setTimeout(r, ms))
      }
      return (orig as (...a: unknown[]) => Promise<void>)(file, ...rest)
    }) as typeof fs.writeFile
  }, { ms, match })
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
  // 整篇替换后光标落到末行，标题行不在光标处，按实时预览渲染：`# ` 隐藏
  await expect(editor.locator('.cm-lp-h1')).toHaveText('外部改的', { timeout: 5000 })

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

  await expect.poll(() => win.evaluate((v) => window.synote.backlinks(v, 'b.md').then((r) => r.map((b) => b.path)).catch(() => []), vault), { timeout: 5000 }).toEqual(['a.md'])
  await expect.poll(() => win.evaluate((v) => window.synote.search(v, '实时预览').then((h) => h.map((x) => x.path)), vault)).toEqual(['a.md'])
  expect(await win.evaluate((v) => window.synote.orphans(v), vault)).toEqual(['attachments/orphan.png'])
  // 查别的库：主进程拒绝
  expect(await win.evaluate(() => window.synote.orphans('/elsewhere').then(() => 'ok', (e) => String(e)))).toContain('笔记库已切换')

  writeFileSync(path.join(vault, 'b.md'), '![](attachments/orphan.png)')
  await expect.poll(() => win.evaluate((v) => window.synote.orphans(v), vault), { timeout: 5000 }).toEqual([])

  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.keyboard.type('重建索引')
  await win.keyboard.press('Enter')
  await expect.poll(() => win.evaluate((v) => window.synote.backlinks(v, 'b.md').then((r) => r.map((b) => b.path)), vault)).toEqual(['a.md'])
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
  // a.md 自动保存后外部改动检查会再读一次 a.md（不延迟），完成数可能先到 2；等 b.md 显示出来才说明慢读已返回
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBeGreaterThanOrEqual(1)
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
  await fire(win, 'paste', 'image.png', [...PNG], 'image/png') // 粘贴 / 拖入附件同样拒绝，什么都不写
  await expect(editor).toHaveText('A 的 x改')
  expect(readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('A 的 x改')
  expect(existsSync(path.join(a.dir, 'attachments'))).toBe(false)
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

// A 的保存回执和 B 的编辑：A 的写入确实已发出、回执被扣住时，切库一直等着（不会先显示 B）；
// 放行回执后才切到 B，再编辑 B 的同名 x.md（同样的正文），B 的未保存标记不受 A 的回执影响。
// 交接协议保证 A 的回执总在切库之前到达，“编辑 B 之后才收到 A 的回执”已经造不出来；vaultGen 检查作为兜底保留
test('a save receipt from the old vault does not clear dirty in the new one', async () => {
  test.skip(process.platform === 'win32', 'mkfifo')
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const a = blockedVault(base, 'a', { 'x.md': 'S' })
  const b = blockedVault(base, 'b', { 'x.md': 'S', 'B 独有.md': '' })
  const { app, win } = await launchWelcome([a.dir, b.dir])
  await a.release()
  const editor = win.locator('.cm-content')
  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(editor).toHaveText('S')
  // A 的写扣住，直到测试放行；B 的写 10 s 内不回
  await app.evaluate(({ ipcMain }, slowA) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const g = globalThis as { aWrites?: number; releaseA?: () => void }
    const gate = new Promise<void>((r) => (g.releaseA = r))
    g.aWrites = 0
    ipcMain.removeHandler('file:write')
    ipcMain.handle('file:write', async (_e, vault: string, rel: string, content: string) => {
      if (vault === slowA) {
        g.aWrites!++
        await gate
      } else await new Promise((r) => setTimeout(r, 10_000))
      await fs.writeFile(`${vault}/${rel}`, content)
    })
  }, a.dir)
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  await b.release() // 防抖内：切库的冲刷立即发出 A 的写
  await expect.poll(() => app.evaluate(() => (globalThis as { aWrites?: number }).aWrites)).toBe(1)
  await win.waitForTimeout(500)
  await expect(win.getByRole('treeitem', { name: 'B 独有.md' })).toHaveCount(0) // 回执没到，不切库
  await app.evaluate(() => (globalThis as { releaseA?: () => void }).releaseA!())
  await expect(win.getByRole('treeitem', { name: 'B 独有.md' })).toBeVisible({ timeout: 5000 })
  expect(readFileSync(path.join(a.dir, 'x.md'), 'utf8')).toBe('S改')

  await win.getByRole('treeitem', { name: 'x.md' }).click()
  await expect(editor).toHaveText('S')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  await win.waitForTimeout(1000) // 过了自动保存的 500 ms，B 的写还没回
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

// 工作区对比（S14）：⌘⇧D 原地切到 HEAD ↔ 工作区，diff 里编辑走同一条保存路径，切回正文内容一致
test('workspace diff: toggle, edit and save, back to prose', async () => {
  const { app, win, vault } = await launch({ 'a.md': '# 标题\n第一行\n' })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(vault, '..', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: vault, env })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', '1')
  writeFileSync(path.join(vault, 'a.md'), '# 标题\n第一行\n工作区新增\n')

  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('工作区新增')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  const diff = win.locator('.monaco-diff-editor')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  const original = diff.locator('.editor.original .view-lines')
  const modified = diff.locator('.editor.modified .view-lines')
  await expect(original).toContainText('第一行')
  await expect(original).not.toContainText('工作区新增')
  await expect(modified).toContainText('工作区新增')
  await expect(win.locator('.cm-content')).toBeHidden()

  // diff 里编辑工作区一侧：⌘S（命令注册表的快捷键）立即保存
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('在 diff 里写')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# 标题\n第一行\n工作区新增\n在 diff 里写')
  await expect(win.locator('[role=tab] [title="未保存"]')).toHaveCount(0)

  // 外部改动（没有未保存改动）重新加载：diff 一侧跟着更新
  writeFileSync(path.join(vault, 'a.md'), '# 标题\n外部改动\n')
  await expect(modified).toContainText('外部改动')

  // 切回正文：内容一致，CM6 照常编辑并自动保存
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(diff).toBeHidden()
  const editor = win.locator('.cm-content')
  await expect(editor).toHaveText('# 标题外部改动')
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('！')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# 标题\n外部改动\n！')

  // 再进 diff：第二次不用重新加载 Monaco，显示的是正文最新内容
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(modified).toContainText('！')
  await app.close()
})

// Monaco 和 CM6 按偏移量同步，两边对文本的表示要一致：开头的 BOM（Monaco 单独存）、外部重载只改了代理对的一半
test('workspace diff keeps offsets in sync with BOM and surrogate pairs', async () => {
  const { app, win, vault } = await launch({ 'bom.md': '\uFEFFabc', 'emoji.md': '😀abc' })
  // 同步要靠偏移换算本身对齐，不能靠自检重设兜底
  const syncErrors: string[] = []
  win.on('console', (m) => m.text().startsWith('[diff]') && syncErrors.push(m.text()))
  execFileSync('git', ['init', '-q'], { cwd: vault })
  const disk = (p: string) => readFileSync(path.join(vault, p), 'utf8')
  const modified = win.locator('.monaco-diff-editor .editor.modified .view-lines')

  await win.getByRole('treeitem', { name: 'bom.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('abc')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(modified).toContainText('abc', { timeout: 10_000 })
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('X')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => disk('bom.md')).toBe('\uFEFFabcX')

  await win.getByRole('treeitem', { name: 'emoji.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('😀abc')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(modified).toContainText('😀abc')
  writeFileSync(path.join(vault, 'emoji.md'), '😁abc')
  await expect(modified).toContainText('😁abc')
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('X')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => disk('emoji.md')).toBe('😁abcX')
  expect(syncErrors).toEqual([])
  await app.close()
})

// Monaco 隐藏开头 BOM 的个数不靠猜：双 BOM、外部增删 BOM 之后在 diff 里输入，落盘都要对
test('workspace diff with double BOM and external BOM changes', async () => {
  const { app, win, vault } = await launch({ 'two.md': '\uFEFF\uFEFFabc', 'ext.md': 'abc' })
  // 同步要靠偏移换算本身对齐，不能靠自检重设兜底
  const syncErrors: string[] = []
  win.on('console', (m) => m.text().startsWith('[diff]') && syncErrors.push(m.text()))
  execFileSync('git', ['init', '-q'], { cwd: vault })
  const disk = (p: string) => readFileSync(path.join(vault, p), 'utf8')
  const modified = win.locator('.monaco-diff-editor .editor.modified .view-lines')
  const typeAtEnd = async (text: string) => {
    await win.keyboard.press('ControlOrMeta+End')
    await win.keyboard.type(text)
    await win.keyboard.press('ControlOrMeta+s')
  }

  await win.getByRole('treeitem', { name: 'two.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('abc')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(modified).toContainText('abc', { timeout: 10_000 })
  await typeAtEnd('X')
  await expect.poll(() => disk('two.md')).toBe('\uFEFF\uFEFFabcX')

  await win.getByRole('treeitem', { name: 'ext.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('abc')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(modified).toContainText('abc')
  // 外部加上 BOM、加成两个、再去掉：每次都等 diff 显示出新内容后再输入
  for (const [ext, typed, want] of [
    ['\uFEFFabc1', 'X', '\uFEFFabc1X'],
    ['\uFEFF\uFEFFabc2', 'Y', '\uFEFF\uFEFFabc2Y'],
    ['abc3', 'Z', 'abc3Z'],
  ]) {
    writeFileSync(path.join(vault, 'ext.md'), ext)
    await expect(modified).toContainText(ext.replace(/\uFEFF/g, '').trim())
    await typeAtEnd(typed)
    await expect.poll(() => disk('ext.md')).toBe(want)
  }
  expect(syncErrors).toEqual([])
  await app.close()
})

// 快捷键与 CM6 一致：进 diff 时按 keymap.ts 的对照表自检（vscodeKeymap 的每个键在 Monaco 里都绑到对应命令、命令存在），
// 不一致会打 [diff] 日志。CI 双平台跑，mac / Windows 两半对照表都实测
test('workspace diff keybindings match CM6', async () => {
  const { app, win, vault } = await launch({ 'a.md': '第一行\n第二行\n' })
  execFileSync('git', ['init', '-q'], { cwd: vault })
  const diffLogs: string[] = []
  win.on('console', (m) => m.text().startsWith('[diff]') && diffLogs.push(m.text()))
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toContainText('第二行')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  const modified = win.locator('.monaco-diff-editor .editor.modified .view-lines')
  await expect(modified).toContainText('第二行', { timeout: 10_000 })
  // 抽一条要显式注册的键实际按一下：⌘End（mac 上 Monaco 默认不绑）到文末再输入
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('尾')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('第一行\n第二行\n尾')
  expect(diffLogs).toEqual([])
  await app.close()
})

test('workspace diff outside a git repo reports and stays in prose', async () => {
  const { app, win } = await launch({ 'a.md': 'x' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toHaveText('x')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(win.getByRole('alert')).toContainText('不是 git 仓库')
  await expect(win.locator('.cm-content')).toBeVisible()
  await app.close()
})

// 实时预览（S3）：覆盖所有语法的笔记
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const allSyntax = [
  '# 一级标题',
  '',
  '## 二级 *斜* **粗** ~~删~~ `码`',
  '',
  '正文 [名字](其他.md) 和 ![图](../attachments/a.png) 还有 ![外链](https://example.com/x.png)',
  '',
  '跨行的 [链',
  '接](其他.md) 和引用式 ![引用图][图] 与 [引用链接][图] 及 ![转义](../attachments/a\\(1\\)&amp;b.png) ![百分号](../attachments/a%23b%26c.png)',
  '',
  '[图]: ../attachments/a.png',
  '',
  '自动链接 <https://example.com> 与 &amp; 和 \\*转义',
  '',
  '> [引用里',
  '> 跨行](其他.md)',
  '',
  '- 圆点',
  '  1. 有序',
  '- [ ] 待办',
  '- [x] 已办',
  '',
  '> 引用 **粗**',
  '',
  '---',
  '',
  '```ts',
  'const n: number = 1 // 注释',
  '```',
  '',
  '| 左 | 中 | 右 |',
  '|:---|:--:|---:| ', // 对齐行带行尾空白也要认成表格（gfmTable.ts）
  '| a | b | c |',
  '',
  '> | 引 | 用 |',
  '> |---|---|',
  '> | x | y |',
  '',
  '- 列表里的表格',
  '',
  '  | 列 |',
  '  |---|',
  '  | z |',
  '',
  '最后一行\t带 tab  ',
].join('\n')

// 只打开、不编辑：⌘S 后磁盘字节不变（含 BOM、行尾空白、tab、无结尾换行），进出 ⌘⇧D 再 ⌘S 也不变
test('live preview renders every syntax and never changes source bytes', async () => {
  const files = { '笔记/全语法.md': allSyntax, '笔记/带BOM.md': '﻿# 标题\n\n- [ ] 任务\n| a |\n|---|\n| 1 |', '空.md': '' }
  const { app, win, vault } = await launch({ ...files })
  mkdirSync(path.join(vault, 'attachments'))
  writeFileSync(path.join(vault, 'attachments/a.png'), PNG)
  writeFileSync(path.join(vault, 'attachments/a(1)&b.png'), PNG) // 地址里的转义和实体要先解码
  writeFileSync(path.join(vault, 'attachments/a#b&c.png'), PNG) // %23、%26 按段 decodeURIComponent
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(vault, '..', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: vault, env })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', '1')

  const editor = win.locator('.cm-content')
  await win.getByRole('treeitem', { name: '笔记' }).click()
  await win.getByRole('treeitem', { name: '全语法.md' }).click()
  // 光标在第一行：标题源码可见，其余渲染
  await expect(editor).toContainText('# 一级标题')
  await expect(win.locator('.cm-lp-h2')).toHaveText('二级 斜 粗 删 码')
  await expect(win.locator('.cm-lp-link')).toHaveText(['名字', '链 接', '引用链接', 'https://example.com', '引用里 跨行'])
  await expect(editor).toContainText('自动链接 https://example.com 与 & 和 *转义')
  await expect(editor).not.toContainText('其他.md')
  // 内联写法和引用式写法的图片都按笔记目录解析、内联显示
  await expect(win.locator('.cm-lp-image img')).toHaveCount(4)
  for (const img of await win.locator('.cm-lp-image img').all()) await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(win.locator('.cm-lp-image-missing')).toHaveText('外链')
  await expect(win.locator('.cm-lp-bullet').first()).toHaveText('•') // 行内装饰只建视口，后面的列表不一定已渲染
  await expect(win.locator('.cm-lp-task')).toHaveCount(2)
  await expect(win.locator('.cm-lp-task').nth(1)).toBeChecked()
  await expect(win.locator('.cm-line.cm-lp-quote')).toHaveText(['引用里 跨行', '引用 粗']) // 跨行链接整段替换后两行显示为一行
  await expect(win.locator('.cm-lp-hr')).toHaveCount(1)
  await expect(win.locator('.cm-lp-fence')).toHaveText('ts')
  await expect(win.locator('.cm-lp-table').first().locator('th')).toHaveText(['左', '中', '右'])
  await expect(win.locator('.cm-lp-table').first().locator('td').nth(2)).toHaveCSS('text-align', 'right')
  // 引用、列表里的表格也渲染（连同行首的 `> ` / 缩进）；它们在文末，先滚过去（只渲染视口）
  const scroll = (to: 'top' | 'bottom') => win.locator('.cm-scroller').evaluate((e, to) => (e.scrollTop = to === 'top' ? 0 : e.scrollHeight), to)
  await scroll('bottom')
  await expect(win.locator('.cm-lp-table.cm-lp-quote td')).toHaveText(['x', 'y'])
  await expect(win.locator('.cm-lp-table').last().locator('td')).toHaveText(['z'])
  await expect(editor).not.toContainText('|---|')
  await scroll('top')
  // 代码块按语言懒加载高亮：关键字有自己的颜色
  await expect.poll(() => win.locator('.cm-lp-codeblock span').count()).toBeGreaterThan(2)

  // 光标移进表格：表格切回源码
  await win.locator('.cm-lp-table').first().click()
  await expect(editor).toContainText('|:---|:--:|---:|')

  const stat = (p: string) => statSync(path.join(vault, p)).mtimeMs
  const save = async (p: string) => {
    const before = stat(p)
    await win.keyboard.press('ControlOrMeta+s')
    await win.waitForTimeout(300)
    expect(stat(p)).toBe(before) // 正文与磁盘一致：⌘S 不写盘
    expect(readFileSync(path.join(vault, p), 'utf8')).toBe(files[p as keyof typeof files])
  }
  await save('笔记/全语法.md')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(win.locator('.monaco-diff-editor')).toBeVisible({ timeout: 10_000 })
  await win.keyboard.press('ControlOrMeta+Shift+d')
  await expect(editor).toBeVisible()
  await save('笔记/全语法.md')
  expect(git('status', '--porcelain').toString()).toBe('')

  for (const name of ['带BOM.md', '空.md']) {
    await win.getByRole('treeitem', { name }).click()
    await expect(win.getByRole('tab', { name: name.replace(/\.md$/, ''), selected: true })).toBeVisible()
    await save(name === '空.md' ? name : `笔记/${name}`)
  }
  expect(git('status', '--porcelain').toString()).toBe('')
  await app.close()
})

// 任务勾选走普通编辑事务：写回正文、自动保存；只改中间那个字符
test('clicking a task checkbox toggles it through the save path', async () => {
  const { app, win, vault } = await launch({ 'a.md': '# 待办\n\n- [ ] 买菜\n- [x] 洗衣\n' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const boxes = win.locator('.cm-lp-task')
  await expect(boxes).toHaveCount(2)
  await boxes.first().click()
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# 待办\n\n- [x] 买菜\n- [x] 洗衣\n')
  await boxes.nth(1).click()
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# 待办\n\n- [x] 买菜\n- [ ] 洗衣\n')
  // 勾选不移动光标：光标仍在第一行，任务行保持渲染
  await expect(boxes).toHaveCount(2)
  await app.close()
})

// 中文输入法：用 CDP 模拟组字。组字期间光标所在行的装饰不重建（DOM 节点不被替换）、光标不跳；上屏后内容正确
test('IME composition keeps the cursor line stable', async () => {
  const { app, win, vault } = await launch({ 'a.md': '# 标题\n\n前 **粗** 后\n\n- [ ] 任务\n' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(win.locator('.cm-lp-h1')).toBeVisible()
  // 光标放到第 3 行「后」之后
  await editor.locator('.cm-line').nth(2).click()
  await win.keyboard.press('End')
  await expect(editor.locator('.cm-line').nth(2)).toHaveText('前 **粗** 后')
  await win.evaluate(() => {
    const line = document.querySelectorAll('.cm-line')[2]
    ;(window as unknown as { probe: Element }).probe = line
  })
  const cdp = await win.context().newCDPSession(win)
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    // 同一个行节点、内容只多了组字文本，其它行的渲染不变
    expect(await win.evaluate(() => (window as unknown as { probe: Element }).probe.isConnected)).toBe(true)
    await expect(editor.locator('.cm-line').nth(2)).toHaveText(`前 **粗** 后${text}`)
    await expect(win.locator('.cm-lp-task')).toHaveCount(1)
    await expect(win.locator('.cm-lp-h1')).toHaveText('标题')
  }
  await cdp.send('Input.insertText', { text: '你好' })
  await expect(editor.locator('.cm-line').nth(2)).toHaveText('前 **粗** 后你好')
  await win.keyboard.type('!')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('# 标题\n\n前 **粗** 后你好!\n\n- [ ] 任务\n')
  await app.close()
})

// CRLF 笔记：CM6 内部按 \n 处理，保存时按读进来时的换行符写回（只打开不写盘，编辑后仍是 CRLF，diff 里编辑也一样）
test('CRLF notes keep their line endings', async () => {
  const crlf = '# 标题\r\n\r\n- [ ] 任务\r\n正文\r\n'
  const mixed = '# 混合\r\n一\n二\r\n三\r四'
  const { app, win, vault } = await launch({ 'a.md': crlf, 'b.md': crlf, 'c.md': crlf, 'd.md': mixed })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(vault, '..', 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: vault, env })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', '1')
  const read = (p: string) => readFileSync(path.join(vault, p), 'utf8')
  const editor = win.locator('.cm-content')

  // 只打开 + ⌘S：字节不变
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(editor).toContainText('# 标题')
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(500)
  expect(read('a.md')).toBe(crlf)

  // 混合换行只打开 + ⌘S：不写盘，字节不变（编辑后才会统一成多数那种）
  await win.getByRole('treeitem', { name: 'd.md' }).click()
  await expect(editor).toContainText('# 混合')
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(500)
  expect(read('d.md')).toBe(mixed)

  // 正文里编辑：仍是 CRLF
  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect(editor).toContainText('# 标题')
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('新行')
  await win.keyboard.press('Enter')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read('b.md')).toBe(crlf + '新行\r\n')

  // diff 里编辑：仍是 CRLF，左右两侧不因换行符不同而整篇标红
  await win.getByRole('treeitem', { name: 'c.md' }).click()
  await expect(editor).toContainText('# 标题')
  await win.keyboard.press('ControlOrMeta+Shift+d')
  const diff = win.locator('.monaco-diff-editor')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  await expect(diff.locator('.editor.modified .view-lines')).toContainText('正文')
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('在 diff 里写')
  await win.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => read('c.md')).toBe(crlf + '在 diff 里写')
  await expect(diff.locator('.line-insert')).toHaveCount(1)
  await app.close()
})

// 附件（S10）：在编辑器里合成 paste / drop 事件，文件经主进程写进 attachments/，相对链接走保存路径落盘
const fire = (win: Page, kind: 'paste' | 'drop', name: string, bytes: number[], type: string) =>
  win.evaluate(
    ({ kind, name, bytes, type }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }))
      const el = document.querySelector('.cm-content')!
      const r = el.getBoundingClientRect()
      const e =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.bottom - 2 })
      el.dispatchEvent(e)
    },
    { kind, name, bytes, type },
  )

test('pasting the same image twice writes one file; dropped files keep their name', async () => {
  const { app, win, vault } = await launch({ '我的 笔记/n.md': '开头' })
  await win.getByRole('treeitem', { name: '我的 笔记' }).click()
  await win.getByRole('treeitem', { name: 'n.md' }).click()
  const editor = win.locator('.cm-content')
  await editor.click()
  await win.keyboard.press('End')
  const png = [...PNG]
  await fire(win, 'paste', 'image.png', png, 'image/png')
  const file = path.join(vault, '我的 笔记', 'n.md')
  const link = /!\[image-\d{8}-\d{6}\]\(\.\.\/attachments\/(image-\d{8}-\d{6}\.png)\)/g
  await expect.poll(() => [...readFileSync(file, 'utf8').matchAll(link)].length).toBe(1)
  await fire(win, 'paste', 'image.png', png, 'image/png')
  await expect.poll(() => [...readFileSync(file, 'utf8').matchAll(link)].length).toBe(2)
  const names = [...readFileSync(file, 'utf8').matchAll(link)].map((m) => m[1])
  expect(names[0]).toBe(names[1])
  expect(readdirSync(path.join(vault, 'attachments'))).toEqual([names[0]])

  await fire(win, 'drop', 'my doc.pdf', [1, 2, 3], 'application/pdf')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('[my-doc](../attachments/my-doc.pdf)')
  expect(readdirSync(path.join(vault, 'attachments')).sort()).toEqual([names[0], 'my-doc.pdf'].sort())
  await app.close()
})

test('a missing attachment shows a placeholder and the reference is kept', async () => {
  const src = '首行\n\n![缺](attachments/gone.png)\n'
  const { app, win, vault } = await launch({ 'a.md': src })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-lp-image-missing')).toHaveText('附件缺失：attachments/gone.png')
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await win.waitForTimeout(300)
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe(src)
  expect(existsSync(path.join(vault, 'attachments'))).toBe(false)
  await app.close()
})

// 写盘期间用户改了选区并输入：链接插在发起粘贴时的位置（随编辑映射），新选中的正文不被替换
test('a slow attachment write inserts at the original spot, not the new selection', async () => {
  const { app, win, vault } = await launch({ 'a.md': '开头 中间 结尾' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await editor.click()
  await win.keyboard.press('End')
  const held = await holdRecentWrite(app, 1500, `attachments${path.sep}`)
  await fire(win, 'paste', 'image.png', [...PNG], 'image/png')
  await expect.poll(held).toBe(true) // 附件写盘进行中
  await win.keyboard.press('Home')
  for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
  for (let i = 0; i < 2; i++) await win.keyboard.press('Shift+ArrowRight')
  await win.keyboard.type('X')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8'), { timeout: 5000 }).toMatch(/^开头 X 结尾!\[image-\d{8}-\d{6}\]\(attachments\/image-\d{8}-\d{6}\.png\)$/)
  await app.close()
})

test('a link to a missing non-image attachment shows a placeholder until it is back', async () => {
  const { app, win, vault } = await launch({ 'n.md': '首行\n\n看 [文档](attachments/doc.pdf) 吧\n', 'attachments/doc.pdf': 'pdf' })
  await win.getByRole('treeitem', { name: 'n.md' }).click()
  const missing = win.locator('.cm-lp-image-missing')
  await expect(win.locator('.cm-lp-link')).toHaveText('文档')
  await expect(missing).toHaveCount(0)
  // 增删靠索引服务推送：等索引收录了这个附件再删（开库瞬间删掉的话索引从没见过它，不会推送）
  await expect.poll(() => win.evaluate((v) => window.synote.attachmentRefs(v, 'attachments/doc.pdf').catch(() => 0), vault), { timeout: 5000 }).toBe(1)
  rmSync(path.join(vault, 'attachments/doc.pdf'))
  await expect(missing).toHaveText('附件缺失：attachments/doc.pdf', { timeout: 5000 })
  writeFileSync(path.join(vault, 'attachments/doc.pdf'), 'pdf')
  await expect(missing).toHaveCount(0, { timeout: 5000 })
  await expect(win.locator('.cm-lp-link')).toHaveText('文档')
  expect(readFileSync(path.join(vault, 'n.md'), 'utf8')).toBe('首行\n\n看 [文档](attachments/doc.pdf) 吧\n')
  await app.close()
})

// 双链（S8）：输入 [[ 补全，写入的是标准相对链接（空格 %20、中文原样），不是 [[...]]
test('[[ completion writes a standard relative link', async () => {
  const { app, win, vault } = await launch({ '日记/今天.md': '开头\n', '笔记/目标 笔记.md': '# 目标\n', '别的.md': '' })
  await win.getByRole('treeitem', { name: '日记' }).click()
  await win.getByRole('treeitem', { name: '今天.md' }).click()
  await win.locator('.cm-content').click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('[[目标')
  const popup = win.locator('.cm-tooltip-autocomplete')
  await expect(popup.getByRole('option').first()).toHaveText('笔记/目标 笔记.md')
  await win.keyboard.press('Enter')
  await expect(popup).toHaveCount(0)
  await expect.poll(() => readFileSync(path.join(vault, '日记/今天.md'), 'utf8'), { timeout: 5000 }).toBe('开头\n[目标 笔记](../笔记/目标%20笔记.md)')
  await app.close()
})

// ⌘ 点击跳到目标笔记并定位到锚点标题；目标不存在显示失效样式；反链面板列出来源并随索引更新
test('cmd-click follows links to anchors, broken links, backlinks panel', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`).join('\n')
  const { app, win, vault } = await launch({
    'a.md': '首行\n\n去 [第二节](sub/b%20b.md#第二节) 和 [失效](nope.md) 和 [[不存在]] 和 [[b b|维基]]\n',
    'sub/b b.md': `# B\n\n${filler}\n\n## 第二节\n\n正文\n`,
  })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(win.locator('.cm-lp-broken')).toHaveText(['失效', '不存在'], { timeout: 5000 })

  await win.locator('.cm-lp-link', { hasText: '失效' }).click({ modifiers: ['ControlOrMeta'] })
  await expect(win.getByRole('alert')).toHaveText('笔记不存在：nope.md')
  await win.getByRole('alert').click()

  await win.locator('.cm-lp-link', { hasText: '第二节' }).click({ modifiers: ['ControlOrMeta'] })
  await expect(win.getByRole('tab', { name: 'b b' })).toHaveAttribute('aria-selected', 'true')
  const heading = editor.locator('.cm-line', { hasText: '## 第二节' }) // 光标在标题行：显示源码
  await expect(heading).toBeInViewport()
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toContain('[第二节](sub/b%20b.md#第二节)') // 跳转不改源码

  const panel = win.getByRole('region', { name: '反链' })
  await expect(panel.getByRole('button')).toHaveText(['a去 [第二节](sub/b%20b.md#第二节) 和 [失效](nope.md) 和 [[不存在]] 和 [[b b|维基]]'], { timeout: 5000 })
  writeFileSync(path.join(vault, 'c.md'), '另一篇\n见 [[b b]]\n')
  await expect(panel.getByRole('button')).toHaveCount(2, { timeout: 5000 })
  await expect(panel.getByRole('button').nth(1)).toHaveText('c见 [[b b]]')

  await panel.getByRole('button').first().click()
  await expect(win.getByRole('tab', { name: 'a' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.locator('.cm-line', { hasText: '[[b b|维基]]' })).toBeVisible() // 定位到链接所在行：显示源码
  // 光标移开后 [[名字|别名]] 只显示别名，也能 ⌘ 点击
  await win.keyboard.press('ControlOrMeta+Home')
  await win.locator('.cm-lp-link', { hasText: '维基' }).click({ modifiers: ['ControlOrMeta'] })
  await expect(win.getByRole('tab', { name: 'b b' })).toHaveAttribute('aria-selected', 'true')
  await app.close()
})
