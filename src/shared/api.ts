// 主进程 ↔ 渲染进程的 IPC 契约，两边共享类型
import type { CommandId } from './commands'
import type { LfsPointer } from './lfs'
import type { Edit } from './mdLinks'

export type Entry = { path: string; dir: boolean } // path 为相对笔记库根目录的 POSIX 路径

// .synote/config.json 的内容（入 git）；具体字段由用到的功能各自加
export type VaultConfig = Record<string, unknown>

export type VaultInfo = { root: string; name: string; entries: Entry[]; config: VaultConfig }

// line 从 1 开始，col 是行内 UTF-16 偏移；text 是该行的摘要，命中从 text[start] 开始，长度同查询词
export type SearchMatch = { line: number; col: number; text: string; start: number }
export type SearchHit = { path: string; matches: SearchMatch[] }

// 反链：来源笔记、链接所在的行（从 1 起）和这一行的文字；一篇里多处链接时每行一条
export type Backlink = { path: string; line: number; text: string }

// 渲染进程可调用的索引查询（主进程按这个白名单转发给索引 utility process）
export const indexMethods = ['backlinks', 'search', 'attachmentRefs', 'orphans', 'rebuild'] as const

// git 错误分类（S12），S13 起按分类给出引导
export type GitErrorKind =
  | 'noCredentials'
  | 'nonFastForward'
  | 'noIdentity'
  | 'conflict'
  | 'lfsMissing'
  // LFS 的 smudge / clean filter 或下载失败（S17）：装了 git-lfs，但离线、LFS 远端不可达等
  | 'lfsFilter'
  | 'network'
  | 'notRepo'
  // 提交前发现暂存区里有笔记库之外的文件（S13）：面板看不到它们，不替用户提交
  | 'stagedOutside'
  // 完成合并前还有冲突文件、或暂存的内容里仍有冲突标记（S16）
  | 'unresolved'
  | 'unknown'

// 当前笔记库的 git 状态；missing / tooOld / notRepo 时按非 git 目录模式运行
export type GitState =
  | { status: 'missing' }
  | { status: 'tooOld'; bin: string; version: string }
  | { status: 'notRepo'; version: string }
  // name / email 有一个为 null 就禁用提交；files：笔记库内的改动（S13）。
  // lfs：本机是否装了 git-lfs；lfsUsed：笔记库里有路径按 .gitattributes 走 LFS（只在 lfs 为 false 时检测，否则为 false）；
  // lfsError：git status 因 LFS filter 失败（如配置了 filter.lfs.required 却找不到 git-lfs），此时 files 为空、分支信息缺省（S17）；
  // merging：合并中（有 MERGE_HEAD，S16），冲突文件在 files 里带 conflict
  | ({
      status: 'ready'
      version: string
      name: string | null
      email: string | null
      files: GitFile[]
      lfs: boolean
      lfsUsed: boolean
      lfsError: { kind: 'lfsMissing' | 'lfsFilter'; raw: string } | null
      merging: boolean
    } & GitBranch)

// 分支与上游（S13）：branch 为 null 表示 detached；没有上游时 upstream 为 null，ahead / behind 为 0
export type GitBranch = { branch: string | null; upstream: string | null; ahead: number; behind: number }

// 一处改动（S13）：path 相对笔记库；x / y 为 porcelain 的暂存区 / 工作区状态（. 表示没改，未跟踪为 ? ?）；
// orig 是重命名前的路径（在库外时以 ../ 开头）；conflict：合并冲突、还没解决（S16）
export type GitFile = { path: string; x: string; y: string; orig?: string; conflict?: true }

// git 面板写操作（S13）的结果。done 是失败前已完成的步骤：deleted 为删掉的孤儿附件数（kept 为没删的），
// staged 为已"全部暂存"；raw 是 git 的原始输出
// kept 的 staged：暂存区版本的笔记仍引用它（"提交已暂存"时）
export type GitDone = { deleted?: number; kept?: { path: string; reason: 'mentioned' | 'pending' | 'staged' }[]; staged?: boolean }
// outside：kind 为 stagedOutside 时，仓库根（top）和那些库外的已暂存路径（相对仓库根）；paths：kind 为 unresolved 时没解决的文件
export type GitOpResult =
  | { ok: true; done: GitDone }
  | { ok: false; kind: GitErrorKind; raw: string; done: GitDone; outside?: { top: string; paths: string[] }; paths?: string[] }

// 孤儿附件（S11）：tracked 为 git 已跟踪，删除时执行 git rm；否则（含非 git 目录）移到回收站
export type OrphanAttachment = { path: string; tracked: boolean }

// 历史栏的一条提交（S15）：path 是文件在该提交里的路径，相对笔记库根（改名前位于库外时以 ../ 开头）；
// status 是该提交对它的改动（A / M / R / D…），time 为秒
export type LogEntry = { hash: string; time: number; author: string; subject: string; path: string; status: string }

// 一个路径的存在状态：missing 不存在（含越出笔记库）；present 存在；lfs 存在但内容是 LFS 指针、还没下载（S17）
export type Presence = { state: 'missing' } | { state: 'present' } | { state: 'lfs'; pointer: LfsPointer }

export type ItemMenuAction = Extract<CommandId, 'newNote' | 'rename' | 'trash'> | null

// 重命名 / 移动后改写过的笔记（旧路径）：改写前的正文和改写（偏移按 before），渲染进程据此更新已打开的笔记
export type Rewritten = { path: string; before: string; edits: Edit[] }

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
  // 每个路径的存在状态（实时预览的附件缺失 / LFS 未下载占位、跳转前检查笔记是否存在）
  presence(vault: string, paths: string[]): Promise<Presence[]>
  createNote(vault: string, dir: string): Promise<string>
  // 粘贴 / 拖入的附件写进 attachments/（S10），name 为 null 表示剪贴板图片；内容相同的已有文件直接复用。
  // warn：large 为超过 50 MiB，huge 为超过 100 MiB 且不走 LFS
  saveAttachment(vault: string, name: string | null, bytes: Uint8Array): Promise<{ path: string; warn: 'large' | 'huge' | null }>
  // 这些附件的插入任务已结束（插入、取消或丢弃），相关笔记也已落盘：解除清理孤儿时的在途保护（S11）
  attachmentSettled(vault: string, paths: string[]): Promise<void>
  trash(vault: string, path: string): Promise<void>
  // 重命名 / 移动（S9）：先 planRename 列出要改写链接的笔记（旧路径）和没法自动改写的链接（`路径: 原文`），
  // 用户确认后 rename 带上这份清单执行；清单和执行时重算的不一致（期间库被改过）就拒绝。全部成功或全部不改
  planRename(vault: string, from: string, to: string): Promise<{ files: string[]; skipped: string[] }>
  rename(vault: string, from: string, to: string, files: string[]): Promise<Rewritten[]>
  showItemMenu(path: string, dir: boolean): Promise<ItemMenuAction>
  reportReady(): void
  // 以下推送事件都带上来源笔记库的 root，渲染进程只接受当前库的
  // 外部改动：刷新后的条目与变化的路径
  onVaultChanged(cb: (e: { root: string; entries: Entry[]; changed: string[] }) => void): () => void
  // 索引（S6），查询同样带上笔记库
  backlinks(vault: string, path: string): Promise<Backlink[]>
  search(vault: string, query: string): Promise<SearchHit[]>
  attachmentRefs(vault: string, path: string): Promise<number>
  orphans(vault: string): Promise<string[]>
  rebuildIndex(vault: string): Promise<void>
  // "将删除的孤儿附件"清单（S11，S13 的 commit 面板分组也用），按路径排序；取之前主进程先对账，以落盘内容为准
  listOrphans(vault: string): Promise<OrphanAttachment[]>
  // 删除用户确认过的孤儿附件。deleted：实际删除的路径；已不是孤儿、不在 attachments/ 内（含符号链接越界）的静默跳过；
  // kept：为保险没删的。mentioned：文件名仍出现在笔记正文里；pending：本会话刚添加，引用还没保存
  deleteOrphans(vault: string, paths: string[]): Promise<{ deleted: string[]; kept: { path: string; reason: 'mentioned' | 'pending' }[] }>
  // 索引更新后推送变化的路径；反链、引用计数、孤儿列表据此重新查询
  onIndexChanged(cb: (e: { root: string; paths: string[] }) => void): () => void
  // git（S12）
  gitState(): Promise<GitState>
  redetectGit(): Promise<GitState>
  // 弹出文件选择框指定 git 可执行文件，取消时为 null
  chooseGit(): Promise<GitState | null>
  // 工作区对比（S14）、历史对比（S15）：rev（HEAD 或完整 oid）里的文件内容，那里没有时为 null；没有可用 git 或不是仓库时报错
  // LFS（S17）：对象已在本地时给真实内容，否则原样给指针（不联网）
  readRev(vault: string, rev: string, path: string): Promise<Uint8Array | null>
  // 用户点了"下载"：历史版本里的 LFS 指针经 git lfs smudge 换成真实内容（会联网）
  lfsSmudge(vault: string, rev: string, path: string): Promise<Uint8Array | null>
  // 工作区里是 LFS 指针的文件：git lfs pull 下载真实内容写回工作区；不是指针时什么都不做
  lfsPull(vault: string, path: string): Promise<void>
  // 历史栏（S15）：笔记的提交历史（git log --follow），新的在前；还没有提交时为空
  fileLog(vault: string, path: string): Promise<LogEntry[]>
  // 从历史恢复缺失附件（S15）：最后一个还有它的提交，历史里从没有过时为 null；restore 只写工作区，已存在时拒绝
  restoreSource(vault: string, path: string): Promise<LogEntry | null>
  restoreAttachment(vault: string, path: string, hash: string): Promise<void>
  // git 面板（S13）：都只作用于笔记库内。stage 的 paths 为 null 时暂存全部；
  // commit：all 时先全部暂存，orphans 是勾选的孤儿附件，按"先删孤儿、再暂存、再提交"执行，失败时 done 说明做到了哪一步
  gitStage(vault: string, paths: string[] | null): Promise<GitOpResult>
  gitUnstage(vault: string, paths: string[]): Promise<GitOpResult>
  gitCommit(vault: string, message: string, all: boolean, orphans: string[]): Promise<GitOpResult>
  gitPush(vault: string): Promise<GitOpResult>
  gitPull(vault: string): Promise<GitOpResult>
  // 合并中（S16）：完成合并（先复查冲突文件和残留标记，再用 git 生成的信息提交暂存区）；放弃合并（git merge --abort）
  gitMergeContinue(vault: string): Promise<GitOpResult>
  gitMergeAbort(vault: string): Promise<GitOpResult>
  // 笔记库的提交历史（git 面板底部），新的在前；LogEntry.path 为空
  repoLog(vault: string): Promise<LogEntry[]>
  // 工作区或 .git 有变化后推送最新状态
  onGitChanged(cb: (e: { root: string | null; state: GitState }) => void): () => void
}

declare global {
  interface Window {
    synote: SynoteApi
  }
}
