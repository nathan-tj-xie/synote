// 主进程 ↔ 渲染进程的 IPC 契约，两边共享类型
import type { CommandId } from './commands'

export type Entry = { path: string; dir: boolean } // path 为相对笔记库根目录的 POSIX 路径

export type VaultInfo = { root: string; name: string; entries: Entry[] }

export type ItemMenuAction = Extract<CommandId, 'newNote' | 'trash'> | null

export interface SynoteApi {
  openVaultDialog(): Promise<VaultInfo | null>
  openVault(root: string): Promise<VaultInfo>
  recentVaults(): Promise<string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  createNote(dir: string): Promise<string>
  trash(path: string): Promise<void>
  showItemMenu(path: string, dir: boolean): Promise<ItemMenuAction>
  reportReady(): void
  // 外部改动：刷新后的条目与变化的路径
  onVaultChanged(cb: (e: { entries: Entry[]; changed: string[] }) => void): () => void
}

declare global {
  interface Window {
    synote: SynoteApi
  }
}
