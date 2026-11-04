// 按领域拆 store（ADR 0005）：vault / editor / ui / git
import { create } from 'zustand'
import type { GitState, VaultInfo } from '../../shared/api'

type VaultState = {
  vault: VaultInfo | null
  setVault: (v: VaultInfo | null) => void
}

type EditorState = {
  tabs: string[]
  active: string | null
  dirty: Record<string, true>
  open: (path: string) => void
  close: (path: string) => void
  // 只保留仍存在的文件对应的标签页
  keep: (alive: Set<string>) => void
  // 换了笔记库：标签、活动文件、dirty 全清（两库同名文件也不沿用）
  reset: () => void
  setDirty: (path: string, dirty: boolean) => void
}

type UiState = {
  error: string | null
  palette: 'files' | 'commands' | null
  sidebar: 'files' | 'search' | 'git'
  setError: (e: string | null) => void
  setPalette: (p: UiState['palette']) => void
  setSidebar: (v: UiState['sidebar']) => void
}

export const useVault = create<VaultState>((set, get) => ({
  vault: null,
  setVault: (vault) => {
    const same = get().vault?.root === vault?.root
    set({ vault })
    if (!same) useEditor.getState().reset()
    // 同一个库的外部改动：已不存在的文件对应的标签页自动关闭
    else useEditor.getState().keep(new Set(vault?.entries.map((e) => e.path)))
  },
}))

export const useEditor = create<EditorState>((set) => ({
  tabs: [],
  active: null,
  dirty: {},
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
  reset: () => set({ tabs: [], active: null, dirty: {} }),
  setDirty: (path, dirty) =>
    set((s) => {
      const d = { ...s.dirty }
      if (dirty) d[path] = true
      else delete d[path]
      return { dirty: d }
    }),
}))

export const useUi = create<UiState>((set) => ({
  error: null,
  palette: null,
  sidebar: 'files',
  setError: (error) => set({ error }),
  setPalette: (palette) => set({ palette }),
  setSidebar: (sidebar) => set({ sidebar }),
}))

// git 领域的 store（ADR 0005）：主进程状态的只读镜像，由 git:changed 推送更新
export const useGit = create<{ state: GitState | null }>(() => ({ state: null }))
