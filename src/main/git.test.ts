import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classifyGitError, findGit, Git, parseStatus, parseVersion, versionOk, type Exec } from './git'

describe('parseStatus', () => {
  it('解析普通改动、重命名、未跟踪、冲突、忽略，路径含空格和中文', () => {
    const out = [
      '1 .M N... 100644 100644 100644 aaa aaa 笔记/今天 的事.md',
      '2 R. N... 100644 100644 100644 bbb bbb R100 新 目录/改名后.md',
      '旧 目录/改名前.md',
      'u UU N... 100644 100644 100644 100644 c1 c2 c3 冲突 文件.md',
      '? attachments/图 片.png',
      '! .DS_Store',
      '',
    ].join('\0')
    expect(parseStatus(out)).toEqual([
      { kind: 'changed', xy: '.M', path: '笔记/今天 的事.md' },
      { kind: 'renamed', xy: 'R.', path: '新 目录/改名后.md', orig: '旧 目录/改名前.md' },
      { kind: 'unmerged', xy: 'UU', path: '冲突 文件.md' },
      { kind: 'untracked', path: 'attachments/图 片.png' },
      { kind: 'ignored', path: '.DS_Store' },
    ])
  })

  it('空输出', () => expect(parseStatus('')).toEqual([]))
})

describe('version', () => {
  it.each([
    ['git version 2.54.0 (Apple Git-157)', [2, 54, 0], true],
    ['git version 2.45.1.windows.1', [2, 45, 1], true],
    ['git version 2.38', [2, 38, 0], true],
    ['git version 2.37.9', [2, 37, 9], false],
    ['git version 3.0.0', [3, 0, 0], true],
  ])('%s', (out, v, ok) => {
    expect(parseVersion(out)).toEqual(v)
    expect(versionOk(v)).toBe(ok)
  })
  it('不是 git 输出', () => expect(parseVersion('zsh: command not found: git')).toBeNull())
})

describe('classifyGitError', () => {
  it.each([
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'noCredentials'],
    ['git@github.com: Permission denied (publickey).', 'noCredentials'],
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'nonFastForward'],
    ['hint: Updates were rejected because the tip of your current branch is behind', 'nonFastForward'],
    ['Author identity unknown\n\n*** Please tell me who you are.', 'noIdentity'],
    ['CONFLICT (content): Merge conflict in a.md\nAutomatic merge failed; fix conflicts', 'conflict'],
    ['git-lfs filter-process: git-lfs: command not found', 'lfsMissing'],
    ['fatal: unable to access \'https://x/\': Could not resolve host: x', 'network'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'notRepo'],
    ['fatal: something else', 'unknown'],
  ])('%s', (stderr, kind) => expect(classifyGitError(stderr)).toBe(kind))
  it('只出现在 stdout 的冲突提示', () => expect(classifyGitError('', 'CONFLICT (content): Merge conflict in a.md')).toBe('conflict'))
})

describe('findGit', () => {
  // 假的子进程：shell 返回 PATH，各个 git 返回各自的版本
  const fake = (o: { loginPATH?: string; versions: Record<string, string>; clt?: boolean }) => {
    const exec = vi.fn<Exec>(async (file, args) => {
      if (args[0] === '-ilc')
        return o.loginPATH === undefined ? { code: -1, stdout: '', stderr: 'timeout' } : { code: 0, stdout: `motd\nSYNOTE_PATH=${o.loginPATH}\n`, stderr: '' }
      if (file.endsWith('xcode-select')) return { code: o.clt ? 0 : 2, stdout: '', stderr: '' }
      const v = o.versions[file]
      return v ? { code: 0, stdout: `git version ${v}\n`, stderr: '' } : { code: -1, stdout: '', stderr: 'ENOENT' }
    })
    return { exec, isFile: (p: string) => p in o.versions }
  }
  const base = { platform: 'darwin' as const, PATH: '/usr/bin:/bin' }

  it('设置项优先', async () => {
    const f = fake({ loginPATH: '/opt/homebrew/bin', versions: { '/my/git': '2.40.0', '/opt/homebrew/bin/git': '2.56.0' } })
    expect(await findGit({ ...base, ...f, setting: '/my/git' })).toEqual({
      status: 'ok',
      bin: '/my/git',
      version: '2.40.0',
      PATH: '/opt/homebrew/bin',
    })
  })

  it('设置项版本过低时继续找登录 shell PATH', async () => {
    const f = fake({ loginPATH: '/opt/homebrew/bin:/usr/bin', versions: { '/my/git': '2.30.0', '/opt/homebrew/bin/git': '2.56.0' } })
    expect(await findGit({ ...base, ...f, setting: '/my/git' })).toMatchObject({ status: 'ok', bin: '/opt/homebrew/bin/git' })
  })

  it('登录 shell 超时就用当前 PATH', async () => {
    const f = fake({ versions: { '/usr/bin/git': '2.54.0' }, clt: true })
    expect(await findGit({ ...base, ...f })).toEqual({ status: 'ok', bin: '/usr/bin/git', version: '2.54.0', PATH: '/usr/bin:/bin' })
  })

  it('都太旧：报告第一个找到的版本', async () => {
    const f = fake({ loginPATH: '/usr/local/bin', versions: { '/usr/local/bin/git': '2.20.1', '/usr/bin/git': '2.37.1' }, clt: true })
    expect(await findGit({ ...base, ...f })).toEqual({ status: 'tooOld', bin: '/usr/local/bin/git', version: '2.20.1' })
  })

  it('没有 git', async () => {
    const f = fake({ loginPATH: '/usr/bin:/bin', versions: {} })
    expect(await findGit({ ...base, ...f })).toEqual({ status: 'missing' })
  })

  it('macOS 没装 CLT 时不调用 /usr/bin/git，避免弹安装框', async () => {
    const f = fake({ loginPATH: '/usr/bin:/bin', versions: { '/usr/bin/git': '2.54.0' }, clt: false })
    expect(await findGit({ ...base, ...f })).toEqual({ status: 'missing' })
    expect(f.exec.mock.calls.some(([file]) => file === '/usr/bin/git')).toBe(false)
  })

  it('非 macOS 不跑登录 shell 和 xcode-select', async () => {
    const f = fake({ versions: { '/usr/bin/git': '2.43.0' } })
    expect(await findGit({ ...f, platform: 'linux', PATH: '/usr/bin' })).toMatchObject({ status: 'ok', bin: '/usr/bin/git' })
    expect(f.exec).toHaveBeenCalledTimes(1)
  })
})

// 集成测试：临时目录里跑系统 git，隔离全局 / 系统配置
describe('Git（系统 git）', () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'synote-git-'))
    const repo = path.join(dir, 'repo')
    mkdirSync(repo)
    const globalConfig = path.join(dir, 'gitconfig')
    writeFileSync(globalConfig, '')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
    const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env })
    return { dir, repo, env, sh, globalConfig }
  }

  it('非仓库目录', async () => {
    const { repo, env } = setup()
    expect(await new Git('git', process.env.PATH!, repo, undefined, env).isRepo()).toBe(false)
  })

  it('status 能识别重命名、空格、中文路径；缺身份', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    mkdirSync(path.join(repo, '旧 目录'))
    writeFileSync(path.join(repo, '旧 目录', '笔记 一.md'), '# 一\n'.repeat(20))
    writeFileSync(path.join(repo, 'a.md'), 'a\n')
    sh('add', '.')
    sh('commit', '-qm', 'init')
    sh('mv', '旧 目录/笔记 一.md', '新 笔记.md')
    writeFileSync(path.join(repo, 'a.md'), 'b\n')
    writeFileSync(path.join(repo, '未跟踪 文件.md'), '')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    expect(await git.isRepo()).toBe(true)
    expect(await git.status()).toEqual([
      { kind: 'changed', xy: '.M', path: 'a.md' },
      { kind: 'renamed', xy: 'R.', path: '新 笔记.md', orig: '旧 目录/笔记 一.md' },
      { kind: 'untracked', path: '未跟踪 文件.md' },
    ])
    expect(await git.identity()).toEqual({ name: null, email: null })
    // 不加 useConfigOnly 时 git 会用主机名自动拼一个身份
    await expect(git.run(['-c', 'user.useConfigOnly=true', 'commit', '-qam', 'x'])).rejects.toMatchObject({ kind: 'noIdentity' })
  })

  it('常驻 cat-file 读历史版本，不存在时为 null', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, '中 文.md'), '第一版\n')
    sh('add', '.')
    sh('commit', '-qm', '1')
    writeFileSync(path.join(repo, '中 文.md'), '第二版\n')
    sh('commit', '-qam', '2')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    const [a, b, c] = await Promise.all([git.readBlob('HEAD~1:中 文.md'), git.readBlob('HEAD:中 文.md'), git.readBlob('HEAD:nope.md')])
    expect(a?.toString()).toBe('第一版\n')
    expect(b?.toString()).toBe('第二版\n')
    expect(c).toBeNull()
    expect((await git.readBlob('HEAD:中 文.md'))?.toString()).toBe('第二版\n')
    git.close()
  })

  // 按行协议传不了换行：走 rev-parse 换 oid，不能让后面的请求错位
  it.skipIf(process.platform === 'win32')('路径含换行', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, '换\n行.md'), '多行\n名字\n')
    writeFileSync(path.join(repo, 'b.md'), 'b\n')
    sh('add', '.')
    sh('commit', '-qm', '1')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    const [a, b, c] = await Promise.all([git.readBlob('HEAD:换\n行.md'), git.readBlob('HEAD:b.md'), git.readBlob('HEAD:没\n有.md')])
    expect(a?.toString()).toBe('多行\n名字\n')
    expect(b?.toString()).toBe('b\n')
    expect(c).toBeNull()
    git.close()
  })

  it('合并冲突经 Git.run() 分类为 conflict，保留 stdout', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'a.md'), '1\n')
    sh('add', '.')
    sh('commit', '-qm', '1')
    sh('checkout', '-qb', 'other')
    writeFileSync(path.join(repo, 'a.md'), 'other\n')
    sh('commit', '-qam', 'other')
    sh('checkout', '-q', 'main')
    writeFileSync(path.join(repo, 'a.md'), 'main\n')
    sh('commit', '-qam', 'main')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    const err = await git.run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other']).catch((e) => e)
    expect(err).toMatchObject({ kind: 'conflict', stdout: expect.stringContaining('CONFLICT (content)') })
  })

  it('改工作区的操作之后通知索引；LFS 路径按 .gitattributes 判断', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, '.gitattributes'), 'attachments/** filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(path.join(repo, 'a.md'), '1\n')
    sh('add', 'a.md')
    sh('commit', '-qm', '1')
    writeFileSync(path.join(repo, 'a.md'), '2\n')

    const changed = vi.fn()
    const git = new Git('git', process.env.PATH!, repo, changed, env)
    await git.mutate(['checkout', '--', 'a.md'])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await git.status()).toEqual([{ kind: 'untracked', path: '.gitattributes' }])
    expect(await git.lfsPaths(['attachments/图.png', 'a.md'])).toEqual(['attachments/图.png'])
  })
})
