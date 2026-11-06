import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { classifyGitError, findGit, Git, GitError, parseBranch, parseLog, parseStatus, parseVersion, versionOk, type Exec } from './git'

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

describe('parseBranch', () => {
  it('分支、上游、ahead / behind', () => {
    const out = ['# branch.oid abc', '# branch.head feat/中 文', '# branch.upstream origin/feat/中 文', '# branch.ab +2 -1', '? a.md', ''].join('\0')
    expect(parseBranch(out)).toEqual({ branch: 'feat/中 文', upstream: 'origin/feat/中 文', ahead: 2, behind: 1 })
  })
  it('detached、没有上游', () => {
    expect(parseBranch(['# branch.oid abc', '# branch.head (detached)', ''].join('\0'))).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0 })
    // 还没有提交
    expect(parseBranch(['# branch.oid (initial)', '# branch.head main', ''].join('\0'))).toMatchObject({ branch: 'main', upstream: null })
  })
})

describe('parseLog', () => {
  const h = (c: string) => c.repeat(40)
  it('跨重命名：R 取新路径，更旧的提交用旧路径；没有状态段的提交（merge）用更旧一侧的路径', () => {
    const out = [
      h('a'), '30', '张 三', '改 名后',
      '\nM', '新/名 字.md',
      h('b'), '20', 't', 'rename',
      '\nR100', '旧 名.md', '新/名 字.md',
      h('c'), '15', 't', 'merge',
      h('d'), '10', 't', 'first',
      '\nA', '旧 名.md',
      '',
    ].join('\0')
    expect(parseLog(out)).toEqual([
      { hash: h('a'), time: 30, author: '张 三', subject: '改 名后', path: '新/名 字.md', status: 'M' },
      { hash: h('b'), time: 20, author: 't', subject: 'rename', path: '新/名 字.md', status: 'R' },
      { hash: h('c'), time: 15, author: 't', subject: 'merge', path: '旧 名.md', status: '' },
      { hash: h('d'), time: 10, author: 't', subject: 'first', path: '旧 名.md', status: 'A' },
    ])
  })

  it('复制、删除；空输出', () => {
    const out = [h('a'), '2', 't', 'del', '\nD', 'b.md', h('b'), '1', 't', 'copy', '\nC075', 'a.md', 'b.md', ''].join('\0')
    expect(parseLog(out).map((e) => [e.status, e.path])).toEqual([['D', 'b.md'], ['C', 'b.md']])
    expect(parseLog('')).toEqual([])
  })
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
    ["git: 'lfs' is not a git command. See 'git --help'.", 'lfsMissing'],
    // lfsFilter（git-lfs 3.8 实测：smudge / pull 离线、checkout 时 smudge 失败）
    ['Downloading a.png (5 B)\nError downloading object: a.png (0000000): Smudge error: Error downloading a.png (00…01): error initializing custom adapter', 'lfsFilter'],
    ["Error initializing custom adapter\nFailed to fetch some objects from 'file:///x/remote.git'", 'lfsFilter'],
    ['error: external filter \'git-lfs filter-process\' failed\nfatal: a.png: smudge filter lfs failed', 'lfsFilter'],
    ["Smudge error: Error downloading a.png: Post \"https://x.invalid/info/lfs/objects/batch\": dial tcp: lookup x.invalid: Could not resolve host", 'lfsFilter'],
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
    expect(await git.status()).toEqual({
      branch: expect.any(String),
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [
        { path: 'a.md', x: '.', y: 'M' },
        { path: '新 笔记.md', x: 'R', y: '.', orig: '旧 目录/笔记 一.md' },
        { path: '未跟踪 文件.md', x: '?', y: '?' },
      ],
    })
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

  // 工作区对比读 `HEAD:./路径`：按 git 的工作目录解析，笔记库是仓库子目录时也读得到
  it('HEAD:./ 相对笔记库（仓库子目录）', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    mkdirSync(path.join(repo, '笔记'))
    writeFileSync(path.join(repo, '笔记', 'a.md'), '子目录\n')
    sh('add', '.')
    sh('commit', '-qm', '1')

    const git = new Git('git', process.env.PATH!, path.join(repo, '笔记'), undefined, env)
    expect((await git.readBlob('HEAD:./a.md'))?.toString()).toBe('子目录\n')
    expect(await git.readBlob('HEAD:a.md')).toBeNull() // 不加 ./ 是相对仓库根
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

  it('git 面板：只列笔记库（仓库子目录）内的改动，暂存 / 取消暂存、提交、push 设上游、pull、仓库历史', async () => {
    const { dir, repo, env, sh, globalConfig } = setup()
    const remote = path.join(dir, 'r.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env })
    sh('init', '-q', '-b', 'main')
    sh('remote', 'add', 'origin', remote)
    mkdirSync(path.join(repo, '笔记'))
    writeFileSync(path.join(repo, '笔记', '[x].md'), '1\n') // 文件名里的 [ ] 按字面处理（按通配符会去匹配 x.md）
    writeFileSync(path.join(repo, '笔记', 'b.md'), '1\n')
    writeFileSync(path.join(repo, '库外.md'), '1\n')
    const git = new Git('git', process.env.PATH!, path.join(repo, '笔记'), undefined, env)
    expect((await git.status()).files).toEqual([
      { path: '[x].md', x: '?', y: '?' },
      { path: 'b.md', x: '?', y: '?' },
    ])
    expect(await git.log()).toEqual([])
    // 库外预先暂存的文件：stagedOutside 列出来，提交前据此拦下
    expect(await git.stagedOutside()).toEqual([])
    sh('add', '库外.md')
    expect(await git.stagedOutside()).toEqual(['库外.md'])
    expect(await git.toplevel()).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env }).toString().trim())
    // 用户配置 diff.relative=true 时照样能查到库外的（否则 diff 只列 cwd 以内）
    sh('config', 'diff.relative', 'true')
    expect(await git.stagedOutside()).toEqual(['库外.md'])
    sh('config', '--unset', 'diff.relative')
    sh('reset', '-q', '--', '库外.md')
    await git.stage(['[x].md'])
    expect((await git.status()).files.map((f) => f.x + f.y)).toEqual(['A.', '??'])
    await git.unstage(['[x].md']) // 还没有 HEAD：从暂存区移除
    expect((await git.status()).files.map((f) => f.x + f.y)).toEqual(['??', '??'])
    await git.stage(['.'])
    // 缺身份：useConfigOnly 让 git 报错，而不是用主机名拼一个
    await expect(git.commit('x')).rejects.toMatchObject({ kind: 'noIdentity' })
    writeFileSync(globalConfig, '[user]\n\tname = t\n\temail = t@t\n')
    await git.commit('-第一条') // 以 - 开头的提交信息不被当成选项
    expect(await git.status()).toMatchObject({ branch: 'main', upstream: null, files: [] })
    await git.push(false)
    expect(await git.status()).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
    writeFileSync(path.join(repo, '笔记', 'b.md'), '2\n')
    await git.stage(['b.md'])
    await git.unstage(['b.md']) // 有 HEAD：restore --staged
    expect((await git.status()).files).toEqual([{ path: 'b.md', x: '.', y: 'M' }])
    await git.stage(['b.md'])
    await git.commit('第二条')
    expect(await git.status()).toMatchObject({ ahead: 1, behind: 0 })
    expect((await git.log()).map((e) => [e.subject, e.author, e.path])).toEqual([['第二条', 't', ''], ['-第一条', 't', '']])
    // 另一个克隆推一个新提交：push 被拒，pull 合并后再 push
    const other = path.join(dir, 'other')
    execFileSync('git', ['clone', '-q', remote, other], { env })
    writeFileSync(path.join(other, '笔记', '[x].md'), '远端\n')
    execFileSync('git', ['commit', '-qam', '远端'], { cwd: other, env })
    execFileSync('git', ['push', '-q'], { cwd: other, env })
    await expect(git.push(true)).rejects.toMatchObject({ kind: 'nonFastForward' })
    await git.pull()
    expect(readFileSync(path.join(repo, '笔记', '[x].md'), 'utf8')).toBe('远端\n')
    await git.push(true)
    expect(await git.status()).toMatchObject({ ahead: 0, behind: 0 })
  })

  it('用户配置（color=always、diff.relative、status.relativePaths 等）不影响解析：status / stagedOutside / stagedMentions / fileLog', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q', '-b', 'main')
    for (const [k, v] of [['color.ui', 'always'], ['color.grep', 'always'], ['color.diff', 'always'], ['color.status', 'always'], ['diff.relative', 'true'], ['status.relativePaths', 'false'], ['core.quotePath', 'true'], ['log.showSignature', 'true']])
      sh('config', k, v)
    mkdirSync(path.join(repo, '笔记'))
    writeFileSync(path.join(repo, '笔记', '旧 名.md'), '![](attachments/图.png)\n')
    writeFileSync(path.join(repo, '库外.md'), '1\n')
    sh('add', '.')
    sh('commit', '-qm', '1')
    sh('mv', '笔记/旧 名.md', '笔记/新 名.md')
    sh('commit', '-qm', '2')
    writeFileSync(path.join(repo, '库外.md'), '2\n')
    sh('add', '库外.md')
    writeFileSync(path.join(repo, '笔记', '新 名.md'), '') // 工作区删了引用，暂存区里还在
    const git = new Git('git', process.env.PATH!, path.join(repo, '笔记'), undefined, env)
    expect((await git.status()).files).toEqual([{ path: '新 名.md', x: '.', y: 'M' }])
    expect(await git.stagedOutside()).toEqual(['库外.md'])
    expect(await git.stagedMentions(['attachments/图.png'])).toEqual(['attachments/图.png'])
    expect((await git.fileLog('新 名.md')).map((e) => [e.subject, e.status, e.path])).toEqual([['2', 'R', '新 名.md'], ['1', 'A', '旧 名.md']])
  })

  it('stagedMentions：按暂存区版本的笔记查附件引用（编码形式、大小写不敏感），不看工作区', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, 'a.md'), '![](attachments/My%20Pic.PNG)\n')
    writeFileSync(path.join(repo, 'b.txt'), 'x.png\n') // 不是笔记，不算
    sh('add', '.')
    sh('config', 'grep.fullName', 'true')
    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    writeFileSync(path.join(repo, 'a.md'), '') // 工作区删了引用，但没暂存
    expect(await git.stagedMentions(['attachments/my pic.png', 'attachments/x.png', 'attachments/none.png'])).toEqual(['attachments/my pic.png'])
    sh('add', 'a.md')
    expect(await git.stagedMentions(['attachments/my pic.png'])).toEqual([])
  })

  // 靠「PATH 里只放 git、不放 git-lfs」来复现。Git for Windows 把 git-lfs.exe 和 git 依赖的 DLL 放在同一个 mingw64/bin 里，
  // 没法单独去掉 git-lfs；Windows 上 msys sh 的报错文本相同，由上面的文本用例覆盖
  it.skipIf(process.platform === 'win32')('缺 git-lfs 经 Git.run() 分类为 lfsMissing', async () => {
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
    expect((await git.status()).files).toEqual([{ path: '.gitattributes', x: '?', y: '?' }])
    expect(await git.lfsPaths(['attachments/图.png', 'a.md'])).toEqual(['attachments/图.png'])
  })

  it('fileLog：--follow 跨重命名（含从库外改名进来），路径按字面匹配，可按提交读旧版本', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    mkdirSync(path.join(repo, 'vault', '笔记'), { recursive: true })
    writeFileSync(path.join(repo, 'x y.md'), '1\n')
    sh('add', '.')
    sh('commit', '-qm', 'first')
    writeFileSync(path.join(repo, 'x y.md'), '1\n2\n')
    sh('commit', '-qam', 'second\n\nbody')
    sh('mv', 'x y.md', 'vault/笔记/新 名[x].md')
    sh('commit', '-qm', 'rename')
    writeFileSync(path.join(repo, 'vault/笔记/新 名x.md'), 'other') // [x] 若被当通配符会匹配到它
    sh('add', '.')
    sh('commit', '-qm', 'sibling')
    writeFileSync(path.join(repo, 'vault/笔记/新 名[x].md'), '1\n2\n3\n')
    sh('commit', '-qam', 'fourth')

    const git = new Git('git', process.env.PATH!, path.join(repo, 'vault'), undefined, env)
    const log = await git.fileLog('笔记/新 名[x].md')
    expect(log.map((e) => [e.subject, e.path, e.status])).toEqual([
      ['fourth', '笔记/新 名[x].md', 'M'],
      ['rename', '笔记/新 名[x].md', 'R'],
      ['second', '../x y.md', 'M'],
      ['first', '../x y.md', 'A'],
    ])
    expect(log[0].author).toBe('t')
    expect((await git.readBlob(`${log[2].hash}:./${log[2].path}`))?.toString()).toBe('1\n2\n')
    expect((await git.readBlob(`${log[1].hash}:./${log[1].path}`))?.toString()).toBe('1\n2\n')
    expect(await git.fileLog('没有.md')).toEqual([])
    git.close()
  })

  it('fileLog：还没有提交时为空', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, 'a.md'), '')
    expect(await new Git('git', process.env.PATH!, repo, undefined, env).fileLog('a.md')).toEqual([])
  })

  it('restoreSource / restore：取删除前最后一版，只写工作区；历史里没有、不是普通文件时不恢复', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    mkdirSync(path.join(repo, 'attachments'))
    writeFileSync(path.join(repo, 'attachments/图 [1].png'), 'v1')
    sh('add', '.')
    sh('commit', '-qm', 'add')
    writeFileSync(path.join(repo, 'attachments/图 [1].png'), 'v2')
    sh('commit', '-qam', 'edit')
    sh('rm', '-q', '--', 'attachments/图 [1].png')
    sh('commit', '-qm', 'delete')

    const changed = vi.fn()
    const git = new Git('git', process.env.PATH!, repo, changed, env)
    const src = await git.restoreSource('attachments/图 [1].png')
    expect(src?.subject).toBe('edit')
    await git.restore(src!.hash, 'attachments/图 [1].png')
    expect(readFileSync(path.join(repo, 'attachments/图 [1].png'), 'utf8')).toBe('v2')
    expect(changed).toHaveBeenCalled() // 恢复后通知索引对账
    expect((await git.status()).files).toEqual([{ path: 'attachments/图 [1].png', x: '?', y: '?' }])
    expect(await git.restoreSource('attachments/没有.png')).toBeNull()
    expect(await git.isFileAt(src!.hash, 'attachments')).toBe(false) // 目录
    rmSync(path.join(repo, 'attachments/图 [1].png'))
  })

  it.skipIf(process.platform === 'win32')('restoreSource：历史里是符号链接的不恢复', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    mkdirSync(path.join(repo, 'attachments'))
    symlinkSync('/etc/hosts', path.join(repo, 'attachments/l.png'))
    sh('add', '.')
    sh('commit', '-qm', 'link')
    rmSync(path.join(repo, 'attachments/l.png'))
    expect(await new Git('git', process.env.PATH!, repo, undefined, env).restoreSource('attachments/l.png')).toBeNull()
  })

  // LFS（S17）：本地 file:// 远端走 git-lfs 的 standalone transfer，不联网。没装 git-lfs 的机器跳过（CI 的 macOS / Windows 镜像都带）
  const hasLfs = (() => {
    try {
      execFileSync('git', ['lfs', 'version'])
      return true
    } catch {
      return false
    }
  })()
  // 带 --include 特殊字符的附件名：[ ] * , 和空格；Windows 文件名不能含 *，那里去掉 *
  const SPECIAL = process.platform === 'win32' ? 'a b[1],c.png' : 'a b[1]*,c.png'
  // 源仓库提交两版附件（第二版删掉 old.png）推到 bare 远端，再按 GIT_LFS_SKIP_SMUDGE=1 克隆：工作区全是指针、本地没有 LFS 对象。
  // 笔记库是克隆里的 `笔 记` 子目录，附件名带 LFS --include 的特殊字符
  const lfsRepo = () => {
    const t = setup()
    writeFileSync(t.globalConfig, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n')
    const src = path.join(t.dir, 'src')
    const remote = path.join(t.dir, 'remote.git')
    const clone = path.join(t.dir, 'clone')
    const g = (cwd: string, ...a: (string | { input: string })[]) => {
      const input = a.find((x) => typeof x !== 'string')?.input
      return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a.filter((x) => typeof x === 'string')], { cwd, env: t.env, input }).toString()
    }
    mkdirSync(path.join(src, '笔 记', 'attachments'), { recursive: true })
    writeFileSync(path.join(src, '.gitattributes'), '笔?记/attachments/** filter=lfs diff=lfs merge=lfs -text\n')
    const files = { [SPECIAL]: Buffer.alloc(3000, 1), 'x.png': Buffer.alloc(2000, 2), 'old.png': Buffer.alloc(2500, 3) }
    for (const [n, b] of Object.entries(files)) writeFileSync(path.join(src, '笔 记', 'attachments', n), b)
    g(t.dir, 'init', '-q', '--bare', '-b', 'main', remote)
    g(src, 'init', '-q', '-b', 'main')
    g(src, 'add', '.')
    g(src, 'commit', '-qm', '1')
    g(src, 'rm', '-q', '笔 记/attachments/old.png')
    g(src, 'commit', '-qm', '2')
    // LFS 的本地传输要 file:// URL，裸路径不行；Windows 上是 file:///C:/…
    g(src, 'push', '-q', pathToFileURL(remote).href, 'main')
    execFileSync('git', ['clone', '-q', pathToFileURL(remote).href, clone], { env: { ...t.env, GIT_LFS_SKIP_SMUDGE: '1' } })
    return { ...t, vault: path.join(clone, '笔 记'), remote, files, g }
  }

  it.skipIf(!hasLfs)('LFS 已安装：历史指针先查本地对象，点了才 smudge；工作区指针按字面路径 lfs pull', async () => {
    const { vault, remote, files, env, g } = lfsRepo()
    const changed = vi.fn()
    const git = new Git('git', process.env.PATH!, vault, changed, env)
    const att = (n: string) => path.join(vault, 'attachments', n)
    expect(await git.lfsInstalled()).toBe(true)
    expect(await git.lfsUsed()).toBe(true)
    // 工作区和 HEAD 里都是指针，本地没有对象：readFileAt 原样给指针，不下载
    expect(readFileSync(att('x.png')).length).toBeLessThan(200)
    const ptr = await git.readFileAt('HEAD:./attachments/x.png')
    expect(ptr?.toString()).toMatch(/^version https:\/\/git-lfs/)
    expect(await git.readFileAt('HEAD~1:./attachments/old.png')).toEqual(await git.readBlob('HEAD~1:./attachments/old.png'))

    // 工作区：pull 只下这一个（带 [ ] * , 和空格的另一个仍是指针）。lfs.fetchexclude 排除了一切，pull 和下面的历史 smudge
    // 照样下（用户点了才下载）
    g(vault, 'config', 'lfs.fetchexclude', '*')
    await git.lfsPull('attachments/x.png')
    expect(readFileSync(att('x.png'))).toEqual(files['x.png'])
    expect(readFileSync(att(SPECIAL)).length).toBeLessThan(200)
    expect(changed).toHaveBeenCalled()
    // 对象已在本地：历史读取直接换成真实内容
    expect(await git.readFileAt('HEAD:./attachments/x.png')).toEqual(files['x.png'])

    // 历史里删掉的：点了才 smudge，之后对象在本地，readFileAt 直接给内容
    expect(await git.lfsSmudge('HEAD~1:./attachments/old.png', 'attachments/old.png')).toEqual(files['old.png'])
    expect(await git.readFileAt('HEAD~1:./attachments/old.png')).toEqual(files['old.png'])
    // 不是指针的原样返回
    expect((await git.lfsSmudge('HEAD:./../.gitattributes', '../.gitattributes'))?.toString()).toContain('filter=lfs')

    // 远端不可达：pull / smudge 失败分类为 lfsFilter，文件不动
    renameSync(remote, `${remote}.gone`)
    await expect(git.lfsPull(`attachments/${SPECIAL}`)).rejects.toMatchObject({ kind: 'lfsFilter' })
    expect(readFileSync(att(SPECIAL)).length).toBeLessThan(200)
    const orphanPtr = g(vault, 'hash-object', '-w', '--no-filters', '--stdin', { input: `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 5\n` }).trim()
    await expect(git.lfsSmudge(orphanPtr, 'attachments/zz.png')).rejects.toMatchObject({ kind: 'lfsFilter' })
    renameSync(`${remote}.gone`, remote)
    await git.lfsPull(`attachments/${SPECIAL}`)
    expect(readFileSync(att(SPECIAL))).toEqual(files[SPECIAL])
    expect((await git.status()).files).toEqual([])
    git.close()
  })

  // 下载命令退出码 0 却没换出内容（比如被别的配置跳过）：用一个包装过的 git 模拟，smudge 原样吐回指针、pull 什么都不做
  it.skipIf(!hasLfs || process.platform === 'win32')('下载"成功"后仍是指针：smudge / pull 都报 lfsFilter', async () => {
    const { dir, vault, env } = lfsRepo()
    const fake = path.join(dir, 'fake-git')
    writeFileSync(fake, `#!/bin/sh\ncase " $* " in\n  *" lfs smudge "*) cat; exit 0;;\n  *" lfs pull "*) exit 0;;\nesac\nexec git "$@"\n`, { mode: 0o755 })
    const git = new Git(fake, process.env.PATH!, vault, undefined, env)
    await expect(git.lfsSmudge('HEAD~1:./attachments/old.png', 'attachments/old.png')).rejects.toMatchObject({ kind: 'lfsFilter', stderr: expect.stringContaining('still an LFS pointer') })
    await expect(git.lfsPull('attachments/x.png')).rejects.toMatchObject({ kind: 'lfsFilter', stderr: expect.stringContaining('still an LFS pointer') })
    git.close()
  })

  // 没装 git-lfs：同上「PATH 里只放 git」的做法。读历史只靠 cat-file，照常给出指针；按属性仍能看出库用了 LFS
  it.skipIf(!hasLfs || process.platform === 'win32')('LFS 未安装：指针照常读出，lfs pull / smudge 分类为 lfsMissing', async () => {
    const { dir, vault, env } = lfsRepo()
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(execFileSync('git', ['--exec-path']).toString().trim() + '/git', path.join(bin, 'git'))
    // 全局 filter 配置也去掉（macOS 上常见的状态），否则 status 会因找不到 git-lfs 失败
    const noFilter = { ...env, GIT_CONFIG_GLOBAL: path.join(dir, 'empty') }
    writeFileSync(noFilter.GIT_CONFIG_GLOBAL, '')
    const git = new Git(path.join(bin, 'git'), bin, vault, undefined, noFilter)
    expect(await git.lfsInstalled()).toBe(false)
    expect(await git.lfsUsed()).toBe(true)
    expect((await git.readFileAt('HEAD:./attachments/x.png'))?.toString()).toMatch(/^version https:\/\/git-lfs/)
    await expect(git.lfsPull('attachments/x.png')).rejects.toMatchObject({ kind: 'lfsMissing' })
    await expect(git.lfsSmudge('HEAD:./attachments/x.png', 'attachments/x.png')).rejects.toMatchObject({ kind: 'lfsMissing' })
    // 有 filter.lfs.required 却找不到 git-lfs：status 需要重新 hash 指针时失败，分类为 lfsMissing（主进程据此给 lfsError）
    const required = new Git(path.join(bin, 'git'), bin, vault, undefined, env)
    writeFileSync(path.join(vault, 'attachments/x.png'), readFileSync(path.join(vault, 'attachments/x.png'))) // 改 mtime
    await expect(required.status()).rejects.toMatchObject({ kind: 'lfsMissing' })
    git.close()
    required.close()
  })

  // 按扩展名配置 LFS、还没有任何已跟踪的 PNG：第一张粘贴进来的未跟踪图片就要让 lfsUsed 为 true（codex #37 第三轮）
  it('lfsUsed 看 attachments/ 下的未跟踪文件，忽略的不算', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, '.gitattributes'), '*.png filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(path.join(repo, '.gitignore'), 'attachments/ignored.png\n')
    mkdirSync(path.join(repo, 'attachments'))
    writeFileSync(path.join(repo, 'attachments/a.pdf'), 'pdf')
    writeFileSync(path.join(repo, 'attachments/ignored.png'), 'x')
    sh('add', '.')
    sh('commit', '-qm', '1')
    const git = new Git('git', process.env.PATH!, repo, undefined, env)
    expect(await git.lfsUsed()).toBe(false) // 只有 pdf（不走 LFS）和被忽略的 png
    writeFileSync(path.join(repo, 'attachments/图 [1].png'), 'png')
    expect(await git.lfsUsed()).toBe(true)
  })

  it('没有 LFS 属性的库 lfsUsed 为 false', async () => {
    const { repo, env, sh } = setup()
    sh('init', '-q')
    writeFileSync(path.join(repo, 'a.md'), 'a\n')
    sh('add', '.')
    expect(await new Git('git', process.env.PATH!, repo, undefined, env).lfsUsed()).toBe(false)
  })
})
