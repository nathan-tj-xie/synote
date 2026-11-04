// PROTOTYPE（#11）变体 B：状态栏 + 全窗口"提交审阅"页。平时只占状态栏；勾选要提交的文件（无暂存区概念），左列表右 diff。
import { useState } from 'react'
import { EditorArea, FileTree, GitError, GitMissing, MergeBanner, OrphanTag, Status, fileName } from './shared.jsx'

export const name = '状态栏 + 审阅页 · 勾选提交'

export function VariantB({ model, actions }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('changes')
  const [doc, setDoc] = useState(null)
  const [sel, setSel] = useState(null)
  const count = model.changes.length + model.conflicts.length + model.orphans.length
  const picked = model.changes.filter((c) => c.checked).length + model.orphans.filter((o) => o.checked).length

  return (
    <div className="app col">
      <MergeBanner model={model} actions={actions} />
      <div className="row grow">
        <div className="sidebar">
          <FileTree onOpen={setDoc} />
        </div>
        <EditorArea doc={doc} model={model} actions={actions} />
      </div>

      <div className="statusbar">
        {model.gitAvailable ? (
          <>
            <span className="chip">⑂ {model.branch}</span>
            <span className="chip" onClick={actions.pull} title="pull">
              ↓{model.behind}
            </span>
            <span className="chip" onClick={actions.push} title="push">
              ↑{model.ahead}
            </span>
            {model.busy && <span className="muted">正在 {model.busy}…</span>}
            <span className={`chip ${count ? 'accent' : ''}`} onClick={() => setOpen(true)}>
              ● {count ? `${count} 处更改，审阅并提交（⌘⇧G）` : '无更改 · 历史'}
            </span>
            {model.error && (
              <span className="chip danger" onClick={() => setOpen(true)}>
                ⚠ {model.error.title}
              </span>
            )}
          </>
        ) : (
          <span className="chip danger" onClick={() => setOpen(true)}>
            ⚠ 未找到 git，版本管理不可用
          </span>
        )}
      </div>

      {open && (
        <div className="overlay">
          <div className="overlay-head">
            <div className={`tab ${tab === 'changes' ? 'on' : ''}`} onClick={() => setTab('changes')}>
              更改 {count}
            </div>
            <div className={`tab ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>
              历史
            </div>
            <span className="spacer" />
            <span className="muted">
              {model.branch} → {model.upstream} · ↑{model.ahead} ↓{model.behind}
            </span>
            <button onClick={actions.pull} disabled={!!model.busy}>Pull</button>
            <button onClick={actions.push} disabled={!!model.busy}>Push</button>
            <button onClick={() => setOpen(false)}>关闭</button>
          </div>
          {!model.gitAvailable ? (
            <div className="pad">
              <GitMissing actions={actions} />
            </div>
          ) : (
            <div className="row grow">
              <div className="review-list">
                <GitError model={model} actions={actions} />
                {tab === 'changes' && (
                  <>
                    {model.conflicts.length > 0 && <div className="group-title warn">冲突 {model.conflicts.length}</div>}
                    {model.conflicts.map((p) => (
                      <div key={p} className={`file ${sel?.path === p ? 'sel' : ''}`} onClick={() => setSel({ kind: 'conflict', path: p })}>
                        <span className="st st-C">!</span>
                        {p}
                      </div>
                    ))}
                    {model.changes.length > 0 && <div className="group-title">笔记 {model.changes.length}</div>}
                    {model.changes.map((c) => (
                      <label key={c.path} className={`file ${sel?.path === c.path ? 'sel' : ''}`}>
                        <input type="checkbox" checked={c.checked} onChange={() => actions.toggleChecked(c.path)} />
                        <Status c={c} />
                        <span onClick={() => setSel({ kind: 'diff', path: c.path })}>
                          {c.path}
                          {c.from && <span className="muted"> ← {fileName(c.from)}</span>}
                        </span>
                      </label>
                    ))}
                    {model.orphans.length > 0 && <div className="group-title">将删除的孤儿附件 {model.orphans.length}</div>}
                    {model.orphans.map((o) => (
                      <label key={o.path} className={`file ${sel?.path === o.path ? 'sel' : ''}`}>
                        <input type="checkbox" checked={o.checked} onChange={() => actions.toggleOrphan(o.path)} />
                        <span onClick={() => setSel({ kind: 'orphan', path: o.path })}>{fileName(o.path)}</span>
                        <span className="muted">{o.size}</span>
                        <OrphanTag o={o} />
                      </label>
                    ))}
                    {count === 0 && <div className="muted pad">没有改动</div>}
                    <div className="composer">
                      <textarea
                        placeholder="提交信息"
                        value={model.message}
                        onChange={(e) => actions.setMessage(e.target.value)}
                      />
                      <div className="row">
                        <button className="primary" disabled={model.scenario === 'merging'} onClick={() => actions.commit('checked')}>
                          提交 {picked} 项
                        </button>
                        <button disabled={model.scenario === 'merging'} onClick={() => actions.commit('checked', true)}>
                          提交并 push
                        </button>
                      </div>
                    </div>
                  </>
                )}
                {tab === 'history' &&
                  model.history.map((h) => (
                    <div
                      key={h.id}
                      className={`commit ${sel?.commit === h.id ? 'sel' : ''}`}
                      onClick={() => setSel({ kind: 'history', path: '项目/synote/搜索方案.md', commit: h.id })}
                    >
                      <span>{h.local ? '↑ ' : ''}{h.msg}</span>
                      <span className="muted">{h.id} · {h.author} · {h.when}</span>
                    </div>
                  ))}
              </div>
              <EditorArea doc={sel} model={model} actions={actions} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
