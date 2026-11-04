import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classifyGitError, findGit, Git, GitError, parseStatus, parseVersion, versionOk, type Exec } from './git'

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

// 都是 git 2.54 / curl / OpenSSH 的真实输出（LC_ALL=C）；能在本地复现的另见下面经 Git.run() 的集成测试
describe('classifyGitError', () => {
  it.each([
    // noCredentials
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'noCredentials'],
    ["remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'", 'noCredentials'],
    ["remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403", 'noCredentials'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'noCredentials'],
    // nonFastForward：只有这两种原因
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'../r.git\'\nhint: Updates were rejected because the remote contains work that you do not', 'nonFastForward'],
    [' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to \'../r.git\'\nhint: Updates were rejected because the tip of your current branch is behind', 'nonFastForward'],
    ['fatal: Not possible to fast-forward, aborting.', 'nonFastForward'],
    // 其它拒绝不是非快进
    [' ! [rejected]        v1 -> v1 (already exists)\nerror: failed to push some refs to \'../r.git\'\nhint: Updates were rejected because the tag already exists in the remote.', 'unknown'],
    [' ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to \'../r.git\'', 'unknown'],
    [' ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to \'../r.git\'', 'unknown'],
    ['fatal: Need to specify how to reconcile divergent branches.', 'unknown'],
    // noIdentity
    ['Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: no email was given and auto-detection is disabled', 'noIdentity'],
    ["fatal: unable to auto-detect email address (got 't@host.(none)')", 'noIdentity'],
    ['fatal: empty ident name (for <t@t>) not allowed', 'noIdentity'],
    // conflict（rebase 的 CONFLICT 也在 stdout，这里只测文本本身）
    ['Auto-merging f\nCONFLICT (content): Merge conflict in f\nAutomatic merge failed; fix conflicts and then commit the result.', 'conflict'],
    ['Auto-merging f\nCONFLICT (modify/delete): f deleted in HEAD and modified in 1a2b3c4 (x).', 'conflict'],
    // lfsMissing
    ['git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up unexpectedly', 'lfsMissing'],
    ["git-lfs clean -- 'a.bin': git-lfs: command not found\nfatal: a.bin: clean filter 'lfs' failed", 'lfsMissing'],
    ["This repository is configured for Git LFS but 'git-lfs' was not found on your path.", 'lfsMissing'],
    // network
    ["fatal: unable to access 'https://x.invalid/a/': Could not resolve host: x.invalid", 'network'],
    ["fatal: unable to access 'https://127.0.0.1:1/x/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server", 'network'],
    ["fatal: unable to access 'https://x/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to x:443 ", 'network'],
    ['ssh: Could not resolve hostname x.invalid: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.', 'network'],
    ['ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.', 'network'],
    ['ssh: connect to host 127.0.0.1 port 1: Connection refused', 'network'],
    // SSL 证书问题、远端不存在都不是网络不通
    ["fatal: unable to access 'https://x/': SSL certificate problem: unable to get local issuer certificate", 'unknown'],
    ["fatal: '/nonexist' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'unknown'],
    // notRepo
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

  it('设置项优先：合法时根本不调用登录 shell，PATH 为 git 所在目录 + 当前 PATH', async () => {
    const f = fake({ loginPATH: '/opt/homebrew/bin', versions: { '/my/git': '2.40.0', '/opt/homebrew/bin/git': '2.56.0' } })
    expect(await findGit({ ...base, ...f, setting: '/my/git' })).toEqual({
      status: 'ok',
      bin: '/my/git',
      version: '2.40.0',
      PATH: '/my:/usr/bin:/bin',
    })
    expect(f.exec.mock.calls.map(([file]) => file)).toEqual(['/my/git'])
  })

  it('设置项版本过低时才去取登录 shell PATH', async () => {
    const f = fake({ loginPATH: '/opt/homebrew/bin:/usr/bin', versions: { '/my/git': '2.30.0', '/opt/homebrew/bin/git': '2.56.0' } })
    expect(await findGit({ ...base, ...f, setting: '/my/git' })).toMatchObject({ status: 'ok', bin: '/opt/homebrew/bin/git' })
    expect(f.exec.mock.calls.map(([file, args]) => `${file} ${args[0]}`)).toEqual([
      '/my/git --version',
      '/bin/zsh -ilc',
      '/opt/homebrew/bin/git --version',
    ])
  })

  it('登录 shell 的 git 太旧、当前 PATH 的合格：子进程用当前 PATH', async () => {
    const f = fake({ loginPATH: '/usr/local/bin', versions: { '/usr/local/bin/git': '2.30.0', '/opt/git/bin/git': '2.45.0' } })
    expect(await findGit({ ...f, platform: 'darwin', PATH: '/opt/git/bin' })).toEqual({
      status: 'ok',
      bin: '/opt/git/bin/git',
      version: '2.45.0',
      PATH: '/opt/git/bin',
    })
    // 探测版本时也用这一级的 PATH
    expect(f.exec.mock.calls.find(([file]) => file === '/opt/git/bin/git')?.[2]?.env?.PATH).toBe('/opt/git/bin')
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

  it('cat-file 进程退出后再读：返回 GitError，不崩溃，下次读自动重启', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, 'a.md'), 'a\n')
    sh('add', '.')
    sh('commit', '-qm', '1')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    expect((await git.readBlob('HEAD:a.md'))?.toString()).toBe('a\n')
    // 杀掉常驻进程并等它彻底退出，再假装还活着去写已销毁的 stdin
    const cat = (git as unknown as { cat: { proc: ChildProcess; dead: boolean } }).cat
    cat.proc.kill('SIGKILL')
    await new Promise((r) => cat.proc.once('close', r))
    cat.dead = false
    await expect(git.readBlob('HEAD:a.md')).rejects.toBeInstanceOf(GitError)
    expect((await git.readBlob('HEAD:a.md'))?.toString()).toBe('a\n')
    git.close()
    await expect(git.readBlob('HEAD:a.md')).rejects.toBeInstanceOf(GitError)
  })

  it('git 可执行文件不存在时 readBlob 返回 GitError', async () => {
    const { repo, env } = setup()
    const git = new Git(path.join(repo, 'no-such-git'), process.env.PATH!, repo, undefined, env)
    await expect(git.readBlob('HEAD:a.md')).rejects.toBeInstanceOf(GitError)
  })

  // 真实的 push / pull 拒绝：本地 bare 仓库当远端
  it('push / pull 拒绝经 Git.run() 分类', async () => {
    const { dir, repo, env, sh } = setup()
    const remote = path.join(dir, 'r.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env })
    sh('init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'a.md'), '1\n')
    sh('add', '.')
    sh('commit', '-qm', '1')
    sh('remote', 'add', 'o', remote)
    sh('push', '-q', 'o', 'main')
    sh('tag', 'v1')
    sh('push', '-q', 'o', 'v1')
    // 另一个克隆往远端推一个新提交
    const other = path.join(dir, 'other')
    execFileSync('git', ['clone', '-q', remote, other], { env })
    writeFileSync(path.join(other, 'a.md'), '2\n')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', '2'], { cwd: other, env })
    execFileSync('git', ['push', '-q'], { cwd: other, env })
    writeFileSync(path.join(repo, 'a.md'), '3\n')
    sh('commit', '-qam', '3')

    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    const kind = (args: string[]) => git.run(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).then(() => 'ok', (e) => e.kind)
    expect(await kind(['push', 'o', 'main'])).toBe('nonFastForward') // fetch first
    sh('fetch', '-q', 'o')
    expect(await kind(['push', 'o', 'main'])).toBe('nonFastForward') // non-fast-forward
    expect(await kind(['pull', '--ff-only', 'o', 'main'])).toBe('nonFastForward')
    sh('tag', '-f', 'v1', 'HEAD')
    expect(await kind(['push', 'o', 'v1'])).toBe('unknown') // tag already exists
    expect(await kind(['pull', '--rebase', 'o', 'main'])).toBe('conflict') // rebase 的 CONFLICT 也在 stdout
  })

  it('缺 git-lfs 经 Git.run() 分类为 lfsMissing', async () => {
    const { dir, repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs\n')
    writeFileSync(path.join(repo, 'a.bin'), 'x\n')
    // PATH 里只有 git 本身，没有 git-lfs
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(execFileSync('git', ['--exec-path']).toString().trim() + '/git', path.join(bin, 'git'))
    const git = new Git(path.join(bin, 'git'), bin, repo, undefined, env)
    await expect(git.run(['-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true', 'add', 'a.bin'])).rejects.toMatchObject({ kind: 'lfsMissing' })
  })

  it('非仓库目录经 Git.run() 分类为 notRepo', async () => {
    const { repo, env } = setup()
    await expect(new Git('git', process.env.PATH!, repo, undefined, { ...env, GIT_CEILING_DIRECTORIES: path.dirname(repo) }).run(['status'])).rejects.toMatchObject({ kind: 'notRepo' })
  })

  // 只有「不是仓库」「没配置」「对象不存在」才转成 false / null，其它故障不能被误报成这几种状态
  it('配置损坏时 isRepo / identity / readBlob 照常抛错', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    sh('commit', '-q', '--allow-empty', '-m', '1')
    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    expect(await git.readBlob('HEAD:没\n有.md')).toBeNull() // 退出码 1：对象不存在
    writeFileSync(path.join(repo, '.git', 'config'), '[bad\n', { flag: 'a' })
    await expect(git.isRepo()).rejects.toMatchObject({ kind: 'unknown', stderr: expect.stringContaining('bad config line') })
    await expect(git.identity()).rejects.toMatchObject({ code: 128 })
    await expect(git.readBlob('HEAD:换\n行.md')).rejects.toBeInstanceOf(GitError)
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
