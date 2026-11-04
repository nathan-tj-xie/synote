import { create } from 'zustand'
import type { VaultInfo } from '../../shared/api'

type State = {
  vault: VaultInfo | null
  tabs: string[]
  active: string | null
  dirty: Record<string, true>
  error: string | null
  setVault: (v: VaultInfo | null) => void
  open: (path: string) => void
  close: (path: string) => void
  setDirty: (path: string, dirty: boolean) => void
  setError: (e: string | null) => void
}

export const useStore = create<State>((set) => ({
  vault: null,
  tabs: [],
  active: null,
  dirty: {},
  error: null,
  setVault: (vault) =>
    set((s) => {
      // 已不存在的文件对应的标签页自动关闭
      const alive = new Set(vault?.entries.map((e) => e.path))
      const tabs = s.tabs.filter((t) => alive.has(t))
      return { vault, tabs, active: s.active && alive.has(s.active) ? s.active : (tabs.at(-1) ?? null) }
    }),
  open: (path) => set((s) => ({ tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path], active: path })),
  close: (path) =>
    set((s) => {
      const i = s.tabs.indexOf(path)
      const tabs = s.tabs.filter((t) => t !== path)
      return { tabs, active: s.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active }
    }),
  setDirty: (path, dirty) =>
    set((s) => {
      const d = { ...s.dirty }
      if (dirty) d[path] = true
      else delete d[path]
      return { dirty: d }
    }),
  setError: (error) => set({ error }),
}))
