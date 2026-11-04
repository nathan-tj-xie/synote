// PROTOTYPE（#11）：内存里的假 git 状态，所有动作都是桩，不碰真实仓库。
import { useState } from 'react'

export const SCENARIOS = {
  normal: '正常：有改动、领先 2',
  clean: '干净：无改动',
  merging: '合并中：pull 后有冲突',
  pushRejected: 'push 被拒：非快进',
  noCredential: 'push 失败：无凭据',
  noIdentity: 'commit 失败：缺提交身份',
  noGit: '没有可用的 git',
}

const CHANGES = [
  { path: '日记/2026-11-04.md', status: 'M' },
  { path: '项目/synote/搜索方案.md', status: 'M' },
  { path: '项目/synote/LFS 笔记.md', status: 'A' },
  { path: '读书/旧书单.md', status: 'D' },
  { path: '项目/synote/嵌入块.md', status: 'R', from: '项目/synote/公式.md' },
]

const ORPHANS = [
  { path: 'attachments/image-20261101-093012.png', tracked: true, size: '412 KB' },
  { path: 'attachments/架构草图.png', tracked: true, size: '1.2 MB' },
  { path: 'attachments/image-20261104-101500.png', tracked: false, size: '88 KB' },
]

const CONFLICTS = ['日记/2026-11-03.md', '项目/synote/决策地图.md']

const HISTORY = [
  { id: 'a1c9e02', msg: '补充搜索方案笔记', author: 'nathan', when: '10 分钟前', local: true },
  { id: '77b3f1d', msg: '整理读书笔记', author: 'nathan', when: '1 小时前', local: true },
  { id: '5e2d8a0', msg: '日记 11-03', author: 'nathan', when: '昨天' },
  { id: '0c41b7e', msg: '新增 LFS 调研摘录', author: 'nathan', when: '2 天前' },
  { id: 'd93a5c4', msg: '初始化笔记库', author: 'nathan', when: '1 周前' },
]

const INCOMING = [{ id: 'f0e1d2c', msg: '在手机上补了一条日记', author: 'nathan', when: '今天 08:12' }]

function initial(scenario) {
  const s = {
    scenario,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: scenario === 'pushRejected' ? 1 : 0,
    incoming: scenario === 'pushRejected' ? INCOMING : [],
    changes: CHANGES.map((c) => ({ ...c, staged: false, checked: true })),
    orphans: ORPHANS.map((o) => ({ ...o, checked: true })),
    conflicts: [],
    resolved: [],
    history: HISTORY,
    message: '',
    busy: null,
    error: null, // { kind, title, detail, commands? }
    toast: null,
    gitAvailable: scenario !== 'noGit',
  }
  if (scenario === 'clean') Object.assign(s, { changes: [], orphans: [], ahead: 0, history: HISTORY.map((h) => ({ ...h, local: false })) })
  if (scenario === 'merging') Object.assign(s, { conflicts: CONFLICTS, ahead: 2, behind: 0 })
  return s
}

const ERRORS = {
  noCredential: {
    kind: 'auth',
    title: 'push 失败：git 没拿到凭据',
    detail:
      'Synote 直接使用系统 git 的凭据配置，不在应用里登录。请先在终端里手动 push 一次完成认证，或配置 credential helper / SSH key，然后重试。',
    commands: ['git push', 'git config --global credential.helper osxkeychain'],
    raw: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  },
  pushRejected: {
    kind: 'nonff',
    title: 'push 被拒：远端有 1 个你本地没有的提交',
    detail: '需要先 pull 合并远端的提交，再 push。',
    raw: ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs',
  },
  noIdentity: {
    kind: 'identity',
    title: 'commit 失败：git 不知道你是谁',
    detail: 'Synote 不会替你写 git 配置。在终端运行下面两条命令（换成你的名字和邮箱）后重试。',
    commands: ['git config --global user.name "你的名字"', 'git config --global user.email "you@example.com"'],
    raw: 'Author identity unknown\n*** Please tell me who you are.',
  },
}

export function useGitModel(scenario) {
  const [s, setS] = useState(() => initial(scenario))
  const [key, setKey] = useState(scenario)
  // 切换场景时重置状态
  if (key !== scenario) {
    setKey(scenario)
    setS(initial(scenario))
  }
  const patch = (p) => setS((prev) => ({ ...prev, ...(typeof p === 'function' ? p(prev) : p) }))
  const toast = (t) => patch({ toast: t })

  const actions = {
    setMessage: (message) => patch({ message }),
    toggleChecked: (path) =>
      patch((p) => ({ changes: p.changes.map((c) => (c.path === path ? { ...c, checked: !c.checked } : c)) })),
    toggleOrphan: (path) =>
      patch((p) => ({ orphans: p.orphans.map((o) => (o.path === path ? { ...o, checked: !o.checked } : o)) })),
    stage: (path) => patch((p) => ({ changes: p.changes.map((c) => (c.path === path ? { ...c, staged: true } : c)) })),
    unstage: (path) =>
      patch((p) => ({ changes: p.changes.map((c) => (c.path === path ? { ...c, staged: false } : c)) })),
    stageAll: () => patch((p) => ({ changes: p.changes.map((c) => ({ ...c, staged: true })) })),
    dismissError: () => patch({ error: null }),
    dismissToast: () => patch({ toast: null }),
    resolveConflict: (path) =>
      patch((p) => ({
        conflicts: p.conflicts.filter((c) => c !== path),
        resolved: [...p.resolved, path],
        toast: `已保存 ${path}，冲突标记已清空，自动 git add`,
      })),
    // mode: 'staged' 只提交已暂存；'checked' 提交勾选的
    commit: (mode, andPush) => {
      if (s.scenario === 'noIdentity') return patch({ error: ERRORS.noIdentity })
      const picked = s.changes.filter((c) => (mode === 'staged' ? c.staged : c.checked))
      const orphans = s.orphans.filter((o) => o.checked)
      if (!s.message.trim()) return toast('请先填写提交信息')
      if (!picked.length && !orphans.length) return toast('没有要提交的内容')
      const rm = orphans.filter((o) => o.tracked).length
      const trash = orphans.length - rm
      const commit = { id: Math.random().toString(16).slice(2, 9), msg: s.message, author: 'nathan', when: '刚刚', local: true }
      patch((p) => ({
        changes: p.changes.filter((c) => !picked.includes(c)),
        orphans: p.orphans.filter((o) => !o.checked),
        history: [commit, ...p.history],
        ahead: p.ahead + 1,
        message: '',
        toast: `已提交 ${picked.length} 个文件${rm ? `，git rm ${rm} 个孤儿附件` : ''}${trash ? `，${trash} 个移到回收站` : ''}`,
      }))
      if (andPush) setTimeout(() => actions.push(), 50)
    },
    push: () => {
      patch({ busy: 'push' })
      setTimeout(() => {
        setS((p) => {
          if (p.scenario === 'noCredential') return { ...p, busy: null, error: ERRORS.noCredential }
          if (p.scenario === 'pushRejected' && p.behind > 0) return { ...p, busy: null, error: ERRORS.pushRejected }
          return {
            ...p,
            busy: null,
            ahead: 0,
            history: p.history.map((h) => ({ ...h, local: false })),
            toast: `已 push 到 ${p.upstream}`,
          }
        })
      }, 700)
    },
    pull: () => {
      patch({ busy: 'pull', error: null })
      setTimeout(() => {
        setS((p) => ({
          ...p,
          busy: null,
          behind: 0,
          history: [...p.incoming.map((h) => ({ ...h, local: false })), ...p.history],
          incoming: [],
          toast: p.behind ? `已 pull，合并了 ${p.behind} 个提交` : '已是最新',
        }))
      }, 700)
    },
    finishMerge: () =>
      patch((p) => ({
        resolved: [],
        behind: 0,
        ahead: p.ahead + 1,
        history: [{ id: 'm3r6e01', msg: "Merge branch 'main' of origin", author: 'nathan', when: '刚刚', local: true }, ...p.history],
        scenario: 'normal',
        toast: '已完成合并（生成合并提交）',
      })),
    abortMerge: () => {
      if (confirm('放弃合并？已解决的冲突也会丢弃，回到 pull 之前的状态（git merge --abort）。'))
        patch({ conflicts: [], resolved: [], scenario: 'normal', toast: '已放弃合并' })
    },
    redetectGit: () => toast('重新检测：仍未找到 git ≥ 2.38（原型）'),
  }
  return [s, actions]
}

export const STATUS_LABEL = { M: '修改', A: '新增', D: '删除', R: '重命名', '?': '未跟踪' }
