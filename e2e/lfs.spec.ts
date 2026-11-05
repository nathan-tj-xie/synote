import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// LFS 兼容（S17）：本地 bare 远端 + git-lfs 的 file:// 传输（standalone transfer，不联网）。
// 没装 git-lfs 的机器造不出 LFS 仓库，整个文件跳过（CI 的 macOS 镜像带 git-lfs）
const hasLfs = (() => {
  try {
    execFileSync('git', ['lfs', 'version'])
    return true
  } catch {
    return false
  }
})()
test.skip(!hasLfs, 'git-lfs not installed')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const OLD = Buffer.concat([PNG, Buffer.from('old')]) // 尾部多几个字节仍能显示，内容（oid）和 p.png 不同
const FILTER = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n'

// 源仓库：v1 的 a.md 引用 old.png；v2 删掉 old.png，改引用 p.png。按 GIT_LFS_SKIP_SMUDGE=1 克隆成笔记库：附件全是指针，本地没有对象。
// lfs 为 false 时 app 用的 git 所在目录里没有 git-lfs，PATH 也只有系统目录（模拟 macOS 上没装 git-lfs）
async function launchLfs(lfs: boolean) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-lfs-e2e-'))
  const src = path.join(base, 'src')
  const remote = path.join(base, 'remote.git')
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  const setupConfig = path.join(base, 'gitconfig-setup')
  const appConfig = path.join(base, 'gitconfig')
  mkdirSync(path.join(src, 'attachments'), { recursive: true })
  mkdirSync(userData)
  writeFileSync(setupConfig, FILTER)
  writeFileSync(appConfig, `[user]\n\tname = t\n\temail = t@t\n${lfs ? FILTER : ''}`)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: setupConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env }).toString()
  writeFileSync(path.join(src, '.gitattributes'), 'attachments/** filter=lfs diff=lfs merge=lfs -text\n')
  writeFileSync(path.join(src, 'a.md'), '首行\n\n![旧](attachments/old.png)\n')
  writeFileSync(path.join(src, 'attachments/old.png'), OLD)
  git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  git(src, 'init', '-q', '-b', 'main')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'v1')
  writeFileSync(path.join(src, 'attachments/p.png'), PNG) // 先写：git rm 删掉最后一个文件时会连目录一起删
  git(src, 'rm', '-q', 'attachments/old.png')
  writeFileSync(path.join(src, 'a.md'), '首行\n\n![图](attachments/p.png)\n')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'v2')
  git(src, 'push', '-q', `file://${remote}`, 'main')
  execFileSync('git', ['clone', '-q', `file://${remote}`, vault], { env: { ...env, GIT_LFS_SKIP_SMUDGE: '1' } })
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))

  const appEnv = { ...process.env, GIT_CONFIG_GLOBAL: appConfig, GIT_CONFIG_NOSYSTEM: '1', SYNOTE_USER_DATA: userData } as Record<string, string>
  if (!lfs) {
    // 同 git.test.ts：git 本体链接进一个空目录，设置项指向它；git-lfs 在别的目录里，找不到
    const bin = path.join(base, 'bin')
    mkdirSync(bin)
    symlinkSync(path.join(execFileSync('git', ['--exec-path']).toString().trim(), 'git'), path.join(bin, 'git'))
    writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ gitPath: path.join(bin, 'git') }))
    appEnv.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  }
  const app = await electron.launch({ args: ['.'], env: appEnv })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()
  return { app, win, vault, appConfig, appEnv }
}

test('LFS installed: pointer placeholder downloads in place, dedupe by oid, history pointer downloads only on click', async () => {
  const { app, win, vault, appEnv } = await launchLfs(true)
  const p = path.join(vault, 'attachments/p.png')
  expect(readFileSync(p, 'utf8')).toMatch(/^version https:\/\/git-lfs/)

  // 去重：内容和指针的 oid 一致时直接引用已有文件，不再写一份
  const saved = await win.evaluate(([v, b]) => window.synote.saveAttachment(v, 'dup.png', new Uint8Array(b)), [vault, [...PNG]] as const)
  expect(saved.path).toBe('attachments/p.png')

  // 工作区指针：区别于附件缺失的占位，"下载"后换成图片
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  const ph = win.locator('.cm-lp-lfs')
  await expect(ph).toContainText('LFS 内容未下载')
  await expect(win.locator('.cm-lp-image-missing')).toHaveCount(1) // 只有这一个占位，不另报附件缺失
  await ph.getByRole('button', { name: '下载' }).click()
  await expect(win.locator('.cm-lp-image img')).toBeVisible({ timeout: 10_000 })
  await expect(ph).toHaveCount(0)
  expect(readFileSync(p)).toEqual(PNG)
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: vault, env: appEnv }).toString()).toBe('')

  // 历史里删掉的 old.png：本地没有对象，悬停只显示占位（不下载），点"下载"才 smudge，随后悬停显示图片
  const oid = /oid sha256:([0-9a-f]{64})/.exec(execFileSync('git', ['show', 'HEAD~1:attachments/old.png'], { cwd: vault }).toString())![1]
  const obj = path.join(vault, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)
  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.keyboard.type('历史栏')
  await win.keyboard.press('Enter')
  const items = win.getByRole('complementary', { name: '历史' }).getByRole('button')
  await expect(items).toHaveCount(2, { timeout: 10_000 })
  await items.nth(1).click()
  const line = win.locator('.monaco-diff-editor .editor.original .view-line', { hasText: /^!\[/ })
  await expect(line).toBeVisible({ timeout: 10_000 })
  await line.hover({ position: { x: 12, y: 8 } })
  const hover = win.locator('.monaco-hover').filter({ hasText: 'LFS 内容未下载' })
  await expect(hover).toBeVisible({ timeout: 10_000 })
  expect(() => readFileSync(obj)).toThrow() // 悬停没有触发下载
  await hover.getByRole('link', { name: '下载' }).click()
  // 对象存进了本地 LFS 存储，之后读历史直接命中
  await expect.poll(() => existsSync(obj) && readFileSync(obj).equals(OLD), { timeout: 10_000 }).toBe(true)
  await expect(win.locator('.monaco-hover img')).toBeVisible({ timeout: 10_000 })
  await app.close()
})

test('LFS not installed: git panel prompts to install, download reports it, status filter failure keeps git mode', async () => {
  const { app, win, vault, appConfig } = await launchLfs(false)
  // 占位照常显示；点"下载"报缺 git-lfs，文件不动
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await win.locator('.cm-lp-lfs').getByRole('button', { name: '下载' }).click()
  await expect(win.getByRole('alert').filter({ hasText: /没有安装 git-lfs[\s\S]*not a git command/ })).toBeVisible()
  expect(readFileSync(path.join(vault, 'attachments/p.png'), 'utf8')).toMatch(/^version https:\/\/git-lfs/)

  // git 面板：非模态的安装提示（带重新检测），面板其余照常
  await win.getByRole('button', { name: 'Git', exact: true }).click()
  const card = win.getByRole('alert').filter({ hasText: '没有安装 git-lfs', has: win.getByRole('button', { name: '重新检测' }) })
  await expect(card).toBeVisible({ timeout: 10_000 })
  if (process.platform === 'darwin') await expect(card).toContainText('brew install git-lfs')
  await expect(win.getByRole('textbox', { name: /提交信息/ })).toBeVisible() // 面板照常，不降级成非 git 模式

  // 配了 filter.lfs.required 却找不到 git-lfs：status 失败，仍是 ready，带 lfsError
  writeFileSync(appConfig, `[user]\n\tname = t\n\temail = t@t\n${FILTER}`)
  const now = new Date()
  utimesSync(path.join(vault, 'attachments/p.png'), now, now) // 改 mtime，status 要重新 hash 指针
  await expect
    .poll(() => win.evaluate(() => window.synote.redetectGit().then((s) => (s.status === 'ready' ? s.lfsError?.kind : s.status))), { timeout: 10_000 })
    .toBe('lfsMissing')
  await expect(card).toContainText('command not found')
  await app.close()
})
