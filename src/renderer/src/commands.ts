// 命令注册表的运行时部分：可用条件和执行逻辑；id、标题、快捷键见 shared/commands.ts
import { commands, type CommandId } from '../../shared/commands'
import { i18next } from '../../shared/i18n'
import { attachmentsSettled, flushAll, forget, insertEmbed, saveCurrent, toggleDiff } from './editor'
import { matchKey } from './match'
import { useEditor, useUi, useVault } from './store'
import { openVault } from './vaults'

type Handler = {
  when?: () => boolean
  // arg：从右键菜单触发时是被点的路径，从快捷键 / 命令面板触发时为空
  run: (arg?: string) => unknown
}

const vault = () => !!useVault.getState().vault
const root = () => useVault.getState().vault!.root
const ed = useEditor.getState
const ui = useUi.getState
const fail = (e: unknown) => ui().setError(String(e))

export const handlers: Record<CommandId, Handler> = {
  quickOpen: { when: vault, run: () => ui().setPalette('files') },
  commandPalette: { when: vault, run: () => ui().setPalette('commands') },
  save: { when: () => !!ed().active, run: saveCurrent },
  toggleDiff: { when: () => !!ed().active, run: toggleDiff },
  toggleHistory: { when: vault, run: () => ui().toggleHistory() },
  search: {
    when: vault,
    run: () => {
      ui().setSidebar('search')
      requestAnimationFrame(() => document.getElementById('search-input')?.focus())
    },
  },
  newNote: {
    when: vault,
    run: (dir = '') => {
      const r = root()
      return window.synote
        .createNote(r, dir)
        .then((p) => useVault.getState().vault?.root === r && ed().open(p)) // 期间换了库：不在新库里开旧库的标签
        .catch(fail)
    },
  },
  // 文件树右键传入被点的路径；命令面板里是当前笔记
  rename: { when: () => !!ed().active, run: (path = ed().active!) => ui().setRename({ root: root(), from: path }) },
  trash: {
    when: () => !!ed().active,
    run: async (path = ed().active!) => {
      const r = root()
      try {
        await window.synote.trash(r, path)
      } catch (e) {
        return fail(e)
      }
      if (useVault.getState().vault?.root !== r) return // 期间换了库：新库里的同名标签不能关
      for (const tab of ed().tabs) if (tab === path || tab.startsWith(`${path}/`)) forget(tab)
    },
  },
  rebuildIndex: { when: vault, run: () => window.synote.rebuildIndex(root()).catch(fail) },
  // 孤儿以落盘内容为准（GLOSSARY：由索引推导）：先把编辑器里未保存的引用写下去，再取清单
  cleanOrphans: {
    when: vault,
    run: async () => {
      const r = root()
      try {
        await attachmentsSettled() // 在途的粘贴 / 拖入先插完链接，再一起落盘
        if (!(await flushAll())) return fail(i18next.t('orphansUnsaved'))
        const list = await window.synote.listOrphans(r)
        if (useVault.getState().vault?.root === r) ui().setOrphans({ root: r, list })
      } catch (e) {
        fail(e)
      }
    },
  },
  insertMath: { when: () => !!ed().active, run: () => insertEmbed(true) },
  insertInlineMath: { when: () => !!ed().active, run: () => insertEmbed(false) },
  // 选中的就是当前库：什么都不做
  openVault: { when: vault, run: () => window.synote.pickVault().then((d) => (d && d !== root() ? openVault(d) : undefined)).catch(fail) },
  switchVault: { when: vault, run: () => ui().setPalette('vaults') },
}

export const ids = Object.keys(commands) as CommandId[]
export const available = (id: CommandId) => handlers[id].when?.() ?? true

export function run(id: CommandId) {
  if (available(id)) handlers[id].run()
}

// 全局快捷键：捕获阶段处理，先于 CM6 的 keymap
export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const id = ids.find((i) => {
      const key: string | undefined = (commands[i] as { key?: string }).key
      return key && matchKey(e, key)
    })
    if (!id || !available(id)) return
    e.preventDefault()
    e.stopPropagation()
    handlers[id].run()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
