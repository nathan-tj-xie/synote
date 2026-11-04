import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { i18next, i18nOptions } from '../shared/i18n'
import { commands } from '../shared/commands'
import { indexMethods, type GitState, type ItemMenuAction, type VaultInfo } from '../shared/api'
import { exec, findGit, Git, type Found } from './git'
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

async function openVault(dir: string): Promise<VaultInfo> {
  if (!existsSync(dir)) throw new Error(t('vaultMissing', { path: dir }))
  root = dir
  const entries = await scanEntries(dir)
  const recent = [dir, ...(await recentVaults()).filter((r) => r !== dir)].slice(0, 10)
  await fs.writeFile(recentFile(), JSON.stringify(recent))
  startWatching(dir)
  startIndexer(dir)
  return { root: dir, name: path.basename(dir), entries }
}

function startWatching(dir: string) {
  watcher?.close()
  const changed = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  // shortcut: 每批外部改动都全量重扫文件树，10k 库约百毫秒；等 S6 索引服务的 stat 对账就绪后改为增量
  watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const rel = toPosix(filename.toString())
    if (isHidden(rel)) return
    changed.add(rel)
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (root !== dir) return
      const list = [...changed]
      changed.clear()
      win?.webContents.send('vault:changed', { entries: await scanEntries(dir), changed: list })
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
    if (m.event === 'changed') return win?.webContents.send('index:changed', m.paths)
    const c = calls.get(m.id!)
    calls.delete(m.id!)
    if (m.error) c?.reject(new Error(m.error))
    else c?.resolve(m.result)
  })
  proc.on('exit', () => indexer === proc && (indexer = null))
  const dbDir = path.join(app.getPath('userData'), 'index')
  const dbFile = path.join(dbDir, `${createHash('sha1').update(dir).digest('hex')}.db`)
  fs.mkdir(dbDir, { recursive: true })
    .then(() => callIndex('open', dbFile, dir))
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
const readSettings = (): Promise<{ gitPath?: string }> =>
  fs.readFile(settingsFile(), 'utf8').then(JSON.parse, () => ({}))

let found: Promise<Found> | null = null
let git: Git | null = null

function detectGit() {
  git?.close()
  git = null
  found = readSettings().then((st) =>
    findGit({
      setting: st.gitPath,
      platform: process.platform,
      PATH: process.env.PATH ?? '',
      shell: process.env.SHELL,
      exec,
      isFile: (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
    }),
  )
}

async function gitState(): Promise<GitState> {
  if (!found) detectGit()
  const f = await found!
  if (f.status !== 'ok') return f
  if (!root) throw new Error('no vault open')
  if (git?.cwd !== root) {
    git?.close()
    git = new Git(f.bin, f.PATH, root, () => void callIndex('reconcile').catch(() => {}))
  }
  if (!(await git.isRepo())) return { status: 'notRepo', version: f.version }
  const [id, changes, lfs] = await Promise.all([git.identity(), git.status(), git.lfsInstalled()])
  return { status: 'ready', version: f.version, ...id, changes: changes.length, lfs }
}

function vaultPath(rel: string): string {
  if (!root) throw new Error('no vault open')
  return resolveInVault(root, rel)
}

ipcMain.handle('vault:openDialog', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : openVault(r.filePaths[0])
})
ipcMain.handle('vault:open', (_e, dir: string) => openVault(dir))
ipcMain.handle('vault:recent', () => recentVaults())
ipcMain.handle('file:read', (_e, rel: string) => fs.readFile(vaultPath(rel), 'utf8'))
ipcMain.handle('file:write', (_e, rel: string, content: string) => fs.writeFile(vaultPath(rel), content))
ipcMain.handle('file:createNote', async (_e, dir: string) => {
  const entries = await scanEntries(root!)
  const rel = uniqueNoteName(new Set(entries.map((x) => x.path)), dir, t('untitled'))
  await fs.writeFile(vaultPath(rel), '', { flag: 'wx' }) // wx：不覆盖已有文件
  return rel
})
ipcMain.handle('index:call', (_e, method: string, ...args: unknown[]) => {
  if (!(indexMethods as readonly string[]).includes(method)) throw new Error(`unknown index method: ${method}`)
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
ipcMain.handle('file:trash', (_e, rel: string) => shell.trashItem(vaultPath(rel)))
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
    backgroundColor: '#1e1f22',
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
