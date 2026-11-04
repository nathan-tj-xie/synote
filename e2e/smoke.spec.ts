import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 临时笔记库 + 独立 userData，启动后等文件树出来
async function launch(files: Record<string, string>) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(vault)
  mkdirSync(userData)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, p)), { recursive: true })
    writeFileSync(path.join(vault, p), c)
  }
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()
  return { app, win, vault }
}

// 把主进程的 file:read / file:write 换成第一次调用晚 ms 毫秒才回的版本，用来复现 IPC 乱序；
// read 立即读盘、晚回结果（拿到的是旧快照），write 晚落盘
async function slowFirstCall(app: ElectronApplication, vault: string, channel: 'file:read' | 'file:write', ms: number) {
  await app.evaluate(
    ({ ipcMain }, { vault, channel, ms }) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const g = globalThis as { slow?: { calls: number; done: number } }
      const slow = (g.slow = { calls: 0, done: 0 })
      const wait = () => new Promise((r) => setTimeout(r, slow.calls++ === 0 ? ms : 0))
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_e, rel: string, content: string) => {
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
    { vault, channel, ms },
  )
  return (key: 'calls' | 'done') => app.evaluate((_m, key) => (globalThis as { slow?: Record<string, number> }).slow![key], key)
}

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

  // 非 git 目录：上面的笔记库本身就不是 git 仓库，没有报错即可；.synote/config.json 自动创建
  await expect(win.getByRole('alert')).toHaveCount(0)
  expect(JSON.parse(readFileSync(path.join(vault, '.synote', 'config.json'), 'utf8'))).toEqual({})
  await expect(tree.getByText('.synote')).toHaveCount(0)
  await win.evaluate(() => window.synote.writeConfig({ k: 1 }))
  expect(JSON.parse(readFileSync(path.join(vault, '.synote', 'config.json'), 'utf8'))).toEqual({ k: 1 })
  await app.close()
})

// 自动保存的旧内容晚于 ⌘S 的新内容落盘时，磁盘上不能是旧内容
test('overlapping saves never leave stale content on disk', async () => {
  const { app, win, vault } = await launch({ 'a.md': '' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const slow = await slowFirstCall(app, vault, 'file:write', 1500)

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
  const slow = await slowFirstCall(app, vault, 'file:read', 1500)

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

// 索引服务：utility process 里的 node:sqlite 能用，反链 / 搜索 / 孤儿 / 重建索引走通
test('index service in utility process', async () => {
  const { app, win, vault } = await launch({ 'a.md': '去看 [b](b.md)，实时预览', 'b.md': '', 'attachments/orphan.png': '' })

  await expect.poll(() => win.evaluate(() => window.synote.backlinks('b.md').catch(() => [])), { timeout: 5000 }).toEqual(['a.md'])
  await expect.poll(() => win.evaluate(() => window.synote.search('实时预览').then((h) => h.map((x) => x.path)))).toEqual(['a.md'])
  expect(await win.evaluate(() => window.synote.orphans())).toEqual(['attachments/orphan.png'])

  writeFileSync(path.join(vault, 'b.md'), '![](attachments/orphan.png)')
  await expect.poll(() => win.evaluate(() => window.synote.orphans()), { timeout: 5000 }).toEqual([])

  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.keyboard.type('重建索引')
  await win.keyboard.press('Enter')
  await expect.poll(() => win.evaluate(() => window.synote.backlinks('b.md'))).toEqual(['a.md'])
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
  const slow = await slowFirstCall(app, vault, 'file:read', 3000)

  await win.keyboard.press('ControlOrMeta+Shift+f')
  await win.getByRole('textbox', { name: '搜索' }).fill('目标')
  await win.getByRole('list', { name: '搜索' }).getByRole('listitem').filter({ hasText: '第二行有' }).click({ timeout: 5000 })
  await win.keyboard.press('ControlOrMeta+p')
  await win.getByRole('combobox', { name: '快速切换' }).fill('b.md')
  await win.keyboard.press('Enter')
  await expect(win.locator('.cm-content')).toHaveText('别的')
  await expect.poll(() => slow('done'), { timeout: 5000 }).toBe(2) // b 先读完，a 后读完

  await win.getByRole('tab', { name: 'a' }).click()
  await expect(win.locator('.cm-content')).toContainText('第二行有目标')
  expect(await win.evaluate(() => getSelection()?.toString())).toBe('')
  await app.close()
})

// 新打开的文件还没读完时，视图里仍是上一篇：这时的输入和 ⌘S 不能写进新文件
test('typing while another note loads never writes into it', async () => {
  const { app, win, vault } = await launch({ 'a.md': 'A 的内容', 'b.md': 'B 的内容' })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toHaveText('A 的内容')
  const slow = await slowFirstCall(app, vault, 'file:read', 2000)

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
