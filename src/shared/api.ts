// 主进程 ↔ 渲染进程的 IPC 契约，两边共享类型
import type { CommandId } from './commands'

export type Entry = { path: string; dir: boolean } // path 为相对笔记库根目录的 POSIX 路径

// .synote/config.json 的内容（入 git）；具体字段由用到的功能各自加
export type VaultConfig = Record<string, unknown>

export type VaultInfo = { root: string; name: string; entries: Entry[]; config: VaultConfig }

// line 从 1 开始，col 是行内 UTF-16 偏移；text 是该行的摘要，命中从 text[start] 开始，长度同查询词
export type SearchMatch = { line: number; col: number; text: string; start: number }
export type SearchHit = { path: string; matches: SearchMatch[] }

// 渲染进程可调用的索引查询（主进程按这个白名单转发给索引 utility process）
export const indexMethods = ['backlinks', 'search', 'attachmentRefs', 'orphans', 'rebuild'] as const

// git 错误分类（S12），S13 起按分类给出引导
export type GitErrorKind =
  | 'noCredentials'
  | 'nonFastForward'
  | 'noIdentity'
  | 'conflict'
  | 'lfsMissing'
  | 'network'
  | 'notRepo'
  | 'unknown'

// 当前笔记库的 git 状态；missing / tooOld / notRepo 时按非 git 目录模式运行
export type GitState =
  | { status: 'missing' }
  | { status: 'tooOld'; bin: string; version: string }
  | { status: 'notRepo'; version: string }
  // name / email 有一个为 null 就禁用提交；lfs：本机是否装了 git-lfs（供 S17）
  | { status: 'ready'; version: string; name: string | null; email: string | null; changes: number; lfs: boolean }

export type ItemMenuAction = Extract<CommandId, 'newNote' | 'trash'> | null

export interface SynoteApi {
  // 选择文件夹，取消时为 null
  pickVault(): Promise<string | null>
  // 切库交接的两步（渲染进程的 openVault 串行驱动）：prepare 只读新库，commit 一次性切换
  prepareVault(root: string): Promise<VaultInfo>
  commitVault(root: string): Promise<void>
  recentVaults(): Promise<string[]>
  // 以下读写都带上发起方所在的笔记库（VaultInfo.root），和主进程当前的库不一致时拒绝
  writeConfig(vault: string, config: VaultConfig): Promise<void>
  readFile(vault: string, path: string): Promise<string>
  writeFile(vault: string, path: string, content: string): Promise<void>
  readBytes(vault: string, path: string): Promise<Uint8Array>
  // 每个路径是否存在（实时预览的附件缺失占位用）
  exists(vault: string, paths: string[]): Promise<boolean[]>
  createNote(vault: string, dir: string): Promise<string>
  // 粘贴 / 拖入的附件写进 attachments/（S10），name 为 null 表示剪贴板图片；内容相同的已有文件直接复用。
  // warn：large 为超过 50 MiB，huge 为超过 100 MiB 且不走 LFS
  saveAttachment(vault: string, name: string | null, bytes: Uint8Array): Promise<{ path: string; warn: 'large' | 'huge' | null }>
  trash(vault: string, path: string): Promise<void>
  showItemMenu(path: string, dir: boolean): Promise<ItemMenuAction>
  reportReady(): void
  // 以下推送事件都带上来源笔记库的 root，渲染进程只接受当前库的
  // 外部改动：刷新后的条目与变化的路径
  onVaultChanged(cb: (e: { root: string; entries: Entry[]; changed: string[] }) => void): () => void
  // 索引（S6），查询同样带上笔记库
  backlinks(vault: string, path: string): Promise<string[]>
  search(vault: string, query: string): Promise<SearchHit[]>
  attachmentRefs(vault: string, path: string): Promise<number>
  orphans(vault: string): Promise<string[]>
  rebuildIndex(vault: string): Promise<void>
  // 索引更新后推送变化的路径；反链、引用计数、孤儿列表据此重新查询
  onIndexChanged(cb: (e: { root: string; paths: string[] }) => void): () => void
  // git（S12）
  gitState(): Promise<GitState>
  redetectGit(): Promise<GitState>
  // 弹出文件选择框指定 git 可执行文件，取消时为 null
  chooseGit(): Promise<GitState | null>
  // 工作区对比（S14）：HEAD 里的文件内容，HEAD 里没有时为 null；没有可用 git 或不是仓库时报错
  readHead(vault: string, path: string): Promise<Uint8Array | null>
  // 工作区或 .git 有变化后推送最新状态
  onGitChanged(cb: (e: { root: string | null; state: GitState }) => void): () => void
}

declare global {
  interface Window {
    synote: SynoteApi
  }
}
