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

export type Found =
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
}): Promise<Found> {
  const win = o.platform === 'win32'
  const mac = o.platform === 'darwin'
  const which = (PATH: string) =>
    PATH.split(win ? ';' : ':')
      .filter(Boolean)
      .map((d) => path.join(d, win ? 'git.exe' : 'git'))
      .find(o.isFile)

  let loginPATH: string | undefined
  if (mac) {
    // 从 Finder / Dock 启动时 PATH 只有系统目录，用登录 shell 的 PATH 才能找到 Homebrew 的 git 和 git-lfs
    const r = await o.exec(o.shell || '/bin/zsh', ['-ilc', 'echo "SYNOTE_PATH=$PATH"'], { timeout: 3000 })
    loginPATH = r.code === 0 ? /SYNOTE_PATH=(.*)/.exec(r.stdout)?.[1] : undefined
  }
  // git 子进程也用这个 PATH，否则 git 能找到、git-lfs 却找不到（research/lfs 2.5）
  const PATH = loginPATH || o.PATH

  let clt: boolean | undefined
  let tooOld: Found | undefined
  for (const bin of [o.setting, loginPATH && which(loginPATH), which(o.PATH)]) {
    if (!bin) continue
    // /usr/bin/git 是 shim：没装 Command Line Tools 时一调用就弹安装框，先用 xcode-select -p 确认
    if (mac && bin === '/usr/bin/git' && !(clt ??= (await o.exec('/usr/bin/xcode-select', ['-p'])).code === 0)) continue
    const r = await o.exec(bin, ['--version'], { env: { ...process.env, PATH } })
    const v = r.code === 0 ? parseVersion(r.stdout) : null
    if (!v) continue
    const version = v.join('.')
    if (versionOk(v)) return { status: 'ok', bin, version, PATH }
    tooOld ??= { status: 'tooOld', bin, version }
  }
  return tooOld ?? { status: 'missing' }
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

const errorPatterns: [GitErrorKind, RegExp][] = [
  ['noIdentity', /Please tell me who you are|unable to auto-detect email address|empty ident name/i],
  [
    'noCredentials',
    /could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey|Host key verification failed/i,
  ],
  ['nonFastForward', /\[rejected\]|non-fast-forward|Updates were rejected|Not possible to fast-forward/i],
  ['conflict', /^CONFLICT \(|Automatic merge failed/m],
  ['lfsMissing', /git-lfs.*(command not found|not found|No such file)/i],
  ['network', /Could not resolve host|Connection (timed out|refused)|unable to access/i],
  ['notRepo', /not a git repository/i],
]

// 错误分类靠 stderr 文本，子进程统一 LC_ALL=C 保证是英文
export const classifyGitError = (stderr: string): GitErrorKind =>
  errorPatterns.find(([, re]) => re.test(stderr))?.[0] ?? 'unknown'

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(stderr.trim() || `git exited with ${code}`)
  }
}

export class Git {
  private readonly env: NodeJS.ProcessEnv
  private cat: CatFile | null = null

  constructor(
    readonly bin: string,
    PATH: string,
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
    if (r.code !== 0) throw new GitError(classifyGitError(r.stderr), r.code, r.stderr)
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

  async isRepo(): Promise<boolean> {
    return (await this.run(['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() === 'true'
  }

  async status(): Promise<StatusEntry[]> {
    return parseStatus(await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all']))
  }

  // 缺失时 git config 退出码为 1，记为 null
  async identity(): Promise<{ name: string | null; email: string | null }> {
    const get = (k: string) => this.run(['config', '--get', k]).then((s) => s.trim() || null, () => null)
    const [name, email] = await Promise.all([get('user.name'), get('user.email')])
    return { name, email }
  }

  // LFS 检测（research/lfs 2.2）：本机是否装了 git-lfs；哪些路径按 .gitattributes 应走 LFS
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

  // 读任意版本的 blob（如 `HEAD:a.md`），不存在时为 null；复用常驻的 cat-file --batch 进程
  readBlob(spec: string): Promise<Buffer | null> {
    if (!this.cat || this.cat.dead) this.cat = new CatFile(this.bin, this.cwd, this.env)
    return this.cat.read(spec)
  }

  close() {
    this.cat?.close()
    this.cat = null
  }
}

// 常驻 `git cat-file --batch -Z`（2.38+）：请求和响应都以 NUL 分隔，路径里有换行也不会错位
class CatFile {
  private proc: ChildProcessWithoutNullStreams
  private buf = Buffer.alloc(0)
  private queue: { resolve: (b: Buffer | null) => void; reject: (e: Error) => void }[] = []
  dead = false

  constructor(bin: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.proc = spawn(bin, ['cat-file', '--batch', '-Z'], { cwd, env, windowsHide: true })
    this.proc.stdout.on('data', (d: Buffer) => {
      // shortcut: 每块都 concat，大 blob 分块多时是 O(n²)；读大附件变慢时改成分块列表
      this.buf = Buffer.concat([this.buf, d])
      this.drain()
    })
    let stderr = ''
    this.proc.stderr.on('data', (d) => (stderr += d))
    const fail = () => {
      this.dead = true
      for (const q of this.queue.splice(0)) q.reject(new GitError(classifyGitError(stderr), -1, stderr || 'cat-file exited'))
    }
    this.proc.on('exit', fail)
    this.proc.on('error', fail)
  }

  read(spec: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.proc.stdin.write(`${spec}\0`)
    })
  }

  // 响应：`<oid> <type> <size> NUL <内容> NUL`，或 `<spec> missing NUL` / `<spec> ambiguous NUL`
  private drain() {
    while (this.queue.length) {
      const nul = this.buf.indexOf(0)
      if (nul < 0) return
      const header = this.buf.subarray(0, nul).toString()
      if (/ (missing|ambiguous)$/.test(header)) {
        this.buf = this.buf.subarray(nul + 1)
        this.queue.shift()!.resolve(null)
        continue
      }
      const size = Number(header.split(' ')[2])
      if (this.buf.length < nul + 1 + size + 1) return
      const content = Buffer.from(this.buf.subarray(nul + 1, nul + 1 + size))
      this.buf = this.buf.subarray(nul + 2 + size)
      this.queue.shift()!.resolve(content)
    }
  }

  close() {
    this.proc.stdin.end()
    this.proc.kill()
  }
}
