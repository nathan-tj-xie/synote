// 合并中横幅（S16，#9 决定 2）：窗口顶部，冲突清空前"完成合并"不可点；"放弃合并"二次确认后 git merge --abort
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitOpResult } from '../../shared/api'
import { attachmentsSettled, flushAll, withWorktreeLock } from './editor'
import s from './Merge.module.css'
import d from './Orphans.module.css'
import { useGit, useUi, useVault } from './store'

export function MergeBanner() {
  const { t } = useTranslation()
  const root = useVault((st) => st.vault?.root)
  const conflicts = useGit((st) => (st.state?.status === 'ready' && st.state.merging ? st.state.files.filter((f) => f.conflict).length : null))
  // 缺身份时同提交一样禁用（ADR 0004），引导在 git 面板的身份卡片里
  const noIdentity = useGit((st) => st.state?.status === 'ready' && (!st.state.name || !st.state.email))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  if (conflicts === null || !root) return null

  const run = async (op: 'mergeFinish' | 'mergeAbort', f: () => Promise<GitOpResult>) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await f()
      if (!res.ok && useVault.getState().vault?.root === root) {
        const reason = [t(`gitErr_${res.kind}`), ...(res.paths ?? (res.raw ? [res.raw] : []))].join('\n')
        useUi.getState().setError(t('mergeFailed', { op: t(op), reason }))
      }
    } catch (e) {
      useUi.getState().setError(String(e))
    } finally {
      setBusy(false)
      window.synote.gitState().then((v) => useVault.getState().vault?.root === root && useGit.setState({ state: v }), () => {})
    }
  }
  // 先让最后的输入落盘：冲突文件靠保存触发自动 git add
  const finish = () =>
    run('mergeFinish', async () => {
      await attachmentsSettled()
      if (!(await flushAll())) throw new Error(t('mergeUnsaved'))
      return window.synote.gitMergeContinue(root)
    })
  // 会改写工作区：期间编辑器只读，结束后按磁盘重载已打开的笔记
  const abort = () => {
    setConfirm(false)
    run('mergeAbort', () => withWorktreeLock(t('mergeUnsaved'), () => window.synote.gitMergeAbort(root)))
  }

  return (
    <section className={s.banner} aria-label={t('merging')}>
      <span className={s.text}>{conflicts ? t('mergingConflicts', { n: conflicts }) : t('mergingResolved')}</span>
      <button className={s.primary} disabled={busy || conflicts > 0 || noIdentity} title={noIdentity ? t('mergeNoIdentity') : undefined} onClick={finish}>
        {t('mergeFinish')}
      </button>
      <AlertDialog.Root open={confirm} onOpenChange={setConfirm}>
        <AlertDialog.Trigger className={s.ghost} disabled={busy}>
          {t('mergeAbort')}
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={d.overlay} />
          <AlertDialog.Content className={d.content}>
            <AlertDialog.Title className={d.title}>{t('mergeAbortTitle')}</AlertDialog.Title>
            <AlertDialog.Description className={d.muted}>{t('mergeAbortHint')}</AlertDialog.Description>
            <div className={d.actions}>
              <AlertDialog.Cancel>{t('cancel')}</AlertDialog.Cancel>
              <AlertDialog.Action className={s.danger} onClick={abort}>
                {t('mergeAbort')}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  )
}
