// 切库是一次交接（串行，最后一次调用生效）：main 准备新库（旧库照常运行）→ 旧库的输入全部落盘 →
// main 一次性切换 → 界面换成新库。任何一步失败都停在旧库，不丢输入
import { i18next } from '../../shared/i18n'
import { flushAll, lockWhenIdle, setLocked } from './editor'
import { useVault } from './store'

let queue: Promise<unknown> = Promise.resolve()

export function openVault(dir: string): Promise<void> {
  const run = queue.then(async () => {
    const info = await window.synote.prepareVault(dir)
    await lockWhenIdle() // 从最终冲刷到 commit 返回不接受输入；成功后编辑器整个清空，失败则恢复可编辑
    try {
      if (!(await flushAll())) throw new Error(i18next.t('switchAborted'))
      await window.synote.commitVault(dir)
      useVault.getState().setVault(info) // prepare 的快照；main 随后推送 watcher 建好后的补扫结果
    } finally {
      setLocked(false)
    }
  })
  queue = run.catch(() => {})
  return run
}
