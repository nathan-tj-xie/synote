// 历史栏（S15）：当前笔记的 git log --follow（跨重命名）。点提交进入「该版本 ↔ 当前」对比，再点一次回到正文；
// 有新提交（git:changed，只认当前库）后重新查询
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LogEntry } from '../../shared/api'
import { compareWith } from './editor'
import s from './History.module.css'
import { useEditor, useGit, useUi, useVault } from './store'

export function History({ path }: { path: string }) {
  const { t } = useTranslation()
  const root = useVault((st) => st.vault!.root)
  const ready = useGit((st) => st.state?.status === 'ready')
  const notRepo = useGit((st) => st.state?.status === 'notRepo')
  const rev = useEditor((st) => st.compare[path])
  const [log, setLog] = useState<LogEntry[]>([])
  const [stamp, setStamp] = useState(0)

  useEffect(() => window.synote.onGitChanged((e) => e.root === useVault.getState().vault?.root && setStamp((n) => n + 1)), [])
  useEffect(() => {
    if (!ready) return setLog([])
    let stale = false // 只保留当前笔记最后一次查询的结果
    window.synote.fileLog(root, path).then(
      (r) => !stale && setLog(r),
      (e) => {
        if (stale) return
        setLog([])
        useUi.getState().setError(String(e))
      },
    )
    return () => {
      stale = true
    }
  }, [root, path, stamp, ready])

  return (
    <aside className={s.panel} aria-label={t('history')}>
      <h2 className={s.title}>{t('history')}</h2>
      {!ready && <div className={s.empty}>{t(notRepo ? 'gitNotRepo' : 'gitUnavailable')}</div>}
      {ready && log.length === 0 && <div className={s.empty}>{t('noHistory')}</div>}
      <CommitList log={log} rev={rev} path={path} onPick={(e) => compareWith(path, e)} />
    </aside>
  )
}

// 提交列表：历史栏和 git 面板底部的仓库历史（S13）共用。rev 是选中的提交；
// e.path 与 path 不同（改过名）时多显示一行路径，仓库历史不传 path
export function CommitList({ log, rev, path, onPick }: { log: LogEntry[]; rev?: string; path?: string; onPick: (e: LogEntry) => void }) {
  return (
    <ul className={s.list}>
      {log.map((e) => (
        <li key={e.hash}>
          <button className={`${s.item} ${rev === e.hash ? s.on : ''}`} aria-pressed={rev === e.hash} title={e.hash} onClick={() => onPick(e)}>
            <span className={s.subject}>{e.subject}</span>
            <span className={s.meta}>
              {e.hash.slice(0, 7)} · {new Date(e.time * 1000).toLocaleString('zh-CN')} · {e.author}
            </span>
            {path !== undefined && e.path !== path && <span className={s.meta}>{e.path}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
