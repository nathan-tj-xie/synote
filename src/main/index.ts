import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { i18next, i18nOptions } from '../shared/i18n'
import { commands } from '../shared/commands'
import type { ItemMenuAction, VaultInfo } from '../shared/api'
import { isHidden, resolveInVault, scanEntries, toPosix, uniqueNoteName } from './vault'

i18next.init(i18nOptions)
const t = i18next.t

let win: BrowserWindow | null = null
let root: string | null = null
let watcher: FSWatcher | null = null

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

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
