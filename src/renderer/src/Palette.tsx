// 快速切换（⌘P）与命令面板（⌘⇧P）共用的组件：Radix Dialog + 虚拟列表 + fuzzysort（ADR 0005）
import * as Dialog from '@radix-ui/react-dialog'
import { useVirtualizer } from '@tanstack/react-virtual'
import fuzzysort from 'fuzzysort'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { commands, type CommandId } from '../../shared/commands'
import { available, ids, run } from './commands'
import s from './Palette.module.css'
import { formatKey, indexPaths, searchPaths, type Hit, type PathIndex } from './match'
import { useEditor, useUi, useVault } from './store'

const ROW = 28

export function Palette() {
  const mode = useUi((st) => st.palette)
  const entries = useVault((st) => st.vault?.entries)
  const index = useRef<{ entries: typeof entries; index: PathIndex } | null>(null)
  const getIndex = () => {
    if (index.current?.entries !== entries) {
      const paths = (entries ?? []).filter((e) => !e.dir).map((e) => e.path)
      index.current = { entries, index: indexPaths(paths) }
    }
    return index.current!.index
  }
  // 文件列表变化后在空闲时重建索引，打开面板时不用等
  useEffect(() => {
    const id = requestIdleCallback(getIndex)
    return () => cancelIdleCallback(id)
  }, [entries])

  const close = () => useUi.getState().setPalette(null)
  return (
    <Dialog.Root open={mode !== null} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          {mode && <Body key={mode} mode={mode} getIndex={getIndex} close={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({ mode, getIndex, close }: { mode: 'files' | 'commands'; getIndex: () => PathIndex; close: () => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 订阅可用条件读到的状态：面板打开期间关掉活动文件等，命令列表跟着变
  const vault = useVault((st) => st.vault)
  const active = useEditor((st) => st.active)
  const cmds = useMemo(
    () => ids.filter((id) => id !== 'commandPalette' && available(id)).map((id) => ({ id, title: t(commands[id].title) })),
    [t, vault, active],
  )
  const hits: Hit[] = useMemo(() => {
    if (mode === 'files') return searchPaths(query, getIndex())
    if (!query.trim()) return cmds.map((c) => ({ id: c.id, text: c.title, indexes: [] }))
    return fuzzysort.go(query, cmds, { key: 'title' }).map((r) => ({ id: r.obj.id, text: r.obj.title, indexes: r.indexes }))
  }, [mode, query, cmds, getIndex])

  const v = useVirtualizer({ count: hits.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 10 })
  useEffect(() => setSel(0), [hits])
  useEffect(() => v.scrollToIndex(sel), [sel])

  const pick = (hit: Hit | undefined) => {
    if (!hit) return
    close()
    if (mode === 'files') useEditor.getState().open(hit.id)
    else run(hit.id as CommandId)
  }

  const onKey = (e: React.KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (step) {
      e.preventDefault()
      setSel((i) => (i + step + hits.length) % Math.max(hits.length, 1))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      pick(hits[sel])
    }
  }

  const label = t(mode === 'files' ? 'quickOpen' : 'commandPalette')
  return (
    <>
      <Dialog.Title className={s.hidden}>{label}</Dialog.Title>
      <input
        className={s.input}
        autoFocus
        value={query}
        placeholder={t(mode === 'files' ? 'findFile' : 'findCommand')}
        aria-label={label}
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={hits[sel] ? `palette-${sel}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div ref={scrollRef} className={s.list} id="palette-list" role="listbox" aria-label={label}>
        {hits.length === 0 && <div className={s.empty}>{t('noMatches')}</div>}
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((row) => {
            const hit = hits[row.index]
            const key = mode === 'commands' ? (commands[hit.id as CommandId] as { key?: string }).key : undefined
            return (
              <div
                key={hit.id}
                id={`palette-${row.index}`}
                role="option"
                aria-selected={row.index === sel}
                className={`${s.row} ${row.index === sel ? s.on : ''}`}
                style={{ transform: `translateY(${row.start}px)` }}
                onMouseMove={() => setSel(row.index)}
                onClick={() => pick(hit)}
              >
                <span className={s.text}>{highlight(hit)}</span>
                {key && <kbd className={s.key}>{formatKey(key)}</kbd>}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function highlight({ text, indexes }: Hit) {
  if (!indexes.length) return text
  const on = new Set(indexes)
  // fuzzysort 的 indexes 按 UTF-16 码元计
  return text.split('').map((c, i) => (on.has(i) ? <mark key={i}>{c}</mark> : c))
}
