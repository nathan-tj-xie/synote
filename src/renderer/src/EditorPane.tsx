import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import s from './EditorPane.module.css'
import { forget, mount, show } from './editor'
import { useEditor, useUi } from './store'
import { baseName } from './tree'

export function EditorPane() {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const tabs = useEditor((st) => st.tabs)
  const active = useEditor((st) => st.active)
  const dirty = useEditor((st) => st.dirty)

  useEffect(() => mount(host.current!), [])
  useEffect(() => {
    show(active).catch((e) => useUi.getState().setError(String(e)))
  }, [active])

  const close = (p: string) => {
    forget(p)
    useEditor.getState().close(p)
  }

  return (
    <div className={s.pane}>
      <div className={s.tabs} role="tablist">
        {tabs.map((p) => (
          <div
            key={p}
            role="tab"
            aria-selected={p === active}
            title={p}
            className={`${s.tab} ${p === active ? s.on : ''}`}
            onClick={() => useEditor.getState().open(p)}
            onAuxClick={(e) => e.button === 1 && close(p)}
          >
            {baseName(p).replace(/\.md$/, '')}
            {dirty[p] && <span className={s.dot} title={t('unsaved')} />}
            <button
              className={s.close}
              aria-label={t('close')}
              onClick={(e) => {
                e.stopPropagation()
                close(p)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div ref={host} className={s.host} hidden={!active} />
      {!active && <div className={s.empty}>{t('emptyEditor')}</div>}
    </div>
  )
}
