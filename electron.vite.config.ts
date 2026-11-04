import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 索引服务跑在单独的 utility process，单独出一个入口
  main: { build: { rollupOptions: { input: { index: 'src/main/index.ts', 'index-worker': 'src/main/index-worker.ts' } } } },
  preload: {},
  renderer: { plugins: [react()] },
})
