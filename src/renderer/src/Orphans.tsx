// "清理孤儿附件"确认框（S11）：列出清单和每项的删除方式，确认后交给主进程复核并删除
import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitDone } from '../../shared/api'
import { i18next } from '../../shared/i18n'
import s from './Orphans.module.css'
import { useUi } from './store'

// 为保险没删的孤儿附件告诉用户（清理命令和 git 面板的提交共用）
export function reportKept(kept: NonNullable<GitDone['kept']>) {
  const msg = (['pending', 'mentioned', 'staged'] as const)
    .map((reason) => [reason, kept.filter((k) => k.reason === reason).map((k) => k.path)] as const)
    .filter(([, ps]) => ps.length)
    .map(([reason, ps]) => i18next.t(reason === 'pending' ? 'orphansPending' : reason === 'staged' ? 'orphansStaged' : 'orphansKept', { paths: ps.join('、') }))
  if (msg.length) useUi.getState().setError(msg.join('\n'))
}

export function Orphans() {
  const { t } = useTranslation()
  const orphans = useUi((st) => st.orphans)
  const [busy, setBusy] = useState(false)
  const close = () => useUi.getState().setOrphans(null)
  const confirm = async () => {
    if (!orphans) return
    setBusy(true)
    try {
      const { kept } = await window.synote.deleteOrphans(orphans.root, orphans.list.map((o) => o.path))
      close()
      reportKept(kept)
    } catch (e) {
      useUi.getState().setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const n = orphans?.list.length ?? 0
  return (
    <Dialog.Root open={orphans !== null} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <Dialog.Title className={s.title}>{t('cleanOrphans')}</Dialog.Title>
          <p className={s.muted}>{n ? t('orphansHint') : t('noOrphans')}</p>
          {n > 0 && (
            <ul className={s.list}>
              {orphans!.list.map((o) => (
                <li key={o.path}>
                  <span className={s.path}>{o.path}</span>
                  <span className={s.muted}>{t(o.tracked ? 'orphanGitRm' : 'orphanTrash')}</span>
                </li>
              ))}
            </ul>
          )}
          <div className={s.actions}>
            <Dialog.Close>{t(n ? 'cancel' : 'close')}</Dialog.Close>
            {n > 0 && (
              <button className={s.primary} disabled={busy} onClick={confirm}>
                {t('deleteOrphans', { n })}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
