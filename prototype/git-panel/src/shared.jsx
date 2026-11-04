// PROTOTYPE（#11）：各变体共用的外围部件（不含布局）。
import { useEffect } from 'react'
import { STATUS_LABEL } from './model.js'

export function FileTree({ onOpen }) {
  const files = ['日记/2026-11-03.md', '日记/2026-11-04.md', '项目/synote/搜索方案.md', '项目/synote/决策地图.md', '读书/书单.md']
  return (
    <div className="tree">
      <div className="pane-title">笔记库 · my-notes</div>
      {files.map((f) => (
        <div key={f} className="tree-item" onClick={() => onOpen({ kind: 'note', path: f })}>
          {f}
        </div>
      ))}
    </div>
  )
}

// 编辑区：只示意打开了什么（正文 / 工作区对比 / 冲突 / 历史对比）
export function EditorArea({ doc, model, actions }) {
  if (!doc) return <div className="editor empty">点击任一改动的文件，直接以 diff 打开</div>
  const titles = {
    note: '笔记',
    diff: '工作区对比 HEAD ↔ 工作区（Monaco diff，示意）',
    conflict: '冲突视图（Monaco 冲突标记 + 行内接受按钮，示意）',
    history: `历史对比 当前 ↔ ${doc.commit}（示意）`,
    orphan: '孤儿附件预览',
  }
  return (
    <div className="editor">
      <div className="editor-tab">
        {doc.path} <span className="muted">· {titles[doc.kind]}</span>
      </div>
      {doc.kind === 'diff' && (
        <pre className="fake-diff">
          <span className="del">- 旧的一行内容</span>
          {'\n'}
          <span className="add">+ 新的一行内容</span>
          {'\n'}  未改动的上下文{'\n'}
          <span className="muted">⌘⇧D 切回正文</span>
        </pre>
      )}
      {doc.kind === 'conflict' && (
        <div className="fake-diff">
          <pre>
            {'<<<<<<< ours\n本地写的内容\n=======\n远端写的内容\n>>>>>>> theirs'}
          </pre>
          {model.conflicts.includes(doc.path) ? (
            <button onClick={() => actions.resolveConflict(doc.path)}>模拟：清空冲突标记并保存</button>
          ) : (
            <div className="ok">已解决</div>
          )}
        </div>
      )}
      {doc.kind === 'history' && <pre className="fake-diff muted">{doc.commit} 版本与当前文件的 diff，可块级拣回</pre>}
      {doc.kind === 'note' && <pre className="fake-diff muted">（实时预览编辑器）</pre>}
      {doc.kind === 'orphan' && <div className="fake-img">🖼 {doc.path}</div>}
    </div>
  )
}

export function MergeBanner({ model, actions }) {
  if (model.scenario !== 'merging') return null
  const n = model.conflicts.length
  return (
    <div className="merge-banner">
      <b>合并中</b>
      <span>{n ? `还有 ${n} 个冲突文件待解决，其他笔记可照常编辑` : '冲突都已解决，可以完成合并'}</span>
      <span className="spacer" />
      <button className="primary" disabled={n > 0} onClick={actions.finishMerge}>
        完成合并
      </button>
      <button onClick={actions.abortMerge}>放弃合并</button>
    </div>
  )
}

export function Commands({ list }) {
  return (
    <div className="commands">
      {list.map((c) => (
        <div key={c} className="cmd">
          <code>{c}</code>
          <button className="small" onClick={() => navigator.clipboard?.writeText(c)}>
            复制
          </button>
        </div>
      ))}
    </div>
  )
}

// git 报错：说清原因 + 下一步，原始输出折叠
export function GitError({ model, actions }) {
  const e = model.error
  if (!e) return null
  return (
    <div className="git-error">
      <div className="git-error-title">{e.title}</div>
      <div>{e.detail}</div>
      {e.commands && <Commands list={e.commands} />}
      <details>
        <summary>git 原始输出</summary>
        <pre>{e.raw}</pre>
      </details>
      <div className="row">
        {e.kind === 'nonff' && (
          <button className="primary" onClick={actions.pull}>
            先 pull
          </button>
        )}
        {e.kind === 'auth' && <button onClick={actions.push}>重试 push</button>}
        <button onClick={actions.dismissError}>关闭</button>
      </div>
    </div>
  )
}

export function GitMissing({ actions }) {
  return (
    <div className="git-missing">
      <div className="git-error-title">没有找到可用的 git（需要 ≥ 2.38）</div>
      <div>笔记库仍可正常编辑，只是没有版本管理功能。装好 git 后点"重新检测"。</div>
      <div className="muted">macOS</div>
      <Commands list={['xcode-select --install', 'brew install git']} />
      <div className="muted">Windows</div>
      <div>
        从 <a href="https://git-scm.com/download/win">git-scm.com</a> 下载安装
      </div>
      <div className="row">
        <button className="primary" onClick={actions.redetectGit}>
          重新检测
        </button>
        <button onClick={() => alert('打开设置 → git 路径（原型）')}>手动指定 git 路径…</button>
      </div>
    </div>
  )
}

export function Toast({ model, actions }) {
  useEffect(() => {
    if (!model.toast) return
    const t = setTimeout(actions.dismissToast, 2500)
    return () => clearTimeout(t)
  }, [model.toast])
  if (!model.toast) return null
  return <div className="toast">{model.toast}</div>
}

export function Status({ c }) {
  return (
    <span className={`st st-${c.status}`} title={STATUS_LABEL[c.status]}>
      {c.status}
    </span>
  )
}

export function OrphanTag({ o }) {
  return <span className="tag">{o.tracked ? 'git rm' : '移到回收站'}</span>
}

export function fileName(p) {
  return p.split('/').pop()
}
