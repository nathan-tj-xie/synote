// git 服务（ADR 0004）：只用系统 git CLI 子进程；查找、porcelain 解析、错误分类、常驻 cat-file
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitBranch, GitErrorKind, GitFile, LogEntry } from '../shared/api'
import { hasConflictMarkers } from '../shared/conflicts'
import { parseLfsPointer, type LfsPointer } from '../shared/lfs'
import { encodeSegment } from '../shared/url'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string },
) => Promise<ExecResult>

// 启动失败（ENOENT）、超时都记为 code -1，不抛异常；input 写进子进程的 stdin
export const exec: Exec = (file, args, { input, ...opts } = {}) =>
  new Promise((resolve) => {
    const cp = execFile(file, args, { ...opts, maxBuffer: 1 << 28, windowsHide: true }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : -1
      resolve({ code, stdout, stderr })
    })
    cp.stdin?.on('error', () => {}) // 进程提前退出时写 stdin 会 EPIPE，结果以退出码为准
    if (input !== undefined) cp.stdin?.end(input)
  })

export const MIN_VERSION = [2, 38] as const

export function parseVersion(out: string): number[] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export const versionOk = (v: number[]) => v[0] > MIN_VERSION[0] || (v[0] === MIN_VERSION[0] && v[1] >= MIN_VERSION[1])

export type GitDetectionResult =
  | { status: 'ok'; bin: string; version: string; PATH: string }
  | { status: 'tooOld'; bin: string; version: string }
  | { status: 'missing' }

// 查找顺序：设置项 → macOS 登录 shell 的 PATH（3 s 超时）→ 当前 PATH，每一级都要求 ≥ 2.38
export async function findGit(o: {
  setting?: string
  platform: NodeJS.Platform
  PATH: string
  shell?: string
  exec: Exec
  isFile: (p: string) => boolean
}): Promise<GitDetectionResult> {
  const win = o.platform === 'win32'
  const mac = o.platform === 'darwin'
  // 路径规则跟着传入的 platform 走，不用宿主平台的（测试里会在 Windows 上模拟 macOS）
  const p = win ? path.win32 : path.posix
  const which = (PATH: string) =>
    PATH.split(p.delimiter)
      .filter(Boolean)
      .map((d) => p.join(d, win ? 'git.exe' : 'git'))
      .find(o.isFile)

  let clt: boolean | undefined
  let tooOld: GitDetectionResult | undefined
  // git 子进程用选中那一级的 PATH，否则 git 能找到、git-lfs 却找不到（research/lfs 2.5）
  const probe = async (bin: string | undefined, PATH: string): Promise<GitDetectionResult | undefined> => {
    if (!bin) return
    // /usr/bin/git 是 shim：没装 Command Line Tools 时一调用就弹安装框，先用 xcode-select -p 确认
    if (mac && bin === '/usr/bin/git' && !(clt ??= (await o.exec('/usr/bin/xcode-select', ['-p'])).code === 0)) return
    const r = await o.exec(bin, ['--version'], { env: { ...process.env, PATH } })
    const v = r.code === 0 ? parseVersion(r.stdout) : null
    if (!v) return
    const version = v.join('.')
    if (versionOk(v)) return { status: 'ok', bin, version, PATH }
    tooOld ??= { status: 'tooOld', bin, version }
  }

  // 设置项先验证，合法就不必等登录 shell（最多 3 s）
  // shortcut: 设置项命中时 git-lfs 只在 git 同目录和当前 PATH 里找；有 lfs 误报未安装的反馈时再后台补取登录 shell PATH
  const set = o.setting && (await probe(o.setting, [p.dirname(o.setting), o.PATH].join(p.delimiter)))
  if (set) return set

  let loginPATH: string | undefined
  if (mac) {
    // 从 Finder / Dock 启动时 PATH 只有系统目录，用登录 shell 的 PATH 才能找到 Homebrew 的 git 和 git-lfs
    const r = await o.exec(o.shell || '/bin/zsh', ['-ilc', 'echo "SYNOTE_PATH=$PATH"'], { timeout: 3000 })
    loginPATH = r.code === 0 ? /SYNOTE_PATH=(.*)/.exec(r.stdout)?.[1] : undefined
  }
  return (
    (loginPATH && (await probe(which(loginPATH), loginPATH))) ||
    (await probe(which(o.PATH), o.PATH)) ||
    tooOld || { status: 'missing' }
  )
}

export type StatusEntry =
  | { kind: 'changed' | 'unmerged'; xy: string; path: string }
  | { kind: 'renamed'; xy: string; path: string; orig: string }
  | { kind: 'untracked' | 'ignored'; path: string }

// 解析 `status --porcelain=v2 -z`：路径不加引号、可含空格，按字段数切分，最后一段整体是路径
export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0')
  const res: StatusEntry[] = []
  const rest = (s: string, n: number) => s.split(' ').slice(n).join(' ') // 跳过前 n 个字段
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const xy = p.slice(2, 4)
    if (p[0] === '1') res.push({ kind: 'changed', xy, path: rest(p, 8) })
    else if (p[0] === '2') res.push({ kind: 'renamed', xy, path: rest(p, 9), orig: parts[++i] }) // 原路径是下一段
    else if (p[0] === 'u') res.push({ kind: 'unmerged', xy, path: rest(p, 10) })
    else if (p[0] === '?') res.push({ kind: 'untracked', path: p.slice(2) })
    else if (p[0] === '!') res.push({ kind: 'ignored', path: p.slice(2) })
  }
  return res
}

// `status --porcelain=v2 --branch` 的头部：分支（detached 时为 null）、上游、↑ahead / ↓behind（没有上游时为 0）
export function parseBranch(out: string): GitBranch {
  const head = (k: string) => out.split('\0').find((l) => l.startsWith(`# branch.${k} `))?.slice(k.length + 10)
  const branch = head('head')
  const ab = /^\+(\d+) -(\d+)$/.exec(head('ab') ?? '')
  return { branch: branch && branch !== '(detached)' ? branch : null, upstream: head('upstream') ?? null, ahead: ab ? Number(ab[1]) : 0, behind: ab ? Number(ab[2]) : 0 }
}

// 与 parseLog 配套的格式：每条提交 4 个字段，-z 下各以 NUL 结尾
export const LOG_FORMAT = '--format=%H%x00%at%x00%an%x00%s'

// 解析 `log -z --name-status LOG_FORMAT`：字段后面跟以 \n 开头的状态段，R / C 带旧、新两个路径，其余一个。
// path 是该提交里文件的路径（相对仓库根）；没有状态段的提交（如 merge）用更旧一侧的路径，即较新那条改名之前的名字
export function parseLog(out: string): LogEntry[] {
  const t = out.split('\0')
  const res: LogEntry[] = []
  let before = '' // 已解析的最旧一条提交之前，文件叫什么
  let i = 0
  while (i + 3 < t.length && t[i]) {
    const [hash, time, author, subject] = t.slice(i, (i += 4))
    let path = before
    let status = ''
    while (t[i]?.startsWith('\n')) {
      status = t[i].slice(1)
      const two = status[0] === 'R' || status[0] === 'C'
      path = t[i + (two ? 2 : 1)]
      before = t[i + 1]
      i += two ? 3 : 2
    }
    res.push({ hash, time: Number(time), author, subject, path, status: status[0] ?? '' })
  }
  return res
}

// 按 git / curl / ssh 的真实输出逐条收窄（见 git.test.ts）；不确定的归 unknown，让调用方展示原文，而不是给错引导
const errorPatterns: [GitErrorKind, RegExp][] = [
  [
    'noIdentity',
    /Please tell me who you are|unable to auto-detect email address|empty ident name|no (name|email) was given and auto-detection is disabled/,
  ],
  [
    'noCredentials',
    // 401 / 403 也带 "unable to access"，必须排在 network 前面
    /could not read (Username|Password) for|Authentication failed for|The requested URL returned error: 40[13]|Permission denied \((publickey|password|keyboard-interactive)/,
  ],
  // 只认这几种原因；tag already exists、stale info、remote rejected（hook）等都不算
  ['nonFastForward', /\[rejected\] .*\((non-fast-forward|fetch first)\)|Not possible to fast-forward/],
  ['conflict', /^CONFLICT \(|Automatic merge failed/m],
  ['lfsMissing', /git-lfs: (command )?not found|'git-lfs' was not found|cannot run git-lfs|git: 'lfs' is not a git command/],
  // LFS 的 smudge / clean filter 或下载失败（离线、LFS 远端不可达等）。排在 lfsMissing 之后（缺二进制时也报 filter failed），
  // network 之前（LFS 的报错里也会带 Could not resolve host 之类）
  ['lfsFilter', /Smudge error|smudge filter '?lfs'? failed|clean filter '?lfs'? failed|Error downloading object|Failed to fetch some objects|external filter '?git-lfs[^']*'? failed/],
  [
    'network',
    /Could not resolve host|Failed to connect to|Connection (timed out|refused|reset|closed by)|Operation timed out|Network is unreachable|SSL_ERROR_SYSCALL/,
  ],
  ['notRepo', /not a git repository/],
]

// 错误分类靠输出文本，子进程统一 LC_ALL=C 保证是英文；merge / pull 的 CONFLICT 提示在 stdout，所以两个通道都要看
export const classifyGitError = (stderr: string, stdout = ''): GitErrorKind =>
  errorPatterns.find(([, re]) => re.test(stderr) || re.test(stdout))?.[0] ?? 'unknown'

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    readonly code: number,
    readonly stderr: string,
    readonly stdout = '',
  ) {
    super(stderr.trim() || stdout.trim() || `git exited with ${code}`)
  }
}

// 提交前发现库外的已暂存文件：按 GitError 走同一条失败回传，带上要列给用户的路径
export class StagedOutsideError extends GitError {
  constructor(
    readonly top: string,
    readonly paths: string[],
  ) {
    super('stagedOutside', -1, paths.join('\n'))
  }
}

// 完成合并前还有没解决的文件（冲突中或暂存内容带标记，S16），带上要列给用户的路径
export class UnresolvedError extends GitError {
  constructor(readonly paths: string[]) {
    super('unresolved', -1, paths.join('\n'))
  }
}

// `config --get`、`rev-parse --verify --quiet` 查不到时退出码为 1，记为 fallback；其它失败（配置损坏、权限等）照常抛出
const onExit1 =
  <T>(fallback: T) =>
  (e: unknown): T => {
    if (e instanceof GitError && e.code === 1) return fallback
    throw e
  }

// 每条 git 命令都带上，压掉会改变输出格式的用户配置：解析靠的是固定格式，用户的 ~/.gitconfig 不能让它失效
// - color.*：=always 时输出（含 stderr 的提示）带 ANSI 码，路径匹配和错误分类都会失败；color.ui 管不住单项配置，逐项关
// - core.quotePath：非 -z 的输出里中文路径会被转成八进制转义
// - diff.relative：diff / log --name-status 只列 cwd 以内、路径变成相对 cwd（库外暂存检查、跨库外改名的历史都依赖完整路径）
// - grep.fullName：git grep 输出相对仓库根而不是 cwd
// - status.relativePaths：porcelain 本来就不受影响，一并固定
// - log.showSignature：log 里插入签名校验输出，打乱 parseLog
// - core.pager：配合 GIT_PAGER=cat，不起分页器
const CONFIG_OVERRIDES = [
  'color.ui=false',
  'color.diff=false',
  'color.grep=false',
  'color.status=false',
  'color.branch=false',
  'color.decorate=false',
  'color.advice=false',
  'color.push=false',
  'color.remote=false',
  'color.transport=false',
  'core.quotePath=false',
  'diff.relative=false',
  'grep.fullName=false',
  'status.relativePaths=false',
  'log.showSignature=false',
  'core.pager=cat',
].flatMap((kv) => ['-c', kv])

export class Git {
  private readonly env: NodeJS.ProcessEnv
  private cat: CatFile | null = null
  private closed = false

  constructor(
    readonly bin: string,
    readonly PATH: string,
    readonly cwd: string,
    // 改动工作区的 git 操作之后调用，通知索引做 stat 对账
    private readonly onWorktreeChanged: () => void = () => {},
    env: NodeJS.ProcessEnv = process.env,
    private readonly run_: Exec = exec,
  ) {
    // GIT_TERMINAL_PROMPT=0：没有凭据时直接失败，不卡在等待终端输入；GIT_PAGER / NO_COLOR 与 CONFIG_OVERRIDES 同理。
    // LC_ALL=C 保留（S12 起就有）：错误分类按英文文本匹配；路径不受它影响（-z 输出原样字节，quotePath 已关）
    this.env = { ...env, PATH, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', NO_COLOR: '1' }
  }

  async run(args: string[], input?: string): Promise<string> {
    const r = await this.run_(this.bin, [...CONFIG_OVERRIDES, ...args], { cwd: this.cwd, env: this.env, input })
    if (r.code !== 0) throw new GitError(classifyGitError(r.stderr, r.stdout), r.code, r.stderr, r.stdout)
    return r.stdout
  }

  // pull、checkout 等会改工作区的操作走这里，成功失败都通知（失败的合并也会写文件）
  async mutate(args: string[]): Promise<string> {
    try {
      return await this.run(args)
    } finally {
      this.onWorktreeChanged()
    }
  }

  // 只有明确的 notRepo 才算不是仓库；所有权检查、配置损坏等错误照常抛出，不能误报成非 git 目录
  async isRepo(): Promise<boolean> {
    const out = await this.run(['rev-parse', '--is-inside-work-tree']).catch((e) => {
      if (e instanceof GitError && e.kind === 'notRepo') return ''
      throw e
    })
    return out.trim() === 'true'
  }

  // git 面板（S13）的数据：只列笔记库（cwd）内的改动，路径换成相对 cwd（porcelain 输出相对仓库根）；
  // x / y 是暂存区 / 工作区一侧的状态，未跟踪记为 ??；merging：有 MERGE_HEAD（S16），冲突（unmerged）的文件带 conflict
  async status(): Promise<GitBranch & { files: GitFile[]; merging: boolean }> {
    // --no-optional-locks：不顺手刷新 .git/index，否则会触发 watcher 再推一次状态
    const [out, prefix, merging] = await Promise.all([
      this.run(['--no-optional-locks', '--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']),
      this.prefix(),
      this.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).then(() => true, onExit1(false)),
    ])
    const rel = (p: string) => path.posix.relative(prefix, p)
    const files = parseStatus(out).flatMap((e): GitFile[] => {
      if (!('xy' in e)) return e.kind === 'untracked' ? [{ path: rel(e.path), x: '?', y: '?' }] : []
      return [{ path: rel(e.path), x: e.xy[0], y: e.xy[1], ...(e.kind === 'renamed' && { orig: rel(e.orig) }), ...(e.kind === 'unmerged' && { conflict: true as const }) }]
    })
    return { ...parseBranch(out), files, merging }
  }

  // 完成合并前的复查（#9 决定 3）：相对 HEAD 改动过的笔记库文件，暂存区或工作区版本里哪些仍有冲突标记（合并提交的是暂存区；
  // 工作区也查，免得自动暂存之后又改出标记、合并完了留在笔记里；未跟踪的笔记（忽略的除外）一并读盘查）。HEAD 里本来就有的
  // （如讲冲突标记的笔记）不算；二进制文件跳过
  async markersLeft(): Promise<string[]> {
    // --raw 直接给出暂存区一侧的 oid：常驻 cat-file 进程只读一次 .git/index，按 `:路径` 读会拿到旧的暂存内容
    const diff = (cached: boolean) =>
      this.run(['--literal-pathspecs', 'diff', ...(cached ? ['--cached'] : []), '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD', '--', '.'])
    const [staged, worktree, untracked, prefix] = await Promise.all([
      diff(true),
      diff(false),
      this.run(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', '.']),
      this.prefix(),
    ])
    const marked = (b: Buffer | null) => !!b && !b.includes(0) && hasConflictMarkers(b.toString('utf8'))
    const res = new Set<string>()
    for (const [out, cached] of [[staged, true], [worktree, false]] as const) {
      const t = out.split('\0')
      for (let i = 0; i + 1 < t.length; i += 2) {
        const oid = t[i].split(' ')[3]
        const rel = path.posix.relative(prefix, t[i + 1])
        // 暂存区一侧全零：冲突中（由调用方按冲突文件拦下）或已删除；工作区一侧的 oid 总是全零，读盘
        const b = cached ? (/^0+$/.test(oid) ? null : await this.readBlob(oid)) : await fs.readFile(path.join(this.cwd, rel)).catch(() => null)
        if (marked(b)) res.add(rel)
      }
    }
    // 未跟踪的只查笔记：附件可能很大，整份读进来不值；ls-files 的输出已相对 cwd
    for (const rel of untracked.split('\0').filter((p) => p.endsWith('.md'))) if (marked(await fs.readFile(path.join(this.cwd, rel)).catch(() => null))) res.add(rel)
    return [...res].sort()
  }

  // 非 Markdown 的冲突（附件、删除 / 修改等）没法在冲突视图里逐块解决：整份取一侧（ours 为本地）并暂存；那一侧没有这个文件就删除
  async takeSide(rel: string, side: 'ours' | 'theirs'): Promise<void> {
    // 每行 `<mode> <oid> <stage>\t<path>`，stage 2 是 ours、3 是 theirs
    const out = await this.run(['--literal-pathspecs', 'ls-files', '-u', '-z', '--', rel])
    const stages = out.split('\0').filter(Boolean).map((l) => l.split('\t')[0].split(' ')[2])
    if (!stages.length) throw new GitError('unknown', -1, `${rel} is not in conflict`)
    if (stages.includes(side === 'ours' ? '2' : '3')) {
      await this.mutate(['--literal-pathspecs', 'checkout', `--${side}`, '--', rel])
      await this.stage([rel])
    } else await this.mutate(['--literal-pathspecs', 'rm', '-q', '-f', '--', rel]) // -f：冲突中的工作区文件本来就和暂存区不同
  }

  // 用 git 生成的合并信息（MERGE_MSG）提交暂存区；工作区里没暂存的改动不进合并提交
  mergeContinue(): Promise<string> {
    return this.mutate(['-c', 'user.useConfigOnly=true', 'commit', '-q', '--no-edit'])
  }

  mergeAbort(): Promise<string> {
    return this.mutate(['merge', '--abort'])
  }

  // 笔记库在仓库里的前缀（如 `笔记/`，库就是仓库根时为空）
  private async prefix(): Promise<string> {
    return (await this.run(['rev-parse', '--show-prefix'])).replace(/\n$/, '')
  }

  // 暂存区里笔记库之外的路径（相对仓库根，--no-renames 让改名的两侧都列出来）。笔记库就是仓库根时为空。
  async stagedOutside(): Promise<string[]> {
    const [out, prefix] = await Promise.all([
      this.run(['diff', '--cached', '--name-only', '-z', '--no-renames']),
      this.prefix(),
    ])
    return prefix ? out.split('\0').filter((p) => p && !p.startsWith(prefix)) : []
  }

  // 暂存区版本的笔记（库内 .md）里仍提到这些附件的（按文件名的几种编码形式、不区分大小写，同索引的 mentioned）。
  // "提交已暂存"时用：工作区里删了引用、但那篇笔记的改动没暂存，提交里它仍引用附件，附件就不能随提交删掉
  // shortcut: 每个附件一次 git grep；一次提交要删上百个孤儿变慢时改成一次读出暂存区笔记再逐个比对
  async stagedMentions(paths: string[]): Promise<string[]> {
    const hit: string[] = []
    for (const p of paths) {
      const name = path.posix.basename(p)
      const forms = [...new Set([name, encodeSegment(name), encodeURIComponent(name), encodeURI(name)])].flatMap((f) => ['-e', f])
      // 没有命中时退出码为 1
      const out = await this.run(['--literal-pathspecs', 'grep', '--cached', '-F', '-i', '-l', '-z', ...forms, '--', '.']).catch(onExit1(''))
      if (out.split('\0').some((f) => f.toLowerCase().endsWith('.md'))) hit.push(p)
    }
    return hit
  }

  async toplevel(): Promise<string> {
    return (await this.run(['rev-parse', '--show-toplevel'])).trim()
  }

  // 暂存（含删除）；paths 为 ['.'] 时暂存笔记库内的全部改动
  stage(paths: string[]): Promise<string> {
    return this.mutate(['--literal-pathspecs', 'add', '-A', '--', ...paths])
  }

  // 取消暂存，只动暂存区；还没有任何提交时没有 HEAD 可还原，改为从暂存区移除
  async unstage(paths: string[]): Promise<string> {
    const args = (await this.hasHead()) ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q']
    return this.mutate(['--literal-pathspecs', ...args, '--', ...paths])
  }

  // 提交暂存区。useConfigOnly：缺身份时报错（noIdentity），不让 git 用主机名拼一个
  commit(message: string): Promise<string> {
    return this.mutate(['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', message])
  }

  // 没有上游时推到 origin 的同名分支并设为上游
  push(hasUpstream: boolean): Promise<string> {
    return this.mutate(hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'])
  }

  // 合并远端（不 rebase，不弹编辑器）；冲突时笔记库进入合并中（S16）
  pull(): Promise<string> {
    return this.mutate(['pull', '--no-rebase', '--no-edit'])
  }

  // git 面板底部的历史：动过笔记库内文件的最近 n 个提交，新的在前
  async log(n = 200): Promise<LogEntry[]> {
    if (!(await this.hasHead())) return []
    return parseLog(await this.run(['--literal-pathspecs', 'log', '-z', `-n${n}`, LOG_FORMAT, '--', '.']))
  }

  async identity(): Promise<{ name: string | null; email: string | null }> {
    const get = (k: string) => this.run(['config', '--get', k]).then((s) => s.trim() || null, onExit1(null))
    const [name, email] = await Promise.all([get('user.name'), get('user.email')])
    return { name, email }
  }

  // LFS 检测（research/lfs 2.2）：本机是否装了 git-lfs；哪些路径按 .gitattributes 应走 LFS
  // `git lfs version` 任何失败都说明 git-lfs 不可用，记为 false
  lfsInstalled(): Promise<boolean> {
    return this.run(['lfs', 'version']).then(() => true, () => false)
  }

  // 笔记库里是否有路径按 .gitattributes 走 LFS：已跟踪文件里有 filter=lfs 的；或 attachments/ 下的实际文件（含未跟踪，
  // 如 `*.png filter=lfs` 时刚粘贴、还没提交的第一张图）、探测路径 attachments/x 会走 LFS。
  // 只看属性、不需要 git-lfs，用来在没装 git-lfs 时提示；要扫全部附件，调用方负责缓存
  async lfsUsed(): Promise<boolean> {
    // attr 魔法要求不加 --literal-pathspecs；不带路径时只列 cwd（笔记库）以内
    if ((await this.run(['ls-files', '-z', '--', ':(attr:filter=lfs)'])).length) return true
    const att = await this.run(['--literal-pathspecs', 'ls-files', '-z', '-co', '--exclude-standard', '--', 'attachments/'])
    const paths = ['attachments/x', ...att.split('\0').filter(Boolean)]
    // --stdin：附件再多也不受命令行长度限制。-z 输出：path NUL attr NUL value NUL
    const out = (await this.run(['check-attr', '--stdin', '-z', 'filter'], paths.map((p) => `${p}\0`).join(''))).split('\0')
    for (let i = 2; i < out.length; i += 3) if (out[i] === 'lfs') return true
    return false
  }

  async lfsPaths(paths: string[]): Promise<string[]> {
    if (!paths.length) return []
    // -z 输出：path NUL attr NUL value NUL
    const out = (await this.run(['check-attr', '-z', 'filter', '--', ...paths])).split('\0')
    const res: string[] = []
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'lfs') res.push(out[i])
    return res
  }

  // 清理孤儿附件（S11）：哪些路径已被跟踪。--literal-pathspecs：文件名里的 * ? [ 不当通配符；输出相对 cwd
  async tracked(paths: string[]): Promise<string[]> {
    if (!paths.length) return []
    return (await this.run(['--literal-pathspecs', 'ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean)
  }

  // 删除已跟踪的文件并暂存这次删除。不加 -f：有未提交的改动时 git 整批拒绝，不丢内容
  rm(paths: string[]): Promise<string> {
    return this.mutate(['--literal-pathspecs', 'rm', '-q', '--', ...paths])
  }

  // 重命名 / 移动（S9）：git mv 保留历史；文件夹里没跟踪的文件随文件夹一起移动
  mv(from: string, to: string): Promise<string> {
    return this.mutate(['mv', '--', from, to])
  }

  // 还没有任何提交时 log 会报错，按没有历史处理
  private hasHead(): Promise<boolean> {
    return this.run(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, onExit1(false))
  }

  // 历史栏（S15）：rel（相对 cwd）的提交历史，--follow 跨重命名；path 换成相对 cwd 的写法（改名前在库外时以 ../ 开头）
  async fileLog(rel: string): Promise<LogEntry[]> {
    if (!(await this.hasHead())) return []
    const [out, p] = await Promise.all([
      this.run(['--literal-pathspecs', 'log', '--follow', '-z', '--name-status', LOG_FORMAT, '--', rel]),
      this.prefix(),
    ])
    return parseLog(out).map((e) => ({ ...e, path: path.posix.relative(p, e.path) }))
  }

  // 从历史恢复附件：最后一个还有 rel 的提交（改动过它、且不是删除它的最近一个提交），找不到为 null
  async restoreSource(rel: string): Promise<LogEntry | null> {
    if (!(await this.hasHead())) return null
    const out = await this.run(['--literal-pathspecs', 'log', '-1', '-z', '--name-status', '--diff-filter=d', LOG_FORMAT, 'HEAD', '--', rel])
    const e = parseLog(out)[0]
    return e && (await this.isFileAt(e.hash, rel)) ? e : null
  }

  // 提交 hash 里 rel 是否为普通文件（100644 / 100755）；目录、符号链接、子模块都不算
  async isFileAt(hash: string, rel: string): Promise<boolean> {
    const out = await this.run(['--literal-pathspecs', 'ls-tree', '-z', hash, '--', rel])
    return /^100(644|755) blob /.test(out) && out.split('\0').filter(Boolean).length === 1
  }

  // 只写工作区，结果是一处未提交的改动
  restore(hash: string, rel: string): Promise<string> {
    return this.mutate(['--literal-pathspecs', 'restore', `--source=${hash}`, '--worktree', '--', rel])
  }

  // 读历史版本里的文件内容（S15、S17）：blob 是 LFS 指针、且对象已在本地 .git/lfs/objects 里时换成真实内容；
  // 不在本地时原样返回指针，由调用方显示占位、用户点了才 lfsSmudge。这里绝不联网
  async readFileAt(spec: string): Promise<Buffer | null> {
    const b = await this.readBlob(spec)
    const p = b && parseLfsPointer(b)
    return (p && (await this.lfsLocal(p))) || b
  }

  // 本地 LFS 对象：<git-common-dir>/lfs/objects/oid[0:2]/oid[2:4]/oid（common dir 兼容 worktree）；大小对不上的当作没有。
  // shortcut: 不读 lfs.storage / `git lfs env` 的 LocalMediaDir，自定义了存储目录的仓库总是走 lfsSmudge；有人这样配时再查
  private commonDir: Promise<string> | null = null
  private async lfsLocal(p: LfsPointer): Promise<Buffer | null> {
    this.commonDir ??= this.run(['rev-parse', '--git-common-dir']).then((d) => path.resolve(this.cwd, d.trim()))
    const dir = await this.commonDir.catch((e) => {
      this.commonDir = null
      throw e
    })
    const b = await fs.readFile(path.join(dir, 'lfs', 'objects', p.oid.slice(0, 2), p.oid.slice(2, 4), p.oid)).catch(() => null)
    return b?.length === p.size ? b : null
  }

  // 用户点了"下载"才调用：把历史里的指针经 `git lfs smudge` 换成真实内容（会联网、走系统凭据），对象顺带存进本地 LFS 存储。
  // 不是指针时原样返回；失败时 smudge 退出码 2、stdout 是指针本身，按 stderr 分类抛出。
  // 用户点了才下载：清空 lfs.fetchinclude / fetchexclude，否则被排除的路径 smudge 退出码 0 却原样吐回指针（实测 git-lfs 3.8）
  async lfsSmudge(spec: string, rel: string): Promise<Buffer | null> {
    const b = await this.readBlob(spec)
    if (!b || !parseLfsPointer(b)) return b
    const out = await new Promise<Buffer>((resolve, reject) => {
      const args = [...CONFIG_OVERRIDES, '-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge', '--', rel]
      const proc = spawn(this.bin, args, { cwd: this.cwd, env: this.env, windowsHide: true })
      const out: Buffer[] = []
      let err = ''
      proc.stdout.on('data', (d: Buffer) => out.push(d))
      proc.stderr.on('data', (d) => (err += d))
      proc.stdin.on('error', () => {}) // 进程提前退出时写 stdin 会 EPIPE，结果以退出码为准
      proc.on('error', (e) => reject(new GitError(classifyGitError(err), -1, err || e.message)))
      proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new GitError(classifyGitError(err), code ?? -1, err))))
      proc.stdin.end(b)
    })
    stillPointer(out, 'git lfs smudge', rel)
    return out
  }

  // 工作区里是指针的文件，下载真实内容写回工作区：`git lfs pull --include=<仓库根相对路径>`。--include 是 gitignore 式的模式，
  // 通配符和反斜杠逐个转义；逗号是多个模式的分隔符且没有转义写法，换成只匹配单个字符的 ?（最多多下同目录里只差这一位的文件）。
  // 用户点了才下载：空的 --exclude= 盖掉 lfs.fetchexclude（--include 同样盖掉 lfs.fetchinclude），否则配置会让它静默跳过。
  // 下完再确认文件已不是指针，仍是指针就报错，不当作成功
  async lfsPull(rel: string): Promise<void> {
    const pattern = (await this.prefix()) + rel
    await this.mutate(['lfs', 'pull', `--include=${pattern.replace(/[\\*?[\]]/g, '\\$&').replace(/,/g, '?')}`, '--exclude='])
    const after = await fs.readFile(path.join(this.cwd, rel)).catch(() => null)
    if (after) stillPointer(after, 'git lfs pull', rel)
  }

  // 读任意版本的 blob（如 `HEAD:a.md`），不存在时为 null；复用常驻的 cat-file --batch 进程
  async readBlob(spec: string): Promise<Buffer | null> {
    // 按行协议传不了含换行的路径（-Z 要 2.42+），先用 rev-parse 换成 oid 再读
    if (/[\r\n]/.test(spec)) {
      const oid = (await this.run(['rev-parse', '--verify', '--quiet', spec]).catch(onExit1(''))).trim()
      if (!oid) return null
      spec = oid
    }
    // close() 之后（比如 rev-parse 期间重新检测了）不再拉起新进程，否则会泄漏
    if (this.closed) throw new GitError('unknown', -1, 'git closed')
    if (!this.cat || this.cat.dead) this.cat = new CatFile(this.bin, this.cwd, this.env)
    return this.cat.read(spec)
  }

  close() {
    this.closed = true
    this.cat?.close()
    this.cat = null
  }
}

// 下载（smudge / pull）"成功"后结果仍是指针：多半是 lfs.fetchinclude / fetchexclude 之类的配置让它跳过了，按 lfsFilter 报出来，
// 不当作成功静默返回
function stillPointer(b: Buffer, cmd: string, rel: string) {
  if (parseLfsPointer(b)) throw new GitError('lfsFilter', 0, `${cmd} finished but ${rel} is still an LFS pointer (check lfs.fetchinclude / lfs.fetchexclude and the LFS remote)`)
}

// 常驻 `git cat-file --batch`：按行协议，2.38 起都可用；请求里不能有换行（由 readBlob 处理）
class CatFile {
  private proc: ChildProcessWithoutNullStreams
  private buf = Buffer.alloc(0)
  private queue: { resolve: (b: Buffer | null) => void; reject: (e: Error) => void }[] = []
  private stderr = ''
  dead = false

  constructor(bin: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(bin, ['cat-file', '--batch'], { cwd, env, windowsHide: true })
    this.proc.stdout.on('data', (d: Buffer) => {
      // shortcut: 每块都 concat，大 blob 分块多时是 O(n²)；读大附件变慢时改成分块列表
      this.buf = Buffer.concat([this.buf, d])
      this.drain()
    })
    this.proc.stderr.on('data', (d) => (this.stderr += d))
    const fail = (e?: Error) => this.fail(e)
    // 用 close 而不是 exit：exit 时 stdout 可能还没读完，会误伤已经返回的响应
    this.proc.on('close', () => fail())
    this.proc.on('error', fail)
    // 子进程退出后再写 stdin 会 EPIPE，流上的 error 没有监听会让主进程崩溃
    for (const s of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) s.on('error', fail)
  }

  // 统一拒绝所有待处理请求，之后 readBlob 会重新拉起进程
  private fail(e?: Error | null) {
    this.dead = true
    const msg = this.stderr || e?.message || 'cat-file exited'
    for (const q of this.queue.splice(0)) q.reject(new GitError(classifyGitError(this.stderr), -1, msg))
  }

  read(spec: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new GitError('unknown', -1, 'cat-file exited'))
      this.queue.push({ resolve, reject })
      // 流已销毁时写入不触发 error 事件，只在回调里报 ERR_STREAM_DESTROYED
      this.proc.stdin.write(`${spec}\n`, (e) => e && this.fail(e))
    })
  }

  // 响应：`<oid> <type> <size> LF <内容> LF`，或 `<spec> missing LF` / `<spec> ambiguous LF`
  private drain() {
    while (this.queue.length) {
      const lf = this.buf.indexOf(10)
      if (lf < 0) return
      const header = this.buf.subarray(0, lf).toString()
      if (/ (missing|ambiguous)$/.test(header)) {
        this.buf = this.buf.subarray(lf + 1)
        this.queue.shift()!.resolve(null)
        continue
      }
      const size = Number(header.split(' ')[2])
      if (this.buf.length < lf + 1 + size + 1) return
      const content = Buffer.from(this.buf.subarray(lf + 1, lf + 1 + size))
      this.buf = this.buf.subarray(lf + 2 + size)
      this.queue.shift()!.resolve(content)
    }
  }

  close() {
    this.proc.stdin.end()
    this.proc.kill()
  }
}
