import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// git 面板（S13）：笔记库是本地 bare 仓库的克隆，独立的全局 git 配置（identity 为 false 时不设提交身份）
async function launchRepo(files: Record<string, string>, identity = true) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-git-e2e-'))
  const vault = path.join(base, 'vault')
  const remote = path.join(base, 'remote.git')
  const userData = path.join(base, 'user-data')
  const globalConfig = path.join(base, 'gitconfig')
  mkdirSync(vault)
  mkdirSync(userData)
  writeFileSync(globalConfig, identity ? '[user]\n\tname = t\n\temail = t@t\n' : '')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  // 测试脚本自己的 git 操作总带身份，不受 identity 影响
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env }).toString()
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, p)), { recursive: true })
    writeFileSync(path.join(vault, p), c)
  }
  git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  git(vault, 'init', '-q', '-b', 'main')
  git(vault, 'remote', 'add', 'origin', remote)
  git(vault, 'add', '.')
  git(vault, 'commit', '-qm', 'init')
  git(vault, 'push', '-qu', 'origin', 'main')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  const app = await electron.launch({ args: ['.'], env: { ...env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()
  // 另一个克隆往远端推一个提交
  const other = path.join(base, 'other')
  git(base, 'clone', '-q', remote, other)
  const pushFromOther = (file: string, content: string) => {
    git(other, 'pull', '-q', '--no-rebase')
    writeFileSync(path.join(other, file), content)
    git(other, 'commit', '-qam', `远端改 ${file}`)
    git(other, 'push', '-q')
  }
  return { app, win, vault, remote, git: (...a: string[]) => git(vault, ...a), pushFromOther }
}

const openGit = async (win: Page) => {
  await win.getByRole('button', { name: 'Git', exact: true }).click()
  return win.getByLabel(/处更改$/)
}
const row = (changes: ReturnType<Page['getByLabel']>, title: string) => changes.locator(`[title="${title}"]`)

test('git panel: stage, commit, open diff, push, non-fast-forward card, pull', async () => {
  const { app, win, vault, remote, git, pushFromOther } = await launchRepo({ 'a.md': 'a\n', 'r.md': 'r\n' })
  writeFileSync(path.join(vault, 'a.md'), 'a 改\n')
  writeFileSync(path.join(vault, 'b 新.md'), 'b\n')
  const changes = await openGit(win)
  await expect(row(changes, 'a.md')).toBeVisible({ timeout: 10_000 })
  await expect(row(changes, 'b 新.md')).toContainText('U')
  await expect(win.getByRole('button', { name: 'Git', exact: true })).toContainText('2') // 活动栏角标

  // 点改动的文件：直接以工作区对比打开
  await row(changes, 'a.md').click({ position: { x: 30, y: 10 } })
  const diff = win.locator('.monaco-diff-editor')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  await expect(diff.locator('.editor.modified .view-lines')).toContainText('a 改')
  await expect(diff.locator('.editor.original .view-lines')).toContainText('a')

  // 悬停 + 暂存一个文件，⌘Enter 只提交已暂存的
  await row(changes, 'b 新.md').hover()
  await row(changes, 'b 新.md').getByRole('button', { name: '暂存' }).click()
  const commitBtn = win.getByRole('button', { name: '提交已暂存（1）' })
  await expect(commitBtn).toBeDisabled() // 没写提交信息
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('加 b')
  await win.getByLabel('提交信息（⌘Enter 提交）').press('ControlOrMeta+Enter')
  await expect(win.getByRole('button', { name: '全部暂存并提交' })).toBeVisible({ timeout: 10_000 })
  expect(git('log', '-1', '--format=%s')).toBe('加 b\n')
  expect(git('status', '--porcelain')).toBe(' M a.md\n')
  await expect(win.getByLabel('提交信息（⌘Enter 提交）')).toHaveValue('')

  // push：↑1 → 推上去后清零
  const push = win.getByRole('button', { name: 'push' })
  await expect(push).toHaveText('↑ 1')
  await push.click()
  await expect(push).toHaveText('↑')
  expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main']).toString()).toBe('加 b\n')

  // 远端有新提交时 push：非快进错误卡片，原始输出默认折叠，"先 pull"后再 push
  pushFromOther('r.md', 'r 远端\n')
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('改 a')
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  await expect(push).toHaveText('↑ 1')
  await push.click()
  const card = win.getByRole('alert').filter({ hasText: 'push失败' })
  await expect(card).toContainText('远端有本地没有的提交')
  await expect(card.locator('pre')).toBeHidden()
  await card.getByText('git 原始输出', { exact: true }).click()
  await expect(card.locator('pre')).toContainText('rejected')
  await card.getByRole('button', { name: '先 pull' }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => readFileSync(path.join(vault, 'r.md'), 'utf8')).toBe('r 远端\n')
  await expect(push).toHaveText('↑ 2') // 本地提交 + 合并提交
  await push.click()
  await expect(push).toHaveText('↑')

  // 单独 pull：已打开的笔记跟着重新加载
  pushFromOther('a.md', 'a 远端\n')
  await win.getByRole('button', { name: 'pull' }).click()
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('a 远端\n')
  await expect(diff.locator('.editor.modified .view-lines')).toContainText('a 远端')
  expect(git('status', '--porcelain')).toBe('')
  await expect(changes.getByText('没有改动')).toBeVisible()

  // 底部折叠的仓库历史：点提交让当前笔记与该提交里的版本对比
  await win.getByRole('button', { name: '▸ 历史' }).click()
  const commit = win.getByRole('button', { name: /^加 b/ })
  await expect(commit).toBeVisible()
  await commit.click()
  await expect(commit).toHaveAttribute('aria-pressed', 'true')
  await expect(diff.locator('.editor.original .view-lines')).toContainText('a')
  await expect(diff.locator('.editor.original .view-lines')).not.toContainText('远端')
  await app.close()
})

// 提交在孤儿删除、全部暂存之后失败（pre-commit 钩子拒绝）：卡片说明已完成到哪一步，原始输出里有钩子的报错
test('git panel: a commit failing after orphan deletion says how far it got', async () => {
  const { app, win, vault, git } = await launchRepo({ 'a.md': 'a\n', 'attachments/old.png': 'o' })
  writeFileSync(path.join(vault, '.git/hooks/pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
  writeFileSync(path.join(vault, 'a.md'), 'b\n')
  const changes = await openGit(win)
  await expect(changes.locator('label[title="attachments/old.png"]')).toContainText('git rm', { timeout: 10_000 })
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('x')
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  const card = win.getByRole('alert').filter({ hasText: '提交失败' })
  await expect(card).toContainText('已删除 1 个孤儿附件（git rm 的已暂存）；已全部暂存；提交没有完成')
  await card.getByText('git 原始输出', { exact: true }).click()
  await expect(card.locator('pre')).toContainText('hook says no')
  expect(git('status', '--porcelain')).toBe('M  a.md\nD  attachments/old.png\n')
  await expect(win.getByLabel('提交信息（⌘Enter 提交）')).toHaveValue('x') // 提交信息保留，可直接重试
  await app.close()
})

test('git panel: missing identity shows the card and disables commit', async () => {
  const { app, win, vault } = await launchRepo({ 'a.md': 'a\n' }, false)
  writeFileSync(path.join(vault, 'a.md'), 'b\n')
  const changes = await openGit(win)
  await expect(row(changes, 'a.md')).toBeVisible({ timeout: 10_000 })
  const card = win.getByRole('alert').filter({ hasText: '还没有设置提交身份' })
  await expect(card.getByText('git config --global user.name "Your Name"')).toBeVisible()
  await expect(card.getByText('git config --global user.email "you@example.com"')).toBeVisible()
  await expect(card.getByRole('button', { name: '复制' })).toHaveCount(2)
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('x')
  await expect(win.getByRole('button', { name: '全部暂存并提交' })).toBeDisabled()
  await app.close()
})

test('git panel: checked orphans are deleted with the commit (git rm / trash), unchecked are kept', async () => {
  const { app, win, vault, git } = await launchRepo({ 'a.md': '![](attachments/keep.png)\n![](attachments/old.png)\n', 'attachments/keep.png': 'k', 'attachments/old.png': 'o' })
  writeFileSync(path.join(vault, 'attachments/new.png'), 'n')
  writeFileSync(path.join(vault, 'attachments/also.png'), 'a')
  // 在编辑器里删掉对 old.png 的引用，再补一个字不等自动保存：提交前会先落盘
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toContainText('keep.png')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.type('![](attachments/keep.png)')
  const changes = await openGit(win)
  const orphan = (name: string) => changes.locator(`label[title="attachments/${name}"]`)
  await expect(orphan('old.png')).toContainText('git rm', { timeout: 10_000 })
  await expect(orphan('new.png')).toContainText('回收站')
  await expect(orphan('also.png').getByRole('checkbox')).toBeChecked()
  await orphan('also.png').getByRole('checkbox').uncheck()
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('清理')
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('！')
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('清理\n')
  expect(git('show', '--name-status', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['A\tattachments/also.png', 'D\tattachments/old.png', 'M\ta.md'])
  expect(existsSync(path.join(vault, 'attachments/new.png'))).toBe(false)
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('![](attachments/keep.png)！')
  expect(git('status', '--porcelain')).toBe('')
  await app.close()
})

// 验收「1k 个改动时不卡」：变更列表虚拟化，只渲染可见的几十行；首次出现、滚到底、外部新增后更新都要快
test('git panel: 1000 changes render virtualized', async () => {
  const { app, win, vault } = await launchRepo({ 'a.md': 'a\n' })
  mkdirSync(path.join(vault, 'n'))
  for (let i = 0; i < 1000; i++) writeFileSync(path.join(vault, 'n', `${String(i).padStart(4, '0')}.md`), `${i}\n`)
  await win.waitForTimeout(500)
  const t0 = Date.now()
  const changes = await openGit(win)
  await expect(changes).toHaveAttribute('aria-label', '1000 处更改', { timeout: 10_000 })
  await expect(row(changes, 'n/0000.md')).toBeVisible()
  const shown = Date.now() - t0
  const rendered = await changes.locator('[title]').count()
  expect(rendered).toBeLessThan(80)
  await changes.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(row(changes, 'n/0999.md')).toBeVisible()
  expect(await changes.locator('[title]').count()).toBeLessThan(80)
  const t1 = Date.now()
  writeFileSync(path.join(vault, 'n', '1000.md'), 'x\n')
  await expect(changes).toHaveAttribute('aria-label', '1001 处更改', { timeout: 10_000 })
  console.log(`[perf] git panel 1000 changes: shown ${shown}ms, ${rendered} rows rendered, update ${Date.now() - t1}ms`)
  await app.close()
})
