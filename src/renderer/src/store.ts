// 按领域拆 store（ADR 0005）：vault / editor / ui / git
import type { EditorView } from '@codemirror/view'
import { create } from 'zustand'
import type { GitState, OrphanAttachment, VaultInfo } from '../../shared/api'
import type { Embed } from './embed'

type VaultState = {
  vault: VaultInfo | null
  setVault: (v: VaultInfo | null) => void
}

type EditorState = {
  tabs: string[]
  active: string | null
  dirty: Record<string, true>
  // 处于 diff 形态的文件 → 左侧版本（HEAD 或提交 oid），由 editor.ts 维护
  compare: Record<string, string>
  open: (path: string) => void
  close: (path: string) => void
  // 只保留仍存在的文件对应的标签页
  keep: (alive: Set<string>) => void
  // 换了笔记库：标签、活动文件、dirty 全清（两库同名文件也不沿用）
  reset: () => void
  setDirty: (path: string, dirty: boolean) => void
  // 重命名 / 移动之后（S9）：标签、活动文件、dirty 跟着换路径
  rename: (move: (p: string) => string) => void
  setCompare: (path: string, rev: string | null) => void
}

type UiState = {
  error: string | null
  palette: 'files' | 'commands' | 'vaults' | null
  sidebar: 'files' | 'search' | 'git'
  history: boolean // 历史栏（S15）是否显示
  // "清理孤儿附件"确认框：清单来自哪个库（确认时按它删，期间切了库主进程会拒绝）
  orphans: { root: string; list: OrphanAttachment[] } | null
  // "重命名 / 移动"对话框：要移动的路径和它所在的库
  rename: { root: string; from: string } | null
  // 合并编辑器里还有 n 处冲突没处理时点了"完成此文件合并"（#70）：确认框
  mergeConfirm: { path: string; n: number } | null
  // 正在编辑的嵌入块：`$x$`（at 是公式的框）在浮层里，其余在弹窗里。带着视图是为了写回时直接派发，不经 React state 持有正文；
  // note 是发起时视图里的笔记，写回时核对；id 每次打开都不同，编辑界面按它重置
  embed: { id: number; view: EditorView; note: { vault: string; path: string } | null; embed: Embed; at: { left: number; top: number; width: number; height: number } | null } | null
  setError: (e: string | null) => void
  setPalette: (p: UiState['palette']) => void
  setSidebar: (v: UiState['sidebar']) => void
  setOrphans: (o: UiState['orphans']) => void
  setRename: (r: UiState['rename']) => void
  setMergeConfirm: (m: UiState['mergeConfirm']) => void
  setEmbed: (e: UiState['embed']) => void
  toggleHistory: () => void
}

export const useVault = create<VaultState>((set, get) => ({
  vault: null,
  setVault: (vault) => {
    const same = get().vault?.root === vault?.root
    set({ vault })
    if (!same) {
      useEditor.getState().reset()
      useGit.setState({ state: null }) // 旧库的 git 状态（含冲突文件）不能套到新库的同名文件上
    }
    // 同一个库的外部改动：已不存在的文件对应的标签页自动关闭
    else useEditor.getState().keep(new Set(vault?.entries.map((e) => e.path)))
  },
}))

export const useEditor = create<EditorState>((set) => ({
  tabs: [],
  active: null,
  dirty: {},
  compare: {},
  open: (path) => set((s) => ({ tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path], active: path })),
  close: (path) =>
    set((s) => {
      const i = s.tabs.indexOf(path)
      const tabs = s.tabs.filter((t) => t !== path)
      return { tabs, active: s.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active }
    }),
  keep: (alive) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => alive.has(t))
      return { tabs, active: s.active && alive.has(s.active) ? s.active : (tabs.at(-1) ?? null) }
    }),
  reset: () => set({ tabs: [], active: null, dirty: {}, compare: {} }),
  setDirty: (path, dirty) =>
    set((s) => {
      const d = { ...s.dirty }
      if (dirty) d[path] = true
      else delete d[path]
      return { dirty: d }
    }),
  rename: (move) =>
    set((s) => ({ tabs: s.tabs.map(move), active: s.active && move(s.active), dirty: Object.fromEntries(Object.keys(s.dirty).map((p) => [move(p), true])) })),
  setCompare: (path, rev) =>
    set((s) => {
      const c = { ...s.compare }
      if (rev) c[path] = rev
      else delete c[path]
      return { compare: c }
    }),
}))

export const useUi = create<UiState>((set) => ({
  error: null,
  palette: null,
  sidebar: 'files',
  orphans: null,
  rename: null,
  mergeConfirm: null,
  embed: null,
  history: false,
  setError: (error) => set({ error }),
  setPalette: (palette) => set({ palette }),
  setSidebar: (sidebar) => set({ sidebar }),
  setOrphans: (orphans) => set({ orphans }),
  setRename: (rename) => set({ rename }),
  setMergeConfirm: (mergeConfirm) => set({ mergeConfirm }),
  setEmbed: (embed) => set({ embed }),
  toggleHistory: () => set((s) => ({ history: !s.history })),
}))

// git 领域的 store（ADR 0005）：主进程状态的只读镜像，由 git:changed 推送更新
export const useGit = create<{ state: GitState | null }>(() => ({ state: null }))
