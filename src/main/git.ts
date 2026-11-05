// git 服务（ADR 0004）：只用系统 git CLI 子进程；查找、porcelain 解析、错误分类、常驻 cat-file
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { GitErrorKind } from '../shared/api'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecResult>

// 启动失败（ENOENT）、超时都记为 code -1，不抛异常
export const exec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, maxBuffer: 1 << 28, windowsHide: true }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : -1
      resolve({ code, stdout, stderr })
    })
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
  ['lfsMissing', /git-lfs: (command )?not found|'git-lfs' was not found|cannot run git-lfs/],
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

// `config --get`、`rev-parse --verify --quiet` 查不到时退出码为 1，记为 fallback；其它失败（配置损坏、权限等）照常抛出
const onExit1 =
  <T>(fallback: T) =>
  (e: unknown): T => {
    if (e instanceof GitError && e.code === 1) return fallback
    throw e
  }

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
    // GIT_TERMINAL_PROMPT=0：没有凭据时直接失败，不卡在等待终端输入
    this.env = { ...env, PATH, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
  }

  async run(args: string[]): Promise<string> {
    const r = await this.run_(this.bin, args, { cwd: this.cwd, env: this.env })
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

  async status(): Promise<StatusEntry[]> {
    // --no-optional-locks：不顺手刷新 .git/index，否则会触发 watcher 再推一次状态
    return parseStatus(await this.run(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all']))
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
