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
  pickVault: () => ipcRenderer.invoke('vault:pick'),
  prepareVault: (root) => ipcRenderer.invoke('vault:prepare', root),
  commitVault: (root) => ipcRenderer.invoke('vault:commit', root),
  recentVaults: () => ipcRenderer.invoke('vault:recent'),
  writeConfig: (v, c) => ipcRenderer.invoke('vault:writeConfig', v, c),
  readFile: (v, p) => ipcRenderer.invoke('file:read', v, p),
  writeFile: (v, p, c) => ipcRenderer.invoke('file:write', v, p, c),
  readBytes: (v, p) => ipcRenderer.invoke('file:readBytes', v, p),
  exists: (v, p) => ipcRenderer.invoke('file:exists', v, p),
  createNote: (v, dir) => ipcRenderer.invoke('file:createNote', v, dir),
  saveAttachment: (v, n, b) => ipcRenderer.invoke('file:saveAttachment', v, n, b),
  attachmentSettled: (v, p) => ipcRenderer.invoke('file:attachmentSettled', v, p),
  trash: (v, p) => ipcRenderer.invoke('file:trash', v, p),
  planRename: (v, f, t) => ipcRenderer.invoke('file:planRename', v, f, t),
  rename: (v, f, t, files) => ipcRenderer.invoke('file:rename', v, f, t, files),
  showItemMenu: (p, dir) => ipcRenderer.invoke('menu:item', p, dir),
  reportReady: () => ipcRenderer.send('app:ready'),
  onVaultChanged: subscribe('vault:changed'),
  backlinks: (v, p) => ipcRenderer.invoke('index:call', v, 'backlinks', p),
  search: (v, q) => ipcRenderer.invoke('index:call', v, 'search', q),
  attachmentRefs: (v, p) => ipcRenderer.invoke('index:call', v, 'attachmentRefs', p),
  orphans: (v) => ipcRenderer.invoke('index:call', v, 'orphans'),
  rebuildIndex: (v) => ipcRenderer.invoke('index:call', v, 'rebuild'),
  listOrphans: (v) => ipcRenderer.invoke('orphans:list', v),
  deleteOrphans: (v, p) => ipcRenderer.invoke('orphans:delete', v, p),
  onIndexChanged: subscribe('index:changed'),
  gitState: () => ipcRenderer.invoke('git:state'),
  redetectGit: () => ipcRenderer.invoke('git:redetect'),
  chooseGit: () => ipcRenderer.invoke('git:choose'),
  readHead: (v, p) => ipcRenderer.invoke('git:readHead', v, p),
  onGitChanged: subscribe('git:changed'),
}

contextBridge.exposeInMainWorld('synote', api)
