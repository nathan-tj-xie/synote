import { vscodeKeymap } from '@replit/codemirror-vscode-keymap'
import { describe, expect, it } from 'vitest'
import { canon, effectiveKeys, fromMonacoLabel, monacoKeyName, parity } from './keymap'

describe('CM6 ↔ Monaco 键位对照', () => {
  for (const mac of [true, false]) {
    const table = parity(mac)
    const keys = new Set(vscodeKeymap.flatMap((b) => effectiveKeys(b, mac)))
    it(`${mac ? 'mac' : 'Windows'}：vscodeKeymap 的每个键都有对应的 Monaco 命令或写明原因的例外`, () => {
      expect([...keys].filter((k) => !table.has(k))).toEqual([])
    })
    it(`${mac ? 'mac' : 'Windows'}：表里没有 vscodeKeymap 之外的多余键`, () => {
      expect([...table.keys()].filter((k) => !keys.has(k))).toEqual([])
    })
    it(`${mac ? 'mac' : 'Windows'}：要注册的键都能换成 Monaco 键码`, () => {
      for (const [k, r] of table) if ('register' in r) for (const c of k.split(' ')) expect(monacoKeyName(c.split('-').pop()!), k).toBeDefined()
    })
  }
  it('规范写法', () => {
    expect(canon('Shift-Mod-k', true)).toBe('Shift-Cmd-k')
    expect(canon('Mod-k Mod-0', false)).toBe('Ctrl-k Ctrl-0')
    expect(canon('Mod-Shift-\\', true)).toBe('Shift-Cmd-\\')
  })
  it('Monaco 键位标签', () => {
    expect(fromMonacoLabel('cmd+k cmd+0', true)).toBe('Cmd-k Cmd-0')
    expect(fromMonacoLabel('shift+alt+down', false)).toBe('Alt-Shift-ArrowDown')
    expect(fromMonacoLabel('ctrl+shift+[', false)).toBe('Ctrl-Shift-[')
    expect(fromMonacoLabel('alt+cmd+[', true)).toBe('Alt-Cmd-[')
    expect(fromMonacoLabel('f8', false)).toBe('F8')
    expect(fromMonacoLabel('ctrl+shift+\\', false)).toBe('Ctrl-Shift-\\')
  })
})
