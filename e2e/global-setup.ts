// Electron 45 的 npm 包没有 postinstall，二进制在第一次 require('electron') 时才下载解压（node_modules/electron/index.js）。
// 不先装好的话，几个 worker 的第一个 electron.launch 会同时下载、解压到同一个 dist：Windows 上报
// `Process failed to launch!` / `Electron failed to install correctly`（解压时 ffmpeg.dll Access is denied）。
// 这里在 worker 启动前装一次，之后各 worker 只读 path.txt
export default async () => {
  await import('electron')
}
