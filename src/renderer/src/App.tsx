import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, Panel, Separator } from 'react-resizable-panels'
import s from './App.module.css'
import { installShortcuts, run } from './commands'
import { EditorPane } from './EditorPane'
import { EmbedEditor } from './EmbedEditor'
import { reloadIfClean } from './editor'
import { FileTree } from './FileTree'
import { GitView } from './GitView'
import { Icon } from './Icon'
import { MergeBanner, MergeConfirm } from './Merge'
import { Orphans } from './Orphans'
import { Palette } from './Palette'
import { Rename } from './Rename'
import { Search } from './Search'
import { useGit, useUi, useVault } from './store'
import { Welcome } from './Welcome'

export function App() {
  const vault = useVault((st) => st.vault)
  const error = useUi((st) => st.error)
  const sidebar = useUi((st) => st.sidebar)
  const changes = useGit((st) => (st.state?.status === 'ready' ? st.state.files.length : 0))
  const { t } = useTranslation()

  useEffect(
    () =>
      window.synote.onVaultChanged(({ root, entries, changed }) => {
        const v = useVault.getState().vault
        if (v?.root !== root) return // 别的库（切库前）迟到的事件
        useVault.getState().setVault({ ...v, entries })
        changed.forEach(reloadIfClean)
      }),
    [],
  )
  useEffect(installShortcuts, [])

  if (!vault) return <Welcome />
  return (
    <div className={s.shell}>
      <MergeBanner />
      <div className={s.app}>
        <nav className={s.activity}>
          <button className={sidebar === 'files' ? s.activityOn : ''} title={t('files')} aria-label={t('files')} onClick={() => useUi.getState().setSidebar('files')}>
            <Icon name="files" />
          </button>
          <button className={sidebar === 'search' ? s.activityOn : ''} title={t('search')} aria-label={t('search')} onClick={() => run('search')}>
            <Icon name="search" />
          </button>
          <button className={sidebar === 'git' ? s.activityOn : ''} title={t('git')} aria-label={t('git')} onClick={() => useUi.getState().setSidebar('git')}>
            <Icon name="git" />{changes > 0 && <span className={s.badge}>{changes > 999 ? '999+' : changes}</span>}
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
        <Orphans />
        <Rename />
        <MergeConfirm />
        <EmbedEditor />
        {error && (
          <div className={s.error} role="alert" onClick={() => useUi.getState().setError(null)}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
