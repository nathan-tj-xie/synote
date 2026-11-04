import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { i18next, i18nOptions } from '../shared/i18n'
import { commands } from '../shared/commands'
import { indexMethods, type GitState, type ItemMenuAction, type VaultConfig, type VaultInfo } from '../shared/api'
import { tokens } from '../shared/tokens'
import { exec, findGit, Git, type GitDetectionResult } from './git'
import { isHidden, resolveInVault, scanEntries, toPosix, uniqueNoteName } from './vault'

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
  // 以下同步完成，中间没有 await：停掉旧库的 watcher 和索引、换上新库的、切 root
  startWatching(dir)
  startIndexer(dir)
  root = dir
  gitGen++ // 进行中的 git 状态查询作废
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

function startWatching(dir: string) {
  watcher?.close()
  const changed = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  // shortcut: 每批外部改动都全量重扫文件树，10k 库约百毫秒；等 S6 索引服务的 stat 对账就绪后改为增量
  watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    pushGitState() // .git 里的 HEAD、index、refs 变化也算，外部 git 操作能及时反映
    const rel = toPosix(filename.toString())
    if (isHidden(rel)) return
    changed.add(rel)
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (root !== dir) return
      const list = [...changed]
      changed.clear()
      const entries = await scanEntries(dir)
      if (root !== dir) return // 扫描期间切了库：迟到的结果不发
      win?.webContents.send('vault:changed', { root: dir, entries, changed: list })
    }, 150)
  })
}

// 每个笔记库一个索引库，放在应用数据目录（缓存，不入库）
function startIndexer(dir: string) {
  indexer?.kill()
  for (const c of calls.values()) c.reject(new Error('index restarted'))
  calls.clear()
  const proc = utilityProcess.fork(path.join(__dirname, 'index-worker.js'), [], { serviceName: 'synote-index' })
  indexer = proc
  proc.on('message', (m: { id?: number; event?: string; paths?: string[]; result?: unknown; error?: string }) => {
    if (m.event === 'changed') return win?.webContents.send('index:changed', { root: dir, paths: m.paths })
    const c = calls.get(m.id!)
    calls.delete(m.id!)
    if (m.error) c?.reject(new Error(m.error))
    else c?.resolve(m.result)
  })
  proc.on('exit', () => indexer === proc && (indexer = null))
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

// 过期（期间重新检测或切换了笔记库）的结果和异常都丢弃，按最新的检测结果和笔记库重查
async function gitState(): Promise<GitState> {
  if (!found) detectGit()
  const gen = gitGen
  const f = await found!
  if (gen !== gitGen) return gitState()
  if (f.status !== 'ok') return f
  if (!root) throw new Error('no vault open')
  // 代次已校验，这里到创建实例之间没有 await；检测结果或笔记库不同就换实例
  if (git?.cwd !== root || git.bin !== f.bin || git.PATH !== f.PATH) {
    git?.close()
    git = new Git(f.bin, f.PATH, root, () => void callIndex('reconcile').catch((e) => console.error('[index] reconcile failed', e)))
  }
  let s: GitState
  try {
    s = await queryGit(git, f.version)
  } catch (e) {
    if (gen === gitGen) throw e
    return gitState()
  }
  return gen === gitGen ? s : gitState()
}

// 只用传入的实例，期间全局的 git 被替换或置空也不受影响
async function queryGit(g: Git, version: string): Promise<GitState> {
  if (!(await g.isRepo())) return { status: 'notRepo', version }
  const [identity, changes, lfs] = await Promise.all([g.identity(), g.status(), g.lfsInstalled()])
  return { status: 'ready', version, ...identity, changes: changes.length, lfs }
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
const vaultPath = (vault: string, rel: string) => resolveInVault(checkVault(vault), rel)

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
ipcMain.handle('file:read', (_e, vault: string, rel: string) => fs.readFile(vaultPath(vault, rel), 'utf8'))
ipcMain.handle('file:write', (_e, vault: string, rel: string, content: string) => fs.writeFile(vaultPath(vault, rel), content))
ipcMain.handle('file:createNote', async (_e, vault: string, dir: string) => {
  const r = checkVault(vault)
  const entries = await scanEntries(r)
  const rel = uniqueNoteName(new Set(entries.map((x) => x.path)), dir, t('untitled'))
  await fs.writeFile(resolveInVault(r, rel), '', { flag: 'wx' }) // wx：不覆盖已有文件
  return rel
})
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
ipcMain.handle('file:trash', (_e, vault: string, rel: string) => shell.trashItem(vaultPath(vault, rel)))
ipcMain.handle(
  'menu:item',
  (_e, _rel: string, dir: boolean) =>
    new Promise<ItemMenuAction>((resolve) => {
      let picked: ItemMenuAction = null
      const ids: NonNullable<ItemMenuAction>[] = dir ? ['newNote', 'trash'] : ['trash']
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
