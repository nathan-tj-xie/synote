import { _electron as electron, expect, test } from '@playwright/test'
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
