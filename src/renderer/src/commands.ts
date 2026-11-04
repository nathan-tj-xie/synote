// 命令注册表的运行时部分：可用条件和执行逻辑；id、标题、快捷键见 shared/commands.ts
import { commands, type CommandId } from '../../shared/commands'
import { forget, saveCurrent } from './editor'
import { matchKey } from './match'
import { useStore } from './store'

type Handler = {
  when?: () => boolean
  // arg：从右键菜单触发时是被点的路径，从快捷键 / 命令面板触发时为空
  run: (arg?: string) => unknown
}

const st = useStore.getState
const fail = (e: unknown) => st().setError(String(e))

export const handlers: Record<CommandId, Handler> = {
  quickOpen: { when: () => !!st().vault, run: () => st().setPalette('files') },
  commandPalette: { when: () => !!st().vault, run: () => st().setPalette('commands') },
  save: { when: () => !!st().active, run: saveCurrent },
  newNote: {
    when: () => !!st().vault,
    run: (dir = '') =>
      window.synote
        .createNote(dir)
        .then((p) => st().open(p))
        .catch(fail),
  },
  trash: {
    when: () => !!st().active,
    run: async (path = st().active!) => {
      try {
        await window.synote.trash(path)
      } catch (e) {
        return fail(e)
      }
      for (const tab of st().tabs) if (tab === path || tab.startsWith(`${path}/`)) forget(tab)
    },
  },
  rebuildIndex: { when: () => !!st().vault, run: () => window.synote.rebuildIndex().catch(fail) },
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
