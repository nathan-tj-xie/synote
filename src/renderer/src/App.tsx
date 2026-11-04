import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'
import s from './App.module.css'
import { installShortcuts } from './commands'
import { EditorPane } from './EditorPane'
import { reloadIfClean } from './editor'
import { FileTree } from './FileTree'
import { Palette } from './Palette'
import { useStore } from './store'
import { Welcome } from './Welcome'

export function App() {
  const vault = useStore((st) => st.vault)
  const error = useStore((st) => st.error)
  const { t } = useTranslation()

  useEffect(
    () =>
      window.synote.onVaultChanged(({ entries, changed }) => {
        const v = useStore.getState().vault
        if (v) useStore.getState().setVault({ ...v, entries })
        changed.forEach(reloadIfClean)
      }),
    [],
  )
  useEffect(installShortcuts, [])

  if (!vault) return <Welcome />
  return (
    <div className={s.app}>
      <nav className={s.activity}>
        <button className={s.activityOn} title={t('files')} aria-label={t('files')}>
          ▤
        </button>
      </nav>
      <Group orientation="horizontal" className={s.main}>
        <Panel defaultSize={280} minSize={160} className={s.sidebar}>
          <FileTree />
        </Panel>
        <Separator className={s.separator} />
        <Panel minSize={300}>
          <EditorPane />
        </Panel>
      </Group>
      <Palette />
      {error && (
        <div className={s.error} role="alert" onClick={() => useStore.getState().setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}
