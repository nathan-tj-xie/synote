import type { zhCN } from './locales/zh-CN'

// 命令注册表的静态部分：主进程（菜单文案）和渲染进程（快捷键、命令面板）共用，快捷键只在这里定义（ADR 0005）
// key 的写法同 CM6：Mod 在 mac 上是 ⌘，其他平台是 Ctrl
export const commands = {
  quickOpen: { title: 'quickOpen', key: 'Mod-p' },
  commandPalette: { title: 'commandPalette', key: 'Mod-Shift-p' },
  save: { title: 'save', key: 'Mod-s' },
  newNote: { title: 'newNote' },
  trash: { title: 'trash' },
} as const satisfies Record<string, { title: keyof typeof zhCN.common; key?: string }>

export type CommandId = keyof typeof commands
