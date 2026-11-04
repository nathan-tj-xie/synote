// PROTOTYPE（#11）变体 A：VSCode 式侧栏。活动栏切到 git 视图，侧栏替换文件树；真暂存区（stage / unstage）。
import { useState } from 'react'
import { EditorArea, FileTree, GitError, GitMissing, MergeBanner, OrphanTag, Status, fileName } from './shared.jsx'

export const name = '侧栏 · 暂存区'

export function VariantA({ model, actions }) {
  const [view, setView] = useState('git')
  const [doc, setDoc] = useState(null)
  const [histOpen, setHistOpen] = useState(false)
  const staged = model.changes.filter((c) => c.staged)
  const unstaged = model.changes.filter((c) => !c.staged)
  const count = model.changes.length + model.conflicts.length

  return (
    <div className="app col">
      <MergeBanner model={model} actions={actions} />
      <div className="row grow">
        <div className="activity">
          <div className={view === 'files' ? 'on' : ''} onClick={() => setView('files')} title="文件">
            ▤
          </div>
          <div className={view === 'git' ? 'on' : ''} onClick={() => setView('git')} title="git（⌘⇧G）">
            ⑂{count > 0 && <span className="badge">{count}</span>}
          </div>
        </div>
        <div className="sidebar">
          {view === 'files' && <FileTree onOpen={setDoc} />}
          {view === 'git' && !model.gitAvailable && <GitMissing actions={actions} />}
          {view === 'git' && model.gitAvailable && (
            <div className="scm">
              <div className="pane-title">
                源代码管理
                <span className="spacer" />
                <button className="small" onClick={actions.pull} disabled={!!model.busy} title="pull">
                  ↓ {model.behind || ''}
                </button>
                <button className="small" onClick={actions.push} disabled={!!model.busy} title="push">
                  ↑ {model.ahead || ''}
                </button>
              </div>
              <div className="branch-line muted">
                ⑂ {model.branch} → {model.upstream} {model.busy && <span>· 正在 {model.busy}…</span>}
              </div>
              <GitError model={model} actions={actions} />
              <textarea
                placeholder="提交信息（⌘Enter 提交）"
                value={model.message}
                onChange={(e) => actions.setMessage(e.target.value)}
                onKeyDown={(e) => e.metaKey && e.key === 'Enter' && actions.commit('staged')}
              />
              <button
                className="primary block"
                disabled={model.scenario === 'merging'}
                onClick={() => (staged.length ? actions.commit('staged') : (actions.stageAll(), actions.commit('checked')))}
              >
                {staged.length ? `提交已暂存（${staged.length}）` : '全部暂存并提交'}
              </button>

              {model.conflicts.length > 0 && (
                <Group title="冲突" n={model.conflicts.length} warn>
                  {model.conflicts.map((p) => (
                    <div key={p} className="file" onClick={() => setDoc({ kind: 'conflict', path: p })}>
                      <span className="st st-C">!</span>
                      {fileName(p)}
                      <span className="muted dir">{p}</span>
                    </div>
                  ))}
                </Group>
              )}
              {model.resolved.length > 0 && (
                <Group title="合并改动（已解决）" n={model.resolved.length}>
                  {model.resolved.map((p) => (
                    <div key={p} className="file" onClick={() => setDoc({ kind: 'conflict', path: p })}>
                      <span className="st st-M">✓</span>
                      {fileName(p)}
                    </div>
                  ))}
                </Group>
              )}
              {staged.length > 0 && (
                <Group title="已暂存" n={staged.length}>
                  {staged.map((c) => (
                    <FileRow key={c.path} c={c} onOpen={setDoc} action="−" onAction={() => actions.unstage(c.path)} />
                  ))}
                </Group>
              )}
              {unstaged.length > 0 && (
                <Group title="更改" n={unstaged.length} extra={<button className="small" onClick={actions.stageAll}>+ 全部</button>}>
                  {unstaged.map((c) => (
                    <FileRow key={c.path} c={c} onOpen={setDoc} action="+" onAction={() => actions.stage(c.path)} />
                  ))}
                </Group>
              )}
              {model.orphans.length > 0 && (
                <Group title="将删除的孤儿附件" n={model.orphans.filter((o) => o.checked).length}>
                  {model.orphans.map((o) => (
                    <label key={o.path} className="file">
                      <input type="checkbox" checked={o.checked} onChange={() => actions.toggleOrphan(o.path)} />
                      <span onClick={() => setDoc({ kind: 'orphan', path: o.path })}>{fileName(o.path)}</span>
                      <OrphanTag o={o} />
                    </label>
                  ))}
                </Group>
              )}
              {count === 0 && model.orphans.length === 0 && <div className="muted pad">没有改动</div>}

              <div className="hist-head" onClick={() => setHistOpen(!histOpen)}>
                {histOpen ? '▾' : '▸'} 历史
              </div>
              {histOpen &&
                model.history.map((h) => (
                  <div key={h.id} className="commit" onClick={() => setDoc({ kind: 'history', path: '项目/synote/搜索方案.md', commit: h.id })}>
                    <span>{h.local ? '↑ ' : ''}{h.msg}</span>
                    <span className="muted">{h.id} · {h.when}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
        <EditorArea doc={doc} model={model} actions={actions} />
      </div>
    </div>
  )
}

function Group({ title, n, warn, extra, children }) {
  return (
    <div className="group">
      <div className={`group-title ${warn ? 'warn' : ''}`}>
        {title} <span className="count">{n}</span>
        <span className="spacer" />
        {extra}
      </div>
      {children}
    </div>
  )
}

function FileRow({ c, onOpen, action, onAction }) {
  return (
    <div className="file" onClick={() => onOpen({ kind: 'diff', path: c.path })}>
      <Status c={c} />
      {fileName(c.path)}
      <span className="muted dir">{c.from ? `← ${fileName(c.from)}` : c.path}</span>
      <span className="spacer" />
      <button
        className="small hover"
        onClick={(e) => {
          e.stopPropagation()
          onAction()
        }}
      >
        {action}
      </button>
    </div>
  )
}
