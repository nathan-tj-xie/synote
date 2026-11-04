import { contextBridge, ipcRenderer } from 'electron'
import type { SynoteApi } from '../shared/api'

// 订阅主进程推送的事件，返回取消订阅函数
const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void) => {
    const h = (_e: unknown, payload: T) => cb(payload)
    ipcRenderer.on(channel, h)
    return () => void ipcRenderer.off(channel, h)
  }

const api: SynoteApi = {
  openVaultDialog: () => ipcRenderer.invoke('vault:openDialog'),
  openVault: (root) => ipcRenderer.invoke('vault:open', root),
  recentVaults: () => ipcRenderer.invoke('vault:recent'),
  writeConfig: (v, c) => ipcRenderer.invoke('vault:writeConfig', v, c),
  readFile: (v, p) => ipcRenderer.invoke('file:read', v, p),
  writeFile: (v, p, c) => ipcRenderer.invoke('file:write', v, p, c),
  createNote: (v, dir) => ipcRenderer.invoke('file:createNote', v, dir),
  trash: (v, p) => ipcRenderer.invoke('file:trash', v, p),
  showItemMenu: (p, dir) => ipcRenderer.invoke('menu:item', p, dir),
  reportReady: () => ipcRenderer.send('app:ready'),
  onVaultChanged: subscribe('vault:changed'),
  backlinks: (p) => ipcRenderer.invoke('index:call', 'backlinks', p),
  search: (q) => ipcRenderer.invoke('index:call', 'search', q),
  attachmentRefs: (p) => ipcRenderer.invoke('index:call', 'attachmentRefs', p),
  orphans: () => ipcRenderer.invoke('index:call', 'orphans'),
  rebuildIndex: () => ipcRenderer.invoke('index:call', 'rebuild'),
  onIndexChanged: subscribe('index:changed'),
  gitState: () => ipcRenderer.invoke('git:state'),
  redetectGit: () => ipcRenderer.invoke('git:redetect'),
  chooseGit: () => ipcRenderer.invoke('git:choose'),
  onGitChanged: subscribe('git:changed'),
}

contextBridge.exposeInMainWorld('synote', api)
