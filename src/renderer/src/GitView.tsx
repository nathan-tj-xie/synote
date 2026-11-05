// git 视图（S12 引导状态，S13 面板，#11 方案 A）：分支与 push / pull、提交框、已暂存 / 更改 / 将删除的孤儿附件、底部折叠的仓库历史。
// 没有 git / 版本过低 / 不是仓库时显示引导；git 操作失败时内联错误卡片
import * as Dialog from '@radix-ui/react-dialog'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitErrorKind, GitFile, GitOpResult, GitState, LogEntry, OrphanAttachment } from '../../shared/api'
import { attachmentsSettled, compareWith, flushAll, openDiff, withWorktreeLock } from './editor'
import s from './GitView.module.css'
import { CommitList } from './History'
import { isMac } from './match'
import { reportKept } from './Orphans'
import { useEditor, useGit, useUi, useVault } from './store'
import { baseName } from './tree'

type Ready = Extract<GitState, { status: 'ready' }>
type Op = 'commit' | 'push' | 'pull' | 'stage' | 'unstage'
type Card = Extract<GitOpResult, { ok: false }> & { op: Op }

const fail = (e: unknown) => useUi.getState().setError(String(e))
const load = (p: Promise<GitState | null>) => p.then((v) => v && useGit.setState({ state: v })).catch(fail)

export function GitView() {
  const { t } = useTranslation()
  const root = useVault((st) => st.vault?.root)
  const state = useGit((st) => st.state)

  // 打开笔记库时查一次，之后靠主进程推送
  useEffect(() => void (root && load(window.synote.gitState())), [root])
  useEffect(() => window.synote.onGitChanged((e) => e.root === useVault.getState().vault?.root && useGit.setState({ state: e.state })), [])

  if (!state || !root) return null
  return (
    <div className={s.wrap}>
      {state.status === 'ready' ? (
        <Panel key={root} root={root} state={state} />
      ) : (
        <div className={s.guide}>
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
        </div>
      )}
    </div>
  )
}

// key 为笔记库：换库时提交信息、错误卡片、勾选状态全部重置
function Panel({ root, state }: { root: string; state: Ready }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<Op | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const [orphans, setOrphans] = useState<OrphanAttachment[]>([])
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [deleted, setDeleted] = useState<{ path: string; head: string; mod: typeof import('./diff') } | null>(null)
  const staged = useMemo(() => state.files.filter((f) => f.x !== '.' && f.x !== '?'), [state.files])
  const unstaged = useMemo(() => state.files.filter((f) => f.y !== '.'), [state.files])
  const checked = orphans.filter((o) => !unchecked.has(o.path)).map((o) => o.path)
  const noIdentity = !state.name || !state.email

  // 孤儿清单以落盘内容为准（listOrphans 先对账）：git 状态变了、索引有变化时重取，只留最后一次的结果
  const seq = useRef(0)
  const refreshOrphans = () => {
    const my = ++seq.current
    window.synote.listOrphans(root).then((l) => my === seq.current && setOrphans(l), fail)
  }
  useEffect(refreshOrphans, [state])
  useEffect(() => window.synote.onIndexChanged((e) => e.root === root && e.paths.length > 0 && refreshOrphans()), [root])

  // 一次只跑一个操作；期间换了库（组件已卸载）就丢掉结果
  const run = async (op: Op, f: () => Promise<GitOpResult>) => {
    if (busy) return
    setBusy(op)
    setCard(null)
    try {
      const res = await f()
      if (useVault.getState().vault?.root !== root) return
      if (!res.ok) setCard({ ...res, op })
      if (res.done.kept?.length) reportKept(res.done.kept)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
      load(window.synote.gitState())
      refreshOrphans()
    }
  }
  // 先把在途的附件插完、所有未保存的正文落盘（写不进去就中止），提交的才是编辑器里看到的内容
  const commit = () =>
    run('commit', async () => {
      await attachmentsSettled()
      if (!(await flushAll())) throw new Error(t('gitCommitUnsaved'))
      const res = await window.synote.gitCommit(root, message, staged.length === 0, checked)
      if (res.ok) setMessage('')
      return res
    })
  // pull 会改写工作区：先落盘（本地改动和远端冲突时 git 会拒绝），期间编辑器只读，结束后按磁盘重载已打开的笔记
  const pull = () => run('pull', () => withWorktreeLock(t('gitPullUnsaved'), () => window.synote.gitPull(root)))
  const push = () => run('push', () => window.synote.gitPush(root))
  const stage = (paths: string[] | null) => run('stage', () => window.synote.gitStage(root, paths))
  // 重命名要连同旧路径一起取消暂存；旧路径在库外时只取消新路径
  const unstage = (f: GitFile) => run('unstage', () => window.synote.gitUnstage(root, [f.path, ...(f.orig && !f.orig.startsWith('../') ? [f.orig] : [])]))
  // 删除的笔记：读 HEAD 里的正文，只读展示
  const openDeleted = (path: string) =>
    Promise.all([import('./diff'), window.synote.readRev(root, 'HEAD', path)]).then(
      ([mod, b]) => useVault.getState().vault?.root === root && setDeleted({ path, head: b ? new TextDecoder().decode(b) : '', mod }),
      fail,
    )
  const canCommit = !busy && !noIdentity && !!message.trim() && (state.files.length > 0 || checked.length > 0)

  return (
    <>
      <div className={s.head}>
        <span className={s.title}>{t('git')}</span>
        <button className={s.small} aria-label={t('gitPull')} title={t('gitPull')} disabled={!!busy || !state.upstream} onClick={pull}>
          ↓ {state.behind || ''}
        </button>
        <button className={s.small} aria-label={t('gitPush')} title={t('gitPush')} disabled={!!busy || !state.branch} onClick={push}>
          ↑ {state.ahead || ''}
        </button>
      </div>
      <div className={s.top}>
        <div className={s.muted}>
          ⑂ {state.branch ?? t('gitDetached')} → {state.upstream ?? t('gitNoUpstream')}
          {busy && ` · ${t('gitBusy', { op: t(`gitOp_${busy}`) })}`}
        </div>
        {/* LFS（S17）：附件走 LFS 却没装 git-lfs、或 status 因 LFS filter 失败时，非模态提示，git 面板其余照常 */}
        {(state.lfsError || state.lfsUsed) && (
          <ErrorCard
            kind={state.lfsError?.kind ?? 'lfsMissing'}
            raw={state.lfsError?.raw}
            commands={state.lfsError?.kind === 'lfsFilter' ? [] : lfsCommands}
            onRetry={() => load(window.synote.redetectGit())}
            retryLabel={t('gitRedetect')}
          />
        )}
        {noIdentity && (
          <ErrorCard kind="noIdentity" commands={identityCommands(state)} onRetry={() => load(window.synote.gitState())} retryLabel={t('gitRedetect')} />
        )}
        {card && (
          <ErrorCard
            kind={card.kind}
            title={t('gitFailed', { op: t(`gitOp_${card.op}`) })}
            done={[
              card.done.deleted ? t('gitDoneOrphans', { n: card.done.deleted }) : '',
              card.done.staged ? t('gitDoneStaged') : '',
              card.op === 'commit' ? t('gitNotCommitted') : '',
            ].filter(Boolean)}
            raw={card.outside ? undefined : card.raw}
            paths={card.outside?.paths}
            commands={card.kind === 'noIdentity' ? identityCommands({ name: null, email: null }) : commandsFor(card)}
            onPull={card.kind === 'nonFastForward' ? pull : undefined}
            onRetry={card.op === 'push' ? push : card.op === 'pull' ? pull : undefined}
            onClose={() => setCard(null)}
          />
        )}
        <textarea
          className={s.message}
          aria-label={t('gitMessage')}
          placeholder={t('gitMessage')}
          value={message}
          rows={3}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(isMac ? e.metaKey : e.ctrlKey)) return
            e.preventDefault()
            if (canCommit) commit()
          }}
        />
        <button className={`${s.primary} ${s.block}`} disabled={!canCommit} onClick={commit}>
          {staged.length ? t('gitCommitStaged', { n: staged.length }) : t('gitCommitAll')}
        </button>
      </div>
      <Changes
        staged={staged}
        unstaged={unstaged}
        orphans={orphans}
        unchecked={unchecked}
        busy={!!busy}
        onOpenDeleted={openDeleted}
        onStage={stage}
        onUnstage={unstage}
        onToggle={(p) =>
          setUnchecked((u) => {
            const n = new Set(u)
            if (!n.delete(p)) n.add(p)
            return n
          })
        }
      />
      <RepoHistory root={root} state={state} />
      <DeletedDiff file={deleted} onClose={() => setDeleted(null)} />
    </>
  )
}

const identityCommands = (st: { name: string | null; email: string | null }) =>
  [!st.name && 'git config --global user.name "Your Name"', !st.email && 'git config --global user.email "you@example.com"'].filter((c): c is string => !!c)

// 安装 git-lfs：macOS 用 Homebrew（装完还要 git lfs install 写 filter 配置）；其它平台给官网（Git for Windows 默认自带）
const lfsCommands = isMac ? ['brew install git-lfs', 'git lfs install'] : ['https://git-lfs.com']

// 给 shell 用的单引号转义
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function commandsFor(card: Card): string[] {
  if (card.outside) return [`git -C ${sq(card.outside.top)} --literal-pathspecs reset -q -- ${card.outside.paths.map(sq).join(' ')}`]
  if (card.kind === 'noCredentials') return [`git ${card.op}`]
  if (card.kind === 'conflict') return ['git merge --abort']
  if (card.kind === 'lfsMissing') return lfsCommands
  return []
}

// 错误卡片：原因、已完成到哪一步、可复制的命令、下一步按钮；git 原始输出默认折叠
function ErrorCard(p: {
  kind: GitErrorKind
  title?: string
  paths?: string[]
  done?: string[]
  raw?: string
  commands: string[]
  onPull?: () => void
  onRetry?: () => void
  retryLabel?: string
  onClose?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={s.card} role="alert">
      {p.title && <div className={s.cardTitle}>{p.title}</div>}
      <div>{t(`gitErr_${p.kind}`)}</div>
      {p.paths && (
        <ul className={s.paths}>
          {p.paths.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {p.done && p.done.length > 0 && <div className={s.muted}>{p.done.join('；')}</div>}
      {p.commands.map((c) => (
        <div key={c} className={s.cmdRow}>
          <code className={s.cmd}>{c}</code>
          <button className={s.small} onClick={() => navigator.clipboard.writeText(c).catch(fail)}>
            {t('gitCopy')}
          </button>
        </div>
      ))}
      {p.raw && (
        <details className={s.raw}>
          <summary>{t('gitRaw')}</summary>
          <pre>{p.raw}</pre>
        </details>
      )}
      <div className={s.actions}>
        {p.onPull && (
          <button className={s.primary} onClick={p.onPull}>
            {t('gitPullFirst')}
          </button>
        )}
        {p.onRetry && <button onClick={p.onRetry}>{p.retryLabel ?? t('gitRetry')}</button>}
        {p.onClose && <button onClick={p.onClose}>{t('gitDismiss')}</button>}
      </div>
    </div>
  )
}

type Group = 'staged' | 'unstaged' | 'orphans'
type Row = { group: Group; n: number } | { file: GitFile; staged: boolean } | { orphan: OrphanAttachment }
const ROW = 22

// 三个分组拍平成一个虚拟列表（1k 改动时只渲染可见的几十行，ADR 0005）
function Changes(p: {
  staged: GitFile[]
  unstaged: GitFile[]
  orphans: OrphanAttachment[]
  unchecked: ReadonlySet<string>
  busy: boolean
  onOpenDeleted: (path: string) => void
  onStage: (paths: string[] | null) => void
  onUnstage: (f: GitFile) => void
  onToggle: (path: string) => void
}) {
  const { t } = useTranslation()
  const scroll = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    const out: Row[] = []
    if (p.staged.length) out.push({ group: 'staged', n: p.staged.length }, ...p.staged.map((file) => ({ file, staged: true })))
    if (p.unstaged.length) out.push({ group: 'unstaged', n: p.unstaged.length }, ...p.unstaged.map((file) => ({ file, staged: false })))
    if (p.orphans.length) out.push({ group: 'orphans', n: p.orphans.filter((o) => !p.unchecked.has(o.path)).length }, ...p.orphans.map((orphan) => ({ orphan })))
    return out
  }, [p.staged, p.unstaged, p.orphans, p.unchecked])
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => ROW, overscan: 10 })

  return (
    <div ref={scroll} className={s.changes} aria-label={t('gitChanges', { n: p.staged.length + p.unstaged.length })}>
      {rows.length === 0 && <div className={s.empty}>{t('gitNoChanges')}</div>}
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => {
          const r = rows[it.index]
          const style = { transform: `translateY(${it.start}px)` }
          if ('group' in r)
            return (
              <div key={r.group} className={`${s.row} ${s.groupRow}`} style={style}>
                <span className={s.grow}>
                  {t(r.group === 'staged' ? 'gitStaged' : r.group === 'unstaged' ? 'gitUnstaged' : 'gitOrphans')} <span className={s.count}>{r.n}</span>
                </span>
                {r.group === 'unstaged' && (
                  <button className={s.small} disabled={p.busy} onClick={() => p.onStage(null)}>
                    {t('gitStageAll')}
                  </button>
                )}
              </div>
            )
          if ('orphan' in r)
            return (
              <label key={`o:${r.orphan.path}`} className={s.row} style={style} title={r.orphan.path}>
                <input type="checkbox" checked={!p.unchecked.has(r.orphan.path)} onChange={() => p.onToggle(r.orphan.path)} />
                <span className={s.name}>{baseName(r.orphan.path)}</span>
                <span className={s.tag}>{t(r.orphan.tracked ? 'orphanGitRm' : 'orphanTrash')}</span>
              </label>
            )
          const f = r.file
          const st = r.staged ? f.x : f.y === '?' ? 'U' : f.y
          // 只有笔记能打开对比；删除的笔记工作区里没有，单独只读展示
          const openable = f.path.endsWith('.md')
          return (
            <div
              key={`${r.staged ? 's' : 'u'}:${f.path}`}
              className={`${s.row} ${openable ? s.openable : ''}`}
              style={style}
              title={f.orig ? `${f.orig} → ${f.path}` : f.path}
              onClick={() => openable && (st === 'D' ? p.onOpenDeleted(f.path) : openDiff(f.path))}
            >
              <span className={`${s.st} ${s[`st${st}`] ?? ''}`}>{st}</span>
              <span className={s.name}>{baseName(f.path)}</span>
              <span className={s.dir}>{f.orig ? `← ${baseName(f.orig)}` : f.path.slice(0, -baseName(f.path).length)}</span>
              <button
                className={`${s.small} ${s.act}`}
                aria-label={t(r.staged ? 'gitUnstage' : 'gitStage')}
                title={t(r.staged ? 'gitUnstage' : 'gitStage')}
                disabled={p.busy}
                onClick={(e) => {
                  e.stopPropagation()
                  if (r.staged) p.onUnstage(f)
                  else p.onStage([f.path])
                }}
              >
                {r.staged ? '−' : '+'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 底部折叠的仓库历史：展开时查询，git 状态变了（提交、pull 等）再查；点提交让当前笔记与该提交里的版本对比
function RepoHistory({ root, state }: { root: string; state: Ready }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const active = useEditor((st) => st.active)
  const rev = useEditor((st) => (active ? st.compare[active] : undefined))
  useEffect(() => {
    if (!open) return
    let stale = false
    window.synote.repoLog(root).then((l) => !stale && setLog(l), fail)
    return () => {
      stale = true
    }
  }, [open, root, state])

  return (
    <div className={`${s.history} ${open ? s.historyOpen : ''}`}>
      <button className={s.historyHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {t('history')}
      </button>
      {open && (
        <div className={s.historyList} title={t('gitHistoryHint')}>
          {log.length === 0 && <div className={s.empty}>{t('noHistory')}</div>}
          <CommitList log={log} rev={rev} onPick={(e) => active?.endsWith('.md') && compareWith(active, { ...e, path: active })} />
        </div>
      )}
    </div>
  )
}

// 删除对比（只读）：左 HEAD 正文、右空。不能在这里编辑"复活"文件，要恢复走 git restore 或新建
function DeletedDiff({ file, onClose }: { file: { path: string; head: string; mod: typeof import('./diff') } | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useEffect(() => (file && box ? file.mod.showDeleted(box, file.head) : undefined), [file, box])
  return (
    <Dialog.Root open={file !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Content className={s.deleted} aria-describedby={undefined}>
          <Dialog.Title className={s.deletedTitle}>{file && t('gitDeletedDiff', { path: file.path })}</Dialog.Title>
          <div ref={setBox} className={s.deletedBody} />
          <Dialog.Close className={s.small}>{t('close')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
