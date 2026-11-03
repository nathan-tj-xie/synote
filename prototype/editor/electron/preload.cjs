const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('synote', {
  name: 'Electron',
  listVault: () => ipcRenderer.invoke('list-vault'),
  readNote: (rel) => ipcRenderer.invoke('read-note', rel),
});
