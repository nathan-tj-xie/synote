// PROTOTYPE：Electron 外壳，进程内起 Vite dev server；笔记库路径来自 SYNOTE_VAULT
import { app, BrowserWindow, ipcMain } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const vault = path.resolve(process.env.SYNOTE_VAULT ?? path.join(here, '../.vault-10k'));

ipcMain.handle('list-vault', async () => {
  const t0 = performance.now();
  const entries = await readdir(vault, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.relative(vault, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((p) => !p.startsWith('.git/'))
    .sort();
  console.log(`[stat] 主进程内 fs 耗时: ${(performance.now() - t0).toFixed(0)} ms`);
  return { root: vault, files };
});
ipcMain.handle('read-note', (_e, rel) => readFile(path.join(vault, rel), 'utf8'));

// 顶层 await 写法下窗口起不来（原因未查），改用 whenReady().then
app.whenReady().then(async () => {
  const server = await createServer({ root: path.join(here, '..') });
  await server.listen();
  const win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: path.join(here, 'preload.cjs') } });
  win.webContents.on('console-message', (e) => { if (e.message.startsWith('[stat]')) console.log(e.message); });
  await win.loadURL(server.resolvedUrls.local[0]);
  app.on('window-all-closed', () => { server.close(); app.quit(); });
});
