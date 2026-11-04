// PROTOTYPE（#11）变体 C：右侧时间线抽屉。自上而下：远端待拉取 → 未提交（工作区）→ 未推送的本地提交 → 历史；push/pull 挂在对应节点上。
import { useState } from 'react'
import { EditorArea, FileTree, GitError, GitMissing, MergeBanner, OrphanTag, Status, fileName } from './shared.jsx'

export const name = '右侧时间线'

export function VariantC({ model, actions }) {
  const [drawer, setDrawer] = useState(true)
  const [doc, setDoc] = useState(null)
  const [exclude, setExclude] = useState(false)
  const local = model.history.filter((h) => h.local)
  const pushed = model.history.filter((h) => !h.local)
  const dirty = model.changes.length + model.orphans.length + model.conflicts.length + model.resolved.length

  return (
    <div className="app col">
      <MergeBanner model={model} actions={actions} />
      <div className="row grow">
        <div className="sidebar">
          <FileTree onOpen={setDoc} />
        </div>
        <EditorArea doc={doc} model={model} actions={actions} />
        {!drawer && (
          <div className="drawer-handle" onClick={() => setDrawer(true)}>
            ⑂ {dirty ? `${dirty} 未提交` : ''} ↑{model.ahead}
          </div>
        )}
        {drawer && (
          <div className="drawer">
            <div className="pane-title">
              ⑂ {model.branch} <span className="muted">→ {model.upstream}</span>
              <span className="spacer" />
              <button className="small" onClick={() => setDrawer(false)}>
                收起 ⌘⇧G
              </button>
            </div>
            {!model.gitAvailable ? (
              <GitMissing actions={actions} />
            ) : (
              <div className="timeline">
                <GitError model={model} actions={actions} />

                <Node kind="remote" title={`远端 ${model.upstream}`}>
                  {model.incoming.map((h) => (
                    <div key={h.id} className="commit incoming">
                      <span>{h.msg}</span>
                      <span className="muted">{h.id} · {h.when}</span>
                    </div>
                  ))}
                  <button onClick={actions.pull} disabled={!!model.busy}>
                    {model.busy === 'pull' ? '正在 pull…' : model.behind ? `拉取 ${model.behind} 个提交` : '检查更新（pull）'}
                  </button>
                </Node>

                <Node kind="work" title={dirty ? `未提交 · ${dirty}` : '工作区干净'}>
                  {model.conflicts.map((p) => (
                    <div key={p} className="file" onClick={() => setDoc({ kind: 'conflict', path: p })}>
                      <span className="st st-C">!</span>
                      {p} <span className="tag warn">冲突</span>
                    </div>
                  ))}
                  {model.resolved.map((p) => (
                    <div key={p} className="file" onClick={() => setDoc({ kind: 'conflict', path: p })}>
                      <span className="st st-M">✓</span>
                      {p}
                    </div>
                  ))}
                  {model.changes.map((c) => (
                    <div key={c.path} className={`file ${c.checked ? '' : 'excluded'}`} onClick={() => setDoc({ kind: 'diff', path: c.path })}>
                      {exclude && (
                        <input
                          type="checkbox"
                          checked={c.checked}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => actions.toggleChecked(c.path)}
                        />
                      )}
                      <Status c={c} />
                      {fileName(c.path)}
                      {c.from && <span className="muted">← {fileName(c.from)}</span>}
                    </div>
                  ))}
                  {model.orphans.length > 0 && (
                    <div className="sub">
                      <div className="muted">将删除的孤儿附件</div>
                      {model.orphans.map((o) => (
                        <label key={o.path} className="file">
                          <input type="checkbox" checked={o.checked} onChange={() => actions.toggleOrphan(o.path)} />
                          <span onClick={() => setDoc({ kind: 'orphan', path: o.path })}>{fileName(o.path)}</span>
                          <OrphanTag o={o} />
                        </label>
                      ))}
                    </div>
                  )}
                  {(model.changes.length > 0 || model.orphans.length > 0) && model.scenario !== 'merging' && (
                    <>
                      <input
                        className="msg"
                        placeholder="提交信息，Enter 提交全部"
                        value={model.message}
                        onChange={(e) => actions.setMessage(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && actions.commit('checked')}
                      />
                      <div className="row">
                        <button className="primary" onClick={() => actions.commit('checked')}>
                          提交
                        </button>
                        <button className="link" onClick={() => setExclude(!exclude)}>
                          {exclude ? '完成挑选' : '排除部分文件…'}
                        </button>
                      </div>
                    </>
                  )}
                </Node>

                <Node kind="local" title={local.length ? `未推送 · ${local.length}` : '没有未推送的提交'}>
                  {local.map((h) => (
                    <div key={h.id} className="commit" onClick={() => setDoc({ kind: 'history', path: '项目/synote/搜索方案.md', commit: h.id })}>
                      <span>{h.msg}</span>
                      <span className="muted">{h.id} · {h.when}</span>
                    </div>
                  ))}
                  {local.length > 0 && (
                    <button className="primary" onClick={actions.push} disabled={!!model.busy}>
                      {model.busy === 'push' ? '正在 push…' : `推送这 ${local.length} 个提交`}
                    </button>
                  )}
                </Node>

                <Node kind="history" title="历史">
                  {pushed.map((h) => (
                    <div key={h.id} className="commit" onClick={() => setDoc({ kind: 'history', path: '项目/synote/搜索方案.md', commit: h.id })}>
                      <span>{h.msg}</span>
                      <span className="muted">{h.id} · {h.when}</span>
                    </div>
                  ))}
                </Node>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Node({ kind, title, children }) {
  return (
    <div className={`node node-${kind}`}>
      <div className="node-dot" />
      <div className="node-body">
        <div className="node-title">{title}</div>
        {children}
      </div>
    </div>
  )
}
