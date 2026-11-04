import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import s from './Welcome.module.css'
import { useUi } from './store'
import { openVault } from './vaults'

export function Welcome() {
  const { t } = useTranslation()
  const [recent, setRecent] = useState<string[] | null>(null)
  const { setError } = useUi.getState()

  // 选目录和最近列表走同一条交接路径
  const open = (dir: Promise<string | null>) => dir.then((d) => (d ? openVault(d) : undefined)).catch((e) => setError(String(e)))

  useEffect(() => {
    window.synote.recentVaults().then((list) => {
      setRecent(list)
      // 启动时自动打开上次的笔记库
      if (list[0]) open(Promise.resolve(list[0]))
      else window.synote.reportReady()
    })
  }, [])

  if (!recent) return null
  return (
    <div className={s.welcome}>
      <h1>{t('appName')}</h1>
      <p className={s.muted}>{t('noVault')}</p>
      <button className={s.primary} onClick={() => open(window.synote.pickVault())}>
        {t('openVault')}
      </button>
      {recent.length > 0 && (
        <>
          <h2>{t('recentVaults')}</h2>
          {recent.map((r) => (
            <button key={r} className={s.recent} onClick={() => open(Promise.resolve(r))}>
              {r}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
