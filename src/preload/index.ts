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
  presence: (v, p) => ipcRenderer.invoke('file:presence', v, p),
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
  readRev: (v, r, p) => ipcRenderer.invoke('git:readRev', v, r, p),
  readStages: (v, p) => ipcRenderer.invoke('git:readStages', v, p),
  lfsSmudge: (v, r, p) => ipcRenderer.invoke('git:lfsSmudge', v, r, p),
  lfsPull: (v, p) => ipcRenderer.invoke('git:lfsPull', v, p),
  fileLog: (v, p) => ipcRenderer.invoke('git:log', v, p),
  restoreSource: (v, p) => ipcRenderer.invoke('git:restoreSource', v, p),
  restoreAttachment: (v, p, h) => ipcRenderer.invoke('git:restore', v, p, h),
  gitStage: (v, p) => ipcRenderer.invoke('git:stage', v, p),
  gitUnstage: (v, p) => ipcRenderer.invoke('git:unstage', v, p),
  gitCommit: (v, m, all, o) => ipcRenderer.invoke('git:commit', v, m, all, o),
  gitPush: (v) => ipcRenderer.invoke('git:push', v),
  gitPull: (v) => ipcRenderer.invoke('git:pull', v),
  gitMergeContinue: (v) => ipcRenderer.invoke('git:mergeContinue', v),
  gitMergeAbort: (v) => ipcRenderer.invoke('git:mergeAbort', v),
  gitTakeSide: (v, p, side) => ipcRenderer.invoke('git:takeSide', v, p, side),
  repoLog: (v) => ipcRenderer.invoke('git:repoLog', v),
  onGitChanged: subscribe('git:changed'),
}

contextBridge.exposeInMainWorld('synote', api)
