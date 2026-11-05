import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { i18next, i18nOptions } from '../shared/i18n'
import { commands } from '../shared/commands'
import { indexMethods, type GitDone, type GitOpResult, type GitState, type OrphanAttachment, type ItemMenuAction, type VaultConfig, type VaultInfo } from '../shared/api'
import { tokens } from '../shared/tokens'
import { exec, findGit, Git, GitError, StagedOutsideError, type GitDetectionResult } from './git'
import { attachmentTarget, checkOrphans, isAttachmentPath, removeOrphans, trackedOf } from './orphans'
import { commitRename, planRename } from './rename'
import { attachmentName, isHidden, realInVault, realParentInVault, resolveInVault, saveAttachment, scanEntries, toPosix, uniqueNoteName, writeTarget } from './vault'

i18next.init(i18nOptions)
const t = i18next.t

let win: BrowserWindow | null = null
let root: string | null = null
let watcher: FSWatcher | null = null
let indexer: UtilityProcess | null = null
let callSeq = 0
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

const recentFile = () => path.join(app.getPath('userData'), 'recent.json')

async function recentVaults(): Promise<string[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'))
  } catch {
    return []
  }
}

// 切库是一次交接，由渲染进程串行驱动：prepare（只读新库，旧库照常运行）→ 渲染进程把旧库的输入全部落盘 →
// commit（一次性切换）。任何一步失败，旧库都完好无损
async function prepareVault(dir: string): Promise<VaultInfo> {
  if (!existsSync(dir)) throw new Error(t('vaultMissing', { path: dir }))
  const [entries, config] = await Promise.all([scanEntries(dir), readConfig(dir)])
  return { root: dir, name: path.basename(dir), entries, config }
}

async function commitVault(dir: string): Promise<void> {
  if (!existsSync(dir)) throw new Error(t('vaultMissing', { path: dir }))
  const recent = [dir, ...(await recentVaults()).filter((r) => r !== dir)].slice(0, 10)
  await fs.writeFile(recentFile(), JSON.stringify(recent))
  // 先建好新库的 watcher 和索引进程；建不起来（比如 B 刚被删）就抛错，旧库的服务和 root 原样保留
  const w = watchVault(dir)
  let proc: UtilityProcess
  try {
    proc = forkIndexer(dir)
  } catch (e) {
    w.close()
    throw e
  }
  // 以下同步完成：释放旧库的服务、换上新库的、切 root
  watcher?.close()
  watcher = w
  useIndexer(proc, dir)
  root = dir
  gitGen++ // 进行中的 git 状态查询作废
  // watcher 建好后补扫一次，补上 prepare 之后的改动。这条推送排在 commit 的回复之后，
  // 渲染进程先用 prepare 的快照，再被它覆盖
  scanEntries(dir).then(
    (entries) => root === dir && win?.webContents.send('vault:changed', { root: dir, entries, changed: [] }),
    (e) => console.error('[vault] rescan failed', e),
  )
}

const configFile = (dir: string) => path.join(dir, '.synote', 'config.json')

// .synote/config.json 入 git：打开库时只读，第一次写配置时才创建（只是打开库不弄脏仓库）；
// 读不出来时按空配置处理，不覆盖用户的文件
async function readConfig(dir: string): Promise<VaultConfig> {
  try {
    return JSON.parse(await fs.readFile(configFile(dir), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[vault] cannot read config', e)
    return {}
  }
}

function watchVault(dir: string): FSWatcher {
  const changed = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  // shortcut: 每批外部改动都全量重扫文件树，10k 库约百毫秒；等 S6 索引服务的 stat 对账就绪后改为增量
  return watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    pushGitState() // .git 里的 HEAD、index、refs 变化也算，外部 git 操作能及时反映
    const rel = toPosix(filename.toString())
    if (isHidden(rel)) return
    changed.add(rel)
    clearTimeout(timer)
    timer = setTimeout(fire, 150)
  })
  async function fire() {
    if (root !== dir) return
    // 重命名进行中（或扫描跨过了一次重命名）：改动攒着，等结束后再推，渲染进程先按 rename 的回执改好标签路径
    if (moving) return void (timer = setTimeout(fire, 150))
    const gen = moves
    const list = [...changed]
    const entries = await scanEntries(dir)
    if (root !== dir) return // 扫描期间切了库：迟到的结果不发
    if (moving || gen !== moves) return void (timer = setTimeout(fire, 150))
    for (const p of list) changed.delete(p)
    win?.webContents.send('vault:changed', { root: dir, entries, changed: list })
  }
}

function forkIndexer(dir: string): UtilityProcess {
  const proc = utilityProcess.fork(path.join(__dirname, 'index-worker.js'), [], { serviceName: 'synote-index' })
  proc.on('message', (m: { id?: number; event?: string; paths?: string[]; result?: unknown; error?: string }) => {
    if (m.event === 'changed') {
      if (root === dir) pruneFresh(dir).catch((e) => console.error('[orphans] prune failed', e))
      return win?.webContents.send('index:changed', { root: dir, paths: m.paths })
    }
    const c = calls.get(m.id!)
    calls.delete(m.id!)
    if (m.error) c?.reject(new Error(m.error))
    else c?.resolve(m.result)
  })
  proc.on('exit', () => indexer === proc && (indexer = null))
  return proc
}

// 每个笔记库一个索引库，放在应用数据目录（缓存，不入库）
function useIndexer(proc: UtilityProcess, dir: string) {
  indexer?.kill()
  for (const c of calls.values()) c.reject(new Error('index restarted'))
  calls.clear()
  indexer = proc
  const dbDir = path.join(app.getPath('userData'), 'index')
  const dbFile = path.join(dbDir, `${createHash('sha1').update(dir).digest('hex')}.db`)
  fs.mkdir(dbDir, { recursive: true })
    .then(() => indexer === proc && callIndex('open', dbFile, dir)) // 等待期间已换库：不能把旧库发给新进程
    .catch((e) => console.error('[index] open failed', e))
}

function callIndex(method: string, ...args: unknown[]): Promise<unknown> {
  if (!indexer) return Promise.reject(new Error('index not running'))
  const id = ++callSeq
  indexer.postMessage({ id, method, args })
  return new Promise((resolve, reject) => calls.set(id, { resolve, reject }))
}

// 设置项只有 git 路径，和 recent.json 一样放在应用数据目录
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
// 文件损坏或字段类型不对都当作没有设置，否则『重新检测』『手动指定』都会一直失败
const readSettings = (): Promise<{ gitPath?: string }> =>
  fs
    .readFile(settingsFile(), 'utf8')
    .then((s) => {
      const v = JSON.parse(s)
      return typeof v?.gitPath === 'string' ? { gitPath: v.gitPath } : {}
    })
    .catch(() => ({}))

let found: Promise<GitDetectionResult> | null = null
let git: Git | null = null
// 重新检测或切换笔记库时加一，查询途中代次变了说明结果已过期
let gitGen = 0

function detectGit() {
  gitGen++
  git?.close()
  git = null
  found = readSettings().then((st) =>
    findGit({
      setting: st.gitPath,
      platform: process.platform,
      PATH: process.env.PATH ?? '',
      shell: process.env.SHELL,
      exec,
      // PATH 里有一项是普通文件时 statSync 会抛 ENOTDIR，不能让整个检测 reject
      isFile: (p) => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      },
    }),
  )
}

// 当前库的 git 实例，没有可用 git 时为检测结果。过期（期间重新检测或切换了笔记库）的结果都丢弃，按最新的重取
async function repoGit(): Promise<{ g: Git; version: string; gen: number } | Exclude<GitDetectionResult, { status: 'ok' }>> {
  if (!found) detectGit()
  const gen = gitGen
  const f = await found!
  if (gen !== gitGen) return repoGit()
  if (f.status !== 'ok') return f
  if (!root) throw new Error('no vault open')
  // 代次已校验，这里到创建实例之间没有 await；检测结果或笔记库不同就换实例
  if (git?.cwd !== root || git.bin !== f.bin || git.PATH !== f.PATH) {
    git?.close()
    git = new Git(f.bin, f.PATH, root, () => void callIndex('reconcile').catch((e) => console.error('[index] reconcile failed', e)))
  }
  return { g: git, version: f.version, gen }
}

// 过期的结果和异常都丢弃，按最新的检测结果和笔记库重查
async function gitState(): Promise<GitState> {
  const r = await repoGit()
  if (!('g' in r)) return r
  let s: GitState
  try {
    s = await queryGit(r.g, r.version)
  } catch (e) {
    if (r.gen === gitGen) throw e
    return gitState()
  }
  return r.gen === gitGen ? s : gitState()
}

// 只用传入的实例，期间全局的 git 被替换或置空也不受影响
async function queryGit(g: Git, version: string): Promise<GitState> {
  if (!(await g.isRepo())) return { status: 'notRepo', version }
  const [identity, st, lfs] = await Promise.all([g.identity(), g.status(), g.lfsInstalled()])
  return { status: 'ready', version, ...identity, ...st, lfs }
}

// 状态由主进程推送（ADR 0005）：文件改动后防抖重查，渲染进程的 git store 据此更新
let gitTimer: NodeJS.Timeout | undefined
function pushGitState() {
  clearTimeout(gitTimer)
  // 推送没有调用方可以报错，记日志；渲染进程下次 invoke 时会拿到同样的错误
  gitTimer = setTimeout(() => gitState().then((s) => win?.webContents.send('git:changed', { root, state: s }), (e) => console.error('[git] push state failed', e)), 300)
}

// 渲染进程的读写都带上它所在的笔记库：和当前库不一致（期间切过库）就拒绝并报错，绝不落到别的库。
// 在第一个 await 之前调用，目标路径就此定下，之后再切库也不影响
function checkVault(vault: string): string {
  if (!root) throw new Error('no vault open')
  if (vault !== root) throw new Error(t('vaultSwitched', { vault }))
  return root
}

// 只选目录；打开走和最近列表同一条交接路径
ipcMain.handle('vault:pick', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('vault:prepare', (_e, dir: string) => prepareVault(dir))
ipcMain.handle('vault:commit', (_e, dir: string) => commitVault(dir))
ipcMain.handle('vault:recent', () => recentVaults())
ipcMain.handle('vault:writeConfig', async (_e, vault: string, config: VaultConfig) => {
  const file = configFile(checkVault(vault))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
})
// 读取跟随符号链接，所以按真实路径校验（实时预览会自动读图片，不能让一个指向库外的链接读出库外文件）
ipcMain.handle('file:read', async (_e, vault: string, rel: string) => fs.readFile(await realInVault(checkVault(vault), rel), 'utf8'))
// 实时预览查附件链接是否存在（S10）：一批路径一次查，同样按真实路径校验，越出笔记库的按不存在
ipcMain.handle('file:exists', async (_e, vault: string, rels: string[]) => {
  const r = checkVault(vault)
  return Promise.all(rels.map((p) => realInVault(r, p).then(() => true, () => false)))
})
ipcMain.handle('file:readBytes', async (_e, vault: string, rel: string) => fs.readFile(await realInVault(checkVault(vault), rel)))
// diff / 历史用的 git：没有可用 git、不是仓库时报错（不像 vaultRepo 那样当作非 git 目录）
async function diffGit<T>(r: string, f: (g: Git) => Promise<T>): Promise<T> {
  const res = await repoGit()
  if (!('g' in res)) throw new Error(t('gitUnavailable'))
  if (res.g.cwd !== r) throw new Error(t('vaultSwitched', { vault: r })) // 等 git 检测期间切了库
  try {
    return await f(res.g)
  } catch (e) {
    throw e instanceof GitError && e.kind === 'notRepo' ? new Error(t('gitNotRepo')) : e
  }
}
// 渲染进程传来的提交只认完整的 oid（或 HEAD），不会被当成选项或任意 revision 表达式
const checkRev = (rev: unknown, head = false): string => {
  if (typeof rev !== 'string' || !(/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(rev) || (head && rev === 'HEAD'))) throw new Error(`invalid revision: ${rev}`)
  return rev
}
// 工作区对比的 HEAD 一侧（S14）、历史对比的旧版本（S15）：经常驻 cat-file 读，那个版本里没有这个文件时为 null。
// `rev:./` 按 git 的工作目录（即笔记库）解析，笔记库是仓库子目录时也对。只读 git 对象、不碰文件系统，
// 所以历史里改名前位于库外（../ 开头，来自 git:log）的路径也放行
ipcMain.handle('git:readRev', (_e, vault: string, rev: string, rel: string) => {
  const r = checkVault(vault)
  checkRev(rev, true)
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new Error(`invalid path: ${rel}`)
  return diffGit(r, (g) => g.readBlob(`${rev}:./${rel}`))
})
// 历史栏（S15）：当前笔记的 git log --follow
ipcMain.handle('git:log', (_e, vault: string, rel: string) => {
  const r = checkVault(vault)
  resolveInVault(r, rel)
  return diffGit(r, (g) => g.fileLog(rel))
})
// 从历史恢复缺失的附件（S15，#9 决定 7）：只管 attachments/ 下的，路径必须是规范写法（不含 . / ..、反斜杠、盘符）
const checkAttachment = (rel: unknown): string => {
  if (!isAttachmentPath(rel)) throw new Error(`not an attachment: ${rel}`)
  return rel
}
ipcMain.handle('git:restoreSource', (_e, vault: string, rel: string) => {
  const r = checkVault(vault)
  checkAttachment(rel)
  return diffGit(r, (g) => g.restoreSource(rel))
})
// 写回前再校验：真实父目录在库的真实 attachments/ 内（与孤儿删除同一个 attachmentTarget）、目标仍不存在
// （不覆盖任何东西，含悬空链接）、该提交里确实是普通文件。和附件写入、孤儿删除串在同一条链上
ipcMain.handle('git:restore', (_e, vault: string, rel: string, hash: string) => {
  const r = checkVault(vault)
  checkAttachment(rel)
  checkRev(hash)
  const job = attaching.then(() =>
    diffGit(r, async (g) => {
      await fs.mkdir(await realParentInVault(r, 'attachments'), { recursive: true })
      const abs = await attachmentTarget(r, rel)
      if (!abs) throw new Error(`not an attachment: ${rel}`)
      if (await fs.lstat(abs).then(() => true, () => false)) throw new Error(t('restoreExists', { path: rel }))
      if (!(await g.isFileAt(hash, rel))) throw new Error(t('restoreNotFound', { path: rel }))
      await g.restore(hash, rel)
    }),
  )
  attaching = job.catch(() => {})
  return job
})
// 孤儿删除的互斥边界（codex #49）：从最终对账复核到最后一个文件删完，应用内的正文写入（保存、新建、重命名）在边界外排队，
// 删除看到的引用快照在删完之前不会被应用内写入改变。只推迟落盘，不丢内容（渲染进程 await 保存，dirty 保持）。
// 外部进程的写入不在范围内
let deleting: Promise<void> | null = null
const writing = new Set<Promise<unknown>>() // 已过边界、还没落盘的写入，进入边界前要等它们
async function noteWrite<T>(f: () => Promise<T>): Promise<T> {
  while (deleting) await deleting
  const p = f() // 同步登记：检查边界和登记之间没有 await，删除一侧不会漏等
  writing.add(p)
  try {
    return await p
  } finally {
    writing.delete(p)
  }
}

// 写入、新建、回收同样按真实路径校验：父目录（或被跟随的链接）被换成指向库外时拒绝
ipcMain.handle('file:write', async (_e, vault: string, rel: string, content: string) => {
  const r = checkVault(vault)
  await noteWrite(async () => fs.writeFile(await writeTarget(r, rel), content))
  // 不等 watcher 防抖，写完立即对账：删掉或撤销最后一处引用后，孤儿状态 1 s 内更新（S11）
  callIndex('reconcile').catch((e) => console.error('[index] reconcile failed', e))
})
ipcMain.handle('file:createNote', async (_e, vault: string, dir: string) => {
  const r = checkVault(vault)
  const entries = await scanEntries(r)
  const rel = uniqueNoteName(new Set(entries.map((x) => x.path)), dir, t('untitled'))
  await noteWrite(async () => fs.writeFile(await realParentInVault(r, rel), '', { flag: 'wx' })) // wx：不覆盖已有文件，也不跟随末级链接
  return rel
})
// 粘贴 / 拖入的附件（S10）：串成一条链，并发的两次粘贴不会都没查到对方而写出两份同样的文件
let attaching: Promise<unknown> = Promise.resolve()
// 在途附件（S11）：本会话粘贴 / 拖入（含复用已有文件）、还没被任何已落盘笔记引用的，按库记。
// 清理时不列、不删：链接可能还没插进去或还没自动保存。三种情况移出：索引发现它被引用；渲染进程报告插入任务结束且
// 笔记已落盘（file:attachmentSettled，插完又撤销的这时就能清理）；超时兜底。值为保护到期的时间
// shortcut: 兜底固定 10 分钟，防渲染进程崩溃或漏报时永远不释放；有超长的插入（如超大文件）时再按大小放宽
const FRESH_MS = 10 * 60_000
const fresh = new Map<string, Map<string, number>>()
const isFresh = (dir: string, p: string) => (fresh.get(dir)?.get(p) ?? 0) > Date.now()
async function pruneFresh(dir: string): Promise<void> {
  const s = fresh.get(dir)
  if (!s?.size) return
  for (const [p, until] of s) if (until <= Date.now()) s.delete(p)
  for (const p of (await callIndex('referenced', [...s.keys()])) as string[]) s.delete(p)
}
// 解除保护也排进 attaching 链：不会插进一次孤儿删除的检查中间；解除前先等一次对账，
// 之后的删除查 referenced / mentioned 时一定能看到刚落盘的正文。对账失败就不解除（到期兜底）
ipcMain.handle('file:attachmentSettled', (_e, vault: string, paths: string[]) => {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Error('invalid paths')
  const job = attaching.then(async () => {
    await callIndex('reconcile')
    for (const p of paths) fresh.get(vault)?.delete(p) // 只动内存里的保护表，期间切了库也无妨
  })
  attaching = job.catch(() => {})
  return job
})
ipcMain.handle('file:saveAttachment', (_e, vault: string, name: string | null, bytes: Uint8Array) => {
  const r = checkVault(vault)
  if (!(bytes instanceof Uint8Array) || (name !== null && typeof name !== 'string')) throw new Error('invalid attachment')
  const job = attaching.then(async () => {
    const rel = await saveAttachment(r, attachmentName(name, new Date()), bytes)
    if (!fresh.has(r)) fresh.set(r, new Map())
    fresh.get(r)!.set(rel, Date.now() + FRESH_MS)
    return { path: rel, warn: await sizeWarning(r, rel, bytes.length) }
  })
  attaching = job.catch(() => {})
  return job
})

// 孤儿附件（S11）以落盘内容为准：先对账一次，补上 watcher 防抖里还没进索引的改动，再取孤儿列表
async function currentOrphans(): Promise<string[]> {
  await callIndex('reconcile')
  return (await callIndex('orphans')) as string[]
}

// 当前库是 git 仓库时返回它的 git；没有可用的 git、不是仓库都按非 git 目录处理（返回 null）
async function vaultRepo(r: string): Promise<Git | null> {
  const res = await repoGit()
  if (!('g' in res)) return null
  if (res.g.cwd !== r) throw new Error(t('vaultSwitched', { vault: r })) // 等 git 检测期间切了库
  return (await res.g.isRepo()) ? res.g : null
}

// "将删除的孤儿附件"清单：清理命令的确认框和 S13 的 commit 面板分组都用它
ipcMain.handle('orphans:list', async (_e, vault: string): Promise<OrphanAttachment[]> => {
  const r = checkVault(vault)
  const all = await currentOrphans()
  await pruneFresh(r) // 对账之后再修剪：刚保存的引用已进索引
  const list = all.filter((p) => !isFresh(r, p))
  const tracked = await trackedOf(await vaultRepo(r), list)
  return list.map((p) => ({ path: p, tracked: tracked.has(p) }))
})
// 删除用户确认过的孤儿附件：以删除时刻的索引复核（期间加了引用的不删），路径再按真实路径校验；
// 文件名仍出现在某篇笔记正文里的（第二道防线，防引用解析漏判）、在途附件也不删，放进 kept 告诉用户。
// 和附件写入串在同一条链上：粘贴复用某个孤儿文件时，不会在写入途中被删
ipcMain.handle('orphans:delete', (_e, vault: string, paths: string[]) => {
  const r = checkVault(vault)
  if (!isStrings(paths)) throw new Error('invalid paths')
  return deleteOrphans(r, paths)
})
const isStrings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every((p) => typeof p === 'string')
// 清理命令和 git 面板的提交（S13）共用
function deleteOrphans(r: string, paths: string[], progress?: () => void) {
  const job = attaching.then(async () => {
    const checked = await checkOrphans(r, paths, new Set(await currentOrphans()))
    await pruneFresh(r)
    const pending = checked.map(([p]) => p).filter((p) => isFresh(r, p))
    const mentioned = (await callIndex('mentioned', checked.map(([p]) => p).filter((p) => !pending.includes(p)))) as string[]
    const kept = [...pending.map((path) => ({ path, reason: 'pending' as const })), ...mentioned.map((path) => ({ path, reason: 'mentioned' as const }))]
    const candidates = checked.filter(([p]) => !kept.some((k) => k.path === p))
    // 进入互斥边界：先等已在途的正文写入落盘，再对账复核，被引用或又成了在途的静默跳过；删完才放行新的写入
    let open!: () => void
    deleting = new Promise((res) => (open = res))
    try {
      await Promise.allSettled([...writing])
      await callIndex('reconcile')
      const late = new Set((await callIndex('referenced', candidates.map(([p]) => p))) as string[])
      const targets = candidates.filter(([p]) => !late.has(p) && !isFresh(r, p))
      return { deleted: await removeOrphans(targets, await vaultRepo(r), (p) => shell.trashItem(p), progress), kept }
    } finally {
      deleting = null
      open()
      callIndex('reconcile').catch((e) => console.error('[index] reconcile failed', e))
    }
  })
  attaching = job.catch(() => {})
  return job
}

// git 面板的写操作（S13）：失败按分类返回（经 IPC 抛出的异常只剩一段文本，渲染进程没法给出引导），done 记下已完成的步骤。
// 结束后立即推一次状态，不等 watcher
async function gitOp(r: string, f: (g: Git, done: GitDone) => Promise<unknown>): Promise<GitOpResult> {
  const done: GitDone = {}
  try {
    await diffGit(r, (g) => f(g, done))
    return { ok: true, done }
  } catch (e) {
    const raw = e instanceof GitError ? [e.stderr, e.stdout].map((x) => x.trim()).filter(Boolean).join('\n') : String(e)
    const outside = e instanceof StagedOutsideError ? { top: e.top, paths: e.paths } : undefined
    return { ok: false, kind: e instanceof GitError ? e.kind : 'unknown', raw, done, ...(outside && { outside }) }
  } finally {
    pushGitState()
  }
}
// 渲染进程传来的路径：笔记库内的规范相对路径（git 面板列出的都是），按字面交给 git
const checkPaths = (paths: unknown): string[] => {
  if (!isStrings(paths) || !paths.length || !paths.every(relOk)) throw new Error('invalid paths')
  return paths
}
ipcMain.handle('git:stage', (_e, vault: string, paths: string[] | null) => {
  const r = checkVault(vault)
  const ps = paths === null ? ['.'] : checkPaths(paths)
  return gitOp(r, (g) => g.stage(ps))
})
ipcMain.handle('git:unstage', (_e, vault: string, paths: string[]) => {
  const r = checkVault(vault)
  const ps = checkPaths(paths)
  return gitOp(r, (g) => g.unstage(ps))
})
// 提交：先查身份、查暂存区里有没有笔记库之外的文件（面板看不到，不替用户提交），有一项不满足就什么都不做 → 删勾选的孤儿附件（git rm 的进入这次提交）→ 全部暂存（all 时）→ 提交。
// 未保存的正文由渲染进程在调用前落盘
ipcMain.handle('git:commit', (_e, vault: string, message: string, all: boolean, orphans: string[]) => {
  const r = checkVault(vault)
  if (typeof message !== 'string' || !message.trim() || typeof all !== 'boolean' || !isStrings(orphans)) throw new Error('invalid commit')
  return gitOp(r, async (g, done) => {
    const id = await g.identity()
    if (!id.name || !id.email) throw new GitError('noIdentity', -1, '')
    const outside = await g.stagedOutside()
    if (outside.length) throw new StagedOutsideError(await g.toplevel(), outside)
    if (orphans.length) {
      // 逐个记进度：中途失败时卡片如实报出已删了几个
      done.deleted = 0
      const res = await deleteOrphans(r, orphans, () => done.deleted!++)
      done.kept = res.kept
    }
    if (all) {
      await g.stage(['.'])
      done.staged = true
    }
    await g.commit(message)
  })
})
ipcMain.handle('git:push', (_e, vault: string) => gitOp(checkVault(vault), async (g) => g.push(!!(await g.status()).upstream)))
ipcMain.handle('git:pull', (_e, vault: string) => gitOp(checkVault(vault), (g) => g.pull()))
ipcMain.handle('git:repoLog', (_e, vault: string) => {
  const r = checkVault(vault)
  return diffGit(r, (g) => g.log())
})

// 大文件提示（#13），只提示不阻止：> 50 MiB GitHub 会警告，> 100 MiB 会拒绝 push；按 .gitattributes 走 LFS 的不提示。
// 没有可用 git、不是仓库时 check-attr 失败，按不走 LFS 处理
async function sizeWarning(r: string, rel: string, size: number): Promise<'large' | 'huge' | null> {
  if (size <= 50 << 20) return null
  const res = await repoGit().catch(() => null)
  const lfs = res && 'g' in res && res.g.cwd === r && (await res.g.lfsPaths([rel]).catch(() => [])).length > 0
  return lfs ? null : size > 100 << 20 ? 'huge' : 'large'
}
ipcMain.handle('index:call', (_e, vault: string, method: string, ...args: unknown[]) => {
  if (!(indexMethods as readonly string[]).includes(method)) throw new Error(`unknown index method: ${method}`)
  checkVault(vault) // 索引进程只服务当前库，查别的库就拒绝
  return callIndex(method, ...args)
})
ipcMain.handle('git:state', () => gitState())
ipcMain.handle('git:redetect', () => (detectGit(), gitState()))
ipcMain.handle('git:choose', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'showHiddenFiles'] })
  if (r.canceled) return null
  await fs.writeFile(settingsFile(), JSON.stringify({ ...(await readSettings()), gitPath: r.filePaths[0] }))
  detectGit()
  return gitState()
})
// 重命名 / 移动（S9）：串成一条链，期间 watcher 的推送暂停
let renaming: Promise<unknown> = Promise.resolve()
let moving = false
let moves = 0
const relOk = (rel: unknown): rel is string =>
  typeof rel === 'string' && rel.split('/').every((s) => s && s !== '.' && s !== '..') && !(process.platform === 'win32' && /[\\:*?"<>|]/.test(rel))

// 校验一次移动，返回真实路径：两边都在库内、不是隐藏路径（attachments/ 不在 MVP 范围），不移进自身；
// 源存在，目标不存在（只改大小写时目标就是源本身），笔记仍以 .md 结尾
async function checkMove(r: string, from: unknown, to: unknown): Promise<{ src: string; dst: string; from: string; to: string }> {
  if (!relOk(from) || !relOk(to) || isHidden(from) || isHidden(to) || to === from || to.startsWith(`${from}/`)) throw new Error(t('renameInvalid', { path: String(to) }))
  const [src, dst] = await Promise.all([realParentInVault(r, from), realParentInVault(r, to)])
  const st = await fs.lstat(src)
  if (!st.isDirectory() && from.endsWith('.md') !== to.endsWith('.md')) throw new Error(t('renameKeepMd'))
  const there = await fs.lstat(dst).catch(() => null)
  if (there && !(there.ino === st.ino && there.dev === st.dev)) throw new Error(t('renameExists', { path: to }))
  return { src, dst, from, to }
}
ipcMain.handle('file:planRename', async (_e, vault: string, from: string, to: string) => {
  const r = checkVault(vault)
  await checkMove(r, from, to)
  const { plans, skipped } = await planRename(r, from, to)
  return { files: plans.map((p) => p.path), skipped }
})
ipcMain.handle('file:rename', (_e, vault: string, from: string, to: string, files: string[]) => {
  const r = checkVault(vault)
  if (!Array.isArray(files)) throw new Error('invalid files')
  // 改写笔记、移动文件同样在孤儿删除的互斥边界外排队（codex #49）
  const job = renaming.then(() => noteWrite(async () => {
    moving = true
    moves++
    try {
      const m = await checkMove(r, from, to)
      const { plans } = await planRename(r, m.from, m.to)
      if (plans.map((p) => p.path).join('\0') !== files.join('\0')) throw new Error(t('renameChanged'))
      // 仓库里有跟踪的就 git mv 保留历史，否则（含非 git 目录）直接 rename
      const repo = await vaultRepo(r)
      const git = repo && (await repo.tracked([m.from])).length ? repo : null
      await commitRename(plans, async () => void (git ? await git.mv(m.from, m.to) : await fs.rename(m.src, m.dst)))
      return plans.map((p) => ({ path: p.path, before: p.before, edits: p.edits }))
    } finally {
      moving = false
      callIndex('reconcile').catch((e) => console.error('[index] reconcile failed', e))
    }
  }))
  renaming = job.catch(() => {})
  return job
})
ipcMain.handle('file:trash', async (_e, vault: string, rel: string) => shell.trashItem(await realParentInVault(checkVault(vault), rel)))
ipcMain.handle(
  'menu:item',
  (_e, _rel: string, dir: boolean) =>
    new Promise<ItemMenuAction>((resolve) => {
      let picked: ItemMenuAction = null
      const ids: NonNullable<ItemMenuAction>[] = dir ? ['newNote', 'rename', 'trash'] : ['rename', 'trash']
      const items = ids.map((id) => ({ label: t(commands[id].title), click: () => (picked = id) }))
      Menu.buildFromTemplate(items).popup({ window: win!, callback: () => resolve(picked) })
    }),
)
ipcMain.once('app:ready', () => {
  // 首屏耗时：从进程启动到渲染进程画出文件树
  const ms = Math.round(performance.now())
  console.log(`[perf] first-screen ${ms}ms`)
  if (process.env.SYNOTE_PERF_EXIT) app.quit()
})

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: tokens.bg,
    title: t('appName'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  win.on('closed', () => (win = null))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// e2e / 性能测试用：指定 userData，避免污染真实的最近打开列表
if (process.env.SYNOTE_USER_DATA) app.setPath('userData', process.env.SYNOTE_USER_DATA)

app.whenReady().then(() => {
  detectGit() // 登录 shell 最多 3 s，启动时就开始查
  createWindow()
})
app.on('window-all-closed', () => app.quit())
