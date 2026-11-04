import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'
import s from './App.module.css'
import { installShortcuts, run } from './commands'
import { EditorPane } from './EditorPane'
import { reloadIfClean } from './editor'
import { FileTree } from './FileTree'
import { GitView } from './GitView'
import { Palette } from './Palette'
import { Search } from './Search'
import { useStore } from './store'
import { Welcome } from './Welcome'

export function App() {
  const vault = useStore((st) => st.vault)
  const error = useStore((st) => st.error)
  const sidebar = useStore((st) => st.sidebar)
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
        <button className={sidebar === 'files' ? s.activityOn : ''} title={t('files')} aria-label={t('files')} onClick={() => useStore.getState().setSidebar('files')}>
          ▤
        </button>
        <button className={sidebar === 'search' ? s.activityOn : ''} title={t('search')} aria-label={t('search')} onClick={() => run('search')}>
          ⌕
        </button>
        <button className={sidebar === 'git' ? s.activityOn : ''} title={t('git')} aria-label={t('git')} onClick={() => useStore.getState().setSidebar('git')}>
          ⑂
        </button>
      </nav>
      <Group orientation="horizontal" className={s.main}>
        <Panel defaultSize={280} minSize={160} className={s.sidebar}>
          {/* 两个视图都保持挂载，切换时不丢文件树展开状态和搜索词 */}
          <div className={s.view} hidden={sidebar !== 'files'}>
            <FileTree />
          </div>
          <div className={s.view} hidden={sidebar !== 'search'}>
            <Search />
          </div>
          <div className={s.view} hidden={sidebar !== 'git'}>
            <GitView />
          </div>
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
