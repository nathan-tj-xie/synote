// 主进程 ↔ 渲染进程的 IPC 契约，两边共享类型
import type { CommandId } from './commands'

export type Entry = { path: string; dir: boolean } // path 为相对笔记库根目录的 POSIX 路径

export type VaultInfo = { root: string; name: string; entries: Entry[] }

export type SearchHit = { path: string; snippet: string }

// 渲染进程可调用的索引查询（主进程按这个白名单转发给索引 utility process）
export const indexMethods = ['backlinks', 'search', 'attachmentRefs', 'orphans', 'rebuild'] as const

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
  // 索引（S6）
  backlinks(path: string): Promise<string[]>
  search(query: string): Promise<SearchHit[]>
  attachmentRefs(path: string): Promise<number>
  orphans(): Promise<string[]>
  rebuildIndex(): Promise<void>
  // 索引更新后推送变化的路径；反链、引用计数、孤儿列表据此重新查询
  onIndexChanged(cb: (paths: string[]) => void): () => void
}

declare global {
  interface Window {
    synote: SynoteApi
  }
}
