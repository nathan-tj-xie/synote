// git 视图（S12 只有引导状态）：没有 git / 版本过低 / 不是仓库 / 缺提交身份；完整面板见 S13
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitState } from '../../shared/api'
import s from './GitView.module.css'
import { useGit, useStore } from './store'

export function GitView() {
  const { t } = useTranslation()
  const root = useStore((st) => st.vault?.root)
  const state = useGit((st) => st.state)
  const load = (p: Promise<GitState | null>) =>
    p.then((v) => v && useGit.setState({ state: v })).catch((e) => useStore.getState().setError(String(e)))

  // 打开笔记库时查一次，之后靠主进程推送
  useEffect(() => void (root && load(window.synote.gitState())), [root])
  useEffect(() => window.synote.onGitChanged((v) => useGit.setState({ state: v })), [])

  if (!state) return null
  return (
    <div className={s.wrap}>
      <div className={s.title}>{t('git')}</div>
      {(state.status === 'missing' || state.status === 'tooOld') && (
        <>
          <p>{state.status === 'missing' ? t('gitMissing') : t('gitTooOld', state)}</p>
          <p className={s.muted}>{t('gitNeedVersion')}</p>
          <button className={s.primary} onClick={() => load(window.synote.redetectGit())}>
            {t('gitRedetect')}
          </button>
          <button className={s.link} onClick={() => load(window.synote.chooseGit())}>
            {t('gitChoose')}
          </button>
        </>
      )}
      {state.status === 'notRepo' && <p className={s.muted}>{t('gitNotRepo')}</p>}
      {state.status === 'ready' && (
        <>
          <p className={s.muted}>
            {t('gitVersion', state)} · {t('gitChanges', { n: state.changes })}
          </p>
          {(!state.name || !state.email) && (
            <>
              {/* 应用不代写 git 配置（ADR 0004），只给出可复制的命令 */}
              <p>{t('gitNoIdentity')}</p>
              <pre className={s.cmd}>
                {[
                  !state.name && 'git config --global user.name "Your Name"',
                  !state.email && 'git config --global user.email "you@example.com"',
                ]
                  .filter(Boolean)
                  .join('\n')}
              </pre>
              <button className={s.link} onClick={() => load(window.synote.gitState())}>
                {t('gitRedetect')}
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
