import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 冒烟测试：打开笔记库 → 文件树 → 编辑并自动保存 → 外部改动重新加载
test('open vault, edit, save, reload external change', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(path.join(vault, '日记'), { recursive: true })
  mkdirSync(path.join(vault, 'attachments'), { recursive: true })
  mkdirSync(userData)
  writeFileSync(path.join(vault, '日记', '今天.md'), '# 今天\n')
  writeFileSync(path.join(vault, 'attachments', 'a.png'), '')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))

  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()

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

  // 非 git 目录：上面的笔记库本身就不是 git 仓库，没有报错即可
  await expect(win.getByRole('alert')).toHaveCount(0)
  await app.close()
})

// 快速切换与命令面板：快捷键都走命令注册表
test('quick open and command palette', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(path.join(vault, '项目', '深层'), { recursive: true })
  mkdirSync(userData)
  writeFileSync(path.join(vault, '项目', '深层', '会议纪要.md'), '# 会议纪要\n')
  writeFileSync(path.join(vault, '随手记.md'), '')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))

  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()

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

// 索引服务：utility process 里的 node:sqlite 能用，反链 / 搜索 / 孤儿 / 重建索引走通
test('index service in utility process', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(path.join(vault, 'attachments'), { recursive: true })
  mkdirSync(userData)
  writeFileSync(path.join(vault, 'a.md'), '去看 [b](b.md)，实时预览')
  writeFileSync(path.join(vault, 'b.md'), '')
  writeFileSync(path.join(vault, 'attachments', 'orphan.png'), '')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))

  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()

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
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(vault, { recursive: true })
  mkdirSync(userData)
  writeFileSync(path.join(vault, 'a.md'), '# 标题\n\n第三行有实时预览\n')
  writeFileSync(path.join(vault, 'b.md'), '无关内容')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))

  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()

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
