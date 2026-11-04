import { hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import s from './FileTree.module.css'
import { handlers, run } from './commands'
import { useStore } from './store'
import { baseName, buildChildren, ROOT } from './tree'

const ROW = 24

export function FileTree() {
  const { t } = useTranslation()
  const vault = useStore((st) => st.vault)!
  const active = useStore((st) => st.active)
  const children = useMemo(() => buildChildren(vault.entries), [vault.entries])
  const dirs = useMemo(() => new Set(vault.entries.filter((e) => e.dir).map((e) => e.path)), [vault.entries])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(null)

  const tree = useTree<string>({
    rootItemId: ROOT,
    getItemName: (item) => baseName(item.getId()),
    isItemFolder: (item) => dirs.has(item.getId()),
    dataLoader: { getItem: (id) => id, getChildren: (id) => children.get(id) ?? [] },
    scrollToItem: (item) => virtualizer.current?.scrollToIndex(item.getItemMeta().index),
    onPrimaryAction: (item) => !item.isFolder() && useStore.getState().open(item.getId()),
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  })
  useEffect(() => tree.rebuildTree(), [children])

  const items = tree.getItems()
  const v = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 20 })
  virtualizer.current = v

  // 首屏耗时打点：文件树第一次画出来
  useEffect(() => {
    requestAnimationFrame(() => window.synote.reportReady())
  }, [])

  const onMenu = async (path: string, dir: boolean) => {
    const action = await window.synote.showItemMenu(path, dir)
    if (action) handlers[action].run(path)
  }

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <span className={s.title}>{vault.name}</span>
        <button className={s.icon} title={t('newNote')} aria-label={t('newNote')} onClick={() => run('newNote')}>
          ＋
        </button>
      </div>
      <div ref={scrollRef} className={s.scroll}>
        <div {...tree.getContainerProps(t('files'))} style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((row) => {
            const item = items[row.index]
            const props = item.getProps()
            const id = item.getId()
            return (
              <div
                {...props}
                key={id}
                className={`${s.row} ${id === active ? s.active : ''} ${item.isFocused() ? s.focused : ''}`}
                style={{ transform: `translateY(${row.start}px)`, paddingLeft: 8 + item.getItemMeta().level * 14 }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onMenu(id, item.isFolder())
                }}
              >
                <span className={s.chev} aria-hidden>{item.isFolder() ? (item.isExpanded() ? '▾' : '▸') : ''}</span>
                {item.getItemName()}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
