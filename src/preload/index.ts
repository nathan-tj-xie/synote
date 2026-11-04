import { contextBridge, ipcRenderer } from 'electron'
import type { GitState, SynoteApi } from '../shared/api'

const api: SynoteApi = {
  openVaultDialog: () => ipcRenderer.invoke('vault:openDialog'),
  openVault: (root) => ipcRenderer.invoke('vault:open', root),
  recentVaults: () => ipcRenderer.invoke('vault:recent'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  writeFile: (p, c) => ipcRenderer.invoke('file:write', p, c),
  createNote: (dir) => ipcRenderer.invoke('file:createNote', dir),
  trash: (p) => ipcRenderer.invoke('file:trash', p),
  showItemMenu: (p, dir) => ipcRenderer.invoke('menu:item', p, dir),
  reportReady: () => ipcRenderer.send('app:ready'),
  onVaultChanged: (cb) => {
    const h = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload)
    ipcRenderer.on('vault:changed', h)
    return () => ipcRenderer.off('vault:changed', h)
  },
  backlinks: (p) => ipcRenderer.invoke('index:call', 'backlinks', p),
  search: (q) => ipcRenderer.invoke('index:call', 'search', q),
  attachmentRefs: (p) => ipcRenderer.invoke('index:call', 'attachmentRefs', p),
  orphans: () => ipcRenderer.invoke('index:call', 'orphans'),
  rebuildIndex: () => ipcRenderer.invoke('index:call', 'rebuild'),
  onIndexChanged: (cb) => {
    const h = (_e: unknown, paths: string[]) => cb(paths)
    ipcRenderer.on('index:changed', h)
    return () => ipcRenderer.off('index:changed', h)
  },
  gitState: () => ipcRenderer.invoke('git:state'),
  redetectGit: () => ipcRenderer.invoke('git:redetect'),
  chooseGit: () => ipcRenderer.invoke('git:choose'),
  onGitChanged: (cb) => {
    const h = (_e: unknown, s: GitState) => cb(s)
    ipcRenderer.on('git:changed', h)
    return () => ipcRenderer.off('git:changed', h)
  },
}

contextBridge.exposeInMainWorld('synote', api)
