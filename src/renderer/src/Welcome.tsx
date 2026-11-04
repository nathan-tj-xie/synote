import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import s from './Welcome.module.css'
import { useUi, useVault } from './store'

export function Welcome() {
  const { t } = useTranslation()
  const [recent, setRecent] = useState<string[] | null>(null)
  const { setVault } = useVault.getState()
  const { setError } = useUi.getState()

  const open = (p: Promise<Awaited<ReturnType<typeof window.synote.openVault>> | null>) =>
    p.then((v) => v && setVault(v)).catch((e) => setError(String(e)))

  useEffect(() => {
    window.synote.recentVaults().then((list) => {
      setRecent(list)
      // 启动时自动打开上次的笔记库
      if (list[0]) open(window.synote.openVault(list[0]))
      else window.synote.reportReady()
    })
  }, [])

  if (!recent) return null
  return (
    <div className={s.welcome}>
      <h1>{t('appName')}</h1>
      <p className={s.muted}>{t('noVault')}</p>
      <button className={s.primary} onClick={() => open(window.synote.openVaultDialog())}>
        {t('openVault')}
      </button>
      {recent.length > 0 && (
        <>
          <h2>{t('recentVaults')}</h2>
          {recent.map((r) => (
            <button key={r} className={s.recent} onClick={() => open(window.synote.openVault(r))}>
              {r}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
