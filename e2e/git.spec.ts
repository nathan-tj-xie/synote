import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// git 面板（S13）：仓库是本地 bare 仓库的克隆，独立的全局 git 配置（identity 为 false 时不设提交身份）。
// 笔记库是仓库里的 sub 子目录（默认就是仓库根）；files 和 git() 都相对仓库根
async function launchRepo(files: Record<string, string>, identity = true, sub = '') {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-git-e2e-'))
  const repo = path.join(base, 'vault')
  const vault = path.join(repo, sub)
  const remote = path.join(base, 'remote.git')
  const userData = path.join(base, 'user-data')
  const globalConfig = path.join(base, 'gitconfig')
  mkdirSync(vault, { recursive: true })
  mkdirSync(userData)
  writeFileSync(globalConfig, identity ? '[user]\n\tname = t\n\temail = t@t\n' : '')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  // 测试脚本自己的 git 操作总带身份，不受 identity 影响
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env }).toString()
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    writeFileSync(path.join(repo, p), c)
  }
  git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'push', '-qu', 'origin', 'main')
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  const launch = async () => {
    const app = await electron.launch({ args: ['.'], env: { ...env, SYNOTE_USER_DATA: userData } })
    const win = await app.firstWindow()
    await expect(win.getByRole('tree')).toBeVisible()
    return { app, win }
  }
  const { app, win } = await launch()
  // 另一个克隆往远端推一个提交
  const other = path.join(base, 'other')
  git(base, 'clone', '-q', remote, other)
  const pushFromOther = (file: string, content: string) => {
    git(other, 'pull', '-q', '--no-rebase')
    writeFileSync(path.join(other, file), content)
    git(other, 'commit', '-qam', `远端改 ${file}`)
    git(other, 'push', '-q')
  }
  // 重启应用（同一份应用数据，打开同一个库）
  return { app, win, vault, repo, remote, git: (...a: string[]) => git(repo, ...a), pushFromOther, relaunch: launch }
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

// 笔记库是仓库子目录、库外有预先暂存的文件：面板看不到它们，提交被拦下，卡片列出路径并给出取消暂存的命令；什么都没动
test('git panel: files staged outside a subfolder vault block the commit', async () => {
  const { app, win, vault, repo, git } = await launchRepo({ '笔记/a.md': 'a\n', "库外 's.md": '1\n' }, true, '笔记')
  writeFileSync(path.join(repo, "库外 's.md"), '2\n')
  git('add', "库外 's.md")
  writeFileSync(path.join(vault, 'a.md'), 'b\n')
  const changes = await openGit(win)
  await expect(row(changes, 'a.md')).toBeVisible({ timeout: 10_000 })
  await expect(changes.locator('[title*="库外"]')).toHaveCount(0) // 库外的改动不在列表里
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('x')
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  const card = win.getByRole('alert').filter({ hasText: '提交失败' })
  await expect(card).toContainText('暂存区里有笔记库之外的文件')
  await expect(card.getByRole('listitem')).toHaveText(["库外 's.md"])
  // 仓库根按 git 自己的写法（macOS 上是 /private/var/…，Windows 上是 C:/…）
  const cmd = `git -C '${git('rev-parse', '--show-toplevel').trim()}' --literal-pathspecs reset -q -- '库外 '\\''s.md'`
  await expect(card.getByText(cmd, { exact: true })).toBeVisible()
  expect(git('log', '--format=%s')).toBe('init\n')
  expect(git('-c', 'core.quotePath=false', 'status', '--porcelain')).toBe("M  \"库外 's.md\"\n M 笔记/a.md\n")
  // 照卡片上的命令取消暂存后重试：只提交库内
  // 命令是 POSIX shell 写法；Windows 上没有 /bin/sh，直接取消暂存
  if (process.platform === 'win32') git('--literal-pathspecs', 'reset', '-q', '--', "库外 's.md")
  else execFileSync('/bin/sh', ['-c', cmd])
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('x\n')
  expect(git('-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'HEAD')).toBe('笔记/a.md\n')
  await app.close()
})

// pull 改写工作区：先把未保存的输入落盘（本地改动与远端冲突时 git 拒绝，本地输入保住）；pull 期间编辑器只读；
// 结束后已打开的笔记立即按磁盘重载，之后不会有旧正文被存回去覆盖拉取的内容
test('git panel: pull flushes input first, locks the editor and reloads open notes', async () => {
  const lines = (first: string, last = '') => `${first}\n\n\n\n\na9\n${last}`
  const { app, win, vault, git, pushFromOther } = await launchRepo({ 'a.md': lines('a1') })
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const editor = win.locator('.cm-content')
  await expect(editor).toContainText('a9')
  await openGit(win)
  const pull = win.getByRole('button', { name: 'pull' })

  // 1. 输入还在自动保存的防抖里就 pull：先落盘，git 因本地改动拒绝合并
  pushFromOther('a.md', lines('a1 远端'))
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('X')
  await pull.click()
  const card = win.getByRole('alert').filter({ hasText: 'pull失败' })
  await expect(card).toBeVisible()
  await card.getByText('git 原始输出', { exact: true }).click()
  await expect(card.locator('pre')).toContainText('would be overwritten')
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe(lines('a1', 'X'))
  await expect(editor).toContainText('X')

  // 提交本地输入后 pull：干净合并，编辑器跟上
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('本地')
  await win.getByRole('button', { name: '全部暂存并提交' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('本地\n')
  await pull.click()
  await expect(editor).toContainText('a1 远端')
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe(lines('a1 远端', 'X'))

  // 2. pull 期间（主进程的 pull 先挂住）输入被拒绝；放行后立即重载，不会把旧正文写回去
  pushFromOther('a.md', lines('a1 再改', 'X'))
  await app.evaluate(({ ipcMain }, cwd) => {
    const { execFile } = process.getBuiltinModule('node:child_process')
    const g = globalThis as { releasePull?: () => void }
    const gate = new Promise<void>((r) => (g.releasePull = r))
    ipcMain.removeHandler('git:pull')
    ipcMain.handle('git:pull', async () => {
      await gate
      await new Promise((res, rej) => execFile('git', ['pull', '-q', '--no-rebase', '--no-edit'], { cwd }, (e) => (e ? rej(e) : res(null))))
      return { ok: true, done: {} }
    })
  }, vault)
  await pull.click()
  await expect(win.getByText('正在 pull…')).toBeVisible()
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('Y')
  await expect(editor).not.toContainText('Y')
  await app.evaluate(() => (globalThis as { releasePull?: () => void }).releasePull!())
  await expect(editor).toContainText('a1 再改')
  await expect(win.getByText('正在 pull…')).toHaveCount(0)
  await win.waitForTimeout(1000) // 过了自动保存的 500 ms
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe(lines('a1 再改', 'X'))
  await expect(win.locator('[role=tab] [title="未保存"]')).toHaveCount(0)
  // 解锁后照常编辑
  await editor.click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('Z')
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe(lines('a1 再改', 'XZ'))
  await app.close()
})

// 只提交已暂存：工作区里删了引用、但那篇笔记没暂存，提交里的旧版仍引用附件——附件不随提交删除，提示原因
test('git panel: commit staged keeps orphans still referenced by staged notes', async () => {
  const { app, win, vault, git } = await launchRepo({ 'a.md': '![](attachments/x.png)\n', 'b.md': 'b\n', 'attachments/x.png': 'x' })
  writeFileSync(path.join(vault, 'a.md'), '没有引用了\n')
  writeFileSync(path.join(vault, 'b.md'), 'b 改\n')
  const changes = await openGit(win)
  await expect(changes.locator('label[title="attachments/x.png"]')).toContainText('git rm', { timeout: 10_000 })
  await row(changes, 'b.md').hover()
  await row(changes, 'b.md').getByRole('button', { name: '暂存' }).click()
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('只提交 b')
  await win.getByRole('button', { name: '提交已暂存（1）' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('只提交 b\n')
  expect(git('show', '--name-status', '--format=', 'HEAD')).toBe('M\tb.md\n')
  expect(readFileSync(path.join(vault, 'attachments/x.png'), 'utf8')).toBe('x')
  await expect(win.getByRole('alert').filter({ hasText: '仍被暂存区里的笔记引用' })).toContainText('attachments/x.png')
  expect(git('status', '--porcelain')).toBe(' M a.md\n')
  await app.close()
})

// 删除的笔记：点开只读的删除对比（左 HEAD 正文、右空），不开标签页，也不能在里面编辑出文件来
test('git panel: a deleted note opens a read-only deletion diff', async () => {
  const { app, win, vault } = await launchRepo({ 'a.md': 'a\n', '删 掉.md': '# 旧内容\n第二行\n' })
  rmSync(path.join(vault, '删 掉.md'))
  const changes = await openGit(win)
  await expect(row(changes, '删 掉.md')).toContainText('D', { timeout: 10_000 })
  await row(changes, '删 掉.md').click({ position: { x: 30, y: 10 } })
  const dialog = win.getByRole('dialog', { name: '删 掉.md（已删除，HEAD ↔ 工作区，只读）' })
  const original = dialog.locator('.editor.original .view-lines')
  await expect(original).toContainText('旧内容', { timeout: 10_000 })
  await expect(original).toContainText('第二行')
  const modified = dialog.locator('.editor.modified .view-lines')
  await expect(modified).toHaveText('')
  await modified.click()
  await win.keyboard.type('复活')
  await expect(modified).toHaveText('')
  await expect(win.getByRole('tab')).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toHaveCount(0)
  expect(existsSync(path.join(vault, '删 掉.md'))).toBe(false)
  // 再开一次（Monaco 已加载）照样显示
  await row(changes, '删 掉.md').click({ position: { x: 30, y: 10 } })
  await expect(original).toContainText('旧内容')
  await app.close()
})

// 合并中（S16）：本地和远端改了同样的行，pull 产生冲突
async function launchConflict() {
  const r = await launchRepo({ 'a.md': 'a\n共同\n', 'b.md': 'b\n', 'c.md': 'c\n' })
  r.pushFromOther('a.md', '远端 a\n共同\n')
  r.pushFromOther('b.md', '远端 b\n')
  writeFileSync(path.join(r.vault, 'a.md'), '本地 a\n共同\n')
  writeFileSync(path.join(r.vault, 'b.md'), '本地 b\n')
  r.git('commit', '-qam', '本地')
  return r
}
const banner = (win: Page) => win.getByRole('region', { name: '合并中' })
const lens = (win: Page, name: string) => win.locator('.codelens-decoration a', { hasText: name }).first()

test('merge: pull conflict → resolve each file in the conflict view → finish merge', async () => {
  const { app, win, vault, git } = await launchConflict()
  const changes = await openGit(win)
  await win.getByRole('button', { name: 'pull' }).click()
  await expect(banner(win)).toContainText('2 个冲突文件', { timeout: 10_000 })
  const finish = banner(win).getByRole('button', { name: '完成合并' })
  await expect(finish).toBeDisabled()
  await expect(changes.getByText(/^冲突 2$/)).toBeVisible()
  await win.getByLabel('提交信息（⌘Enter 提交）').fill('不该能提交')
  await expect(win.getByRole('button', { name: '全部暂存并提交' })).toBeDisabled()
  await expect(win.getByRole('alert').filter({ hasText: 'pull失败' })).toHaveCount(0) // 由横幅接管，不再弹错误卡片

  // 从 git 面板打开冲突文件：直接进冲突视图，点"接受当前"
  await row(changes, 'a.md').click({ position: { x: 30, y: 10 } })
  const conflict = win.locator('[data-conflict-view] .monaco-editor')
  await expect(conflict).toBeVisible({ timeout: 10_000 })
  await expect(conflict.locator('.view-lines')).toContainText('<<<<<<< HEAD')
  await lens(win, '接受当前').click()
  // 标记清空，保存后自动 git add，移出冲突组，回到实时预览
  await expect.poll(() => readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('本地 a\n共同\n')
  await expect.poll(() => git('ls-files', '-u', '--', 'a.md')).toBe('')
  await expect(banner(win)).toContainText('1 个冲突文件')
  await expect(win.locator('.cm-content')).toContainText('本地 a')
  await expect(conflict).toBeHidden()

  // 合并期间其他笔记照常编辑（这处改动不进合并提交）
  await win.getByRole('button', { name: '文件', exact: true }).click()
  await win.getByRole('treeitem', { name: 'c.md' }).click()
  await win.locator('.cm-content').click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('改')
  await expect.poll(() => readFileSync(path.join(vault, 'c.md'), 'utf8')).toBe('c\n改')

  // 从文件树打开另一个冲突文件，也直接进冲突视图；"两者都要"
  await win.getByRole('treeitem', { name: 'b.md' }).click()
  await expect(conflict.locator('.view-lines')).toContainText('>>>>>>>')
  await lens(win, '两者都要').click()
  await expect.poll(() => readFileSync(path.join(vault, 'b.md'), 'utf8')).toBe('本地 b\n远端 b\n')
  await expect(banner(win)).toContainText('冲突已全部解决')
  await finish.click()
  await expect(banner(win)).toHaveCount(0)
  expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  expect(git('status', '--porcelain')).toBe(' M c.md\n')
  await openGit(win)
  await expect(win.getByRole('button', { name: '全部暂存并提交' })).toBeEnabled()
  await app.close()
})

test('merge: restored after restart, abort with confirmation, follows merges started / aborted outside', async () => {
  const { app, win, vault, git, relaunch } = await launchConflict()
  await openGit(win)
  await win.getByRole('button', { name: 'pull' }).click()
  await expect(banner(win)).toContainText('2 个冲突文件', { timeout: 10_000 })
  await app.close()

  // 重启后恢复合并中
  const again = await relaunch()
  const w = again.win
  await expect(banner(w)).toContainText('2 个冲突文件', { timeout: 10_000 })
  await w.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(w.locator('[data-conflict-view] .monaco-editor .view-lines')).toContainText('<<<<<<< HEAD', { timeout: 10_000 })

  // "+ 全部"只暂存普通改动，冲突文件留在冲突组
  writeFileSync(path.join(vault, 'c.md'), 'c 改\n')
  const changes = await openGit(w)
  await expect(row(changes, 'c.md')).toBeVisible({ timeout: 10_000 })
  await w.getByRole('button', { name: '+ 全部' }).click()
  await expect.poll(() => git('diff', '--cached', '--name-only', '--', 'c.md')).toBe('c.md\n')
  await expect(banner(w)).toContainText('2 个冲突文件')
  expect(git('ls-files', '-u', '--', 'a.md', 'b.md')).not.toBe('')
  git('reset', '-q', '--', 'c.md')
  git('checkout', '--', 'c.md')

  // 整份取一侧（附件、删除 / 修改冲突的解决入口，笔记也能用）
  await row(changes, 'b.md').hover()
  await row(changes, 'b.md').getByRole('button', { name: '整份用传入（远端）版本' }).click()
  await expect(banner(w)).toContainText('1 个冲突文件')
  expect(readFileSync(path.join(vault, 'b.md'), 'utf8')).toBe('远端 b\n')

  // 放弃合并要二次确认；取消什么都不做
  await banner(w).getByRole('button', { name: '放弃合并' }).click()
  const confirm = w.getByRole('alertdialog', { name: '放弃这次合并？' })
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(confirm).toHaveCount(0)
  expect(git('ls-files', '-u')).not.toBe('')
  await banner(w).getByRole('button', { name: '放弃合并' }).click()
  await confirm.getByRole('button', { name: '放弃合并' }).click()
  await expect(banner(w)).toHaveCount(0)
  expect(git('status', '--porcelain')).toBe('')
  expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('本地 a\n共同\n')
  await expect(w.locator('.cm-content')).toContainText('本地 a') // 退出冲突视图，按磁盘重载

  // 外部 git 进入 / 退出合并状态，界面跟着变
  expect(() => git('merge', '--no-edit', 'origin/main')).toThrow()
  await expect(banner(w)).toContainText('2 个冲突文件', { timeout: 10_000 })
  git('merge', '--abort')
  await expect(banner(w)).toHaveCount(0, { timeout: 10_000 })
  await again.app.close()
})
