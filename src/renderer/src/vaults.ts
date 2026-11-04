// 切库是一次交接（串行，最后一次调用生效）：main 准备新库（旧库照常运行）→ 旧库的输入全部落盘 →
// main 一次性切换 → 界面换成新库。任何一步失败都停在旧库，不丢输入
import { i18next } from '../../shared/i18n'
import { flushAll } from './editor'
import { useVault } from './store'

let queue: Promise<unknown> = Promise.resolve()

export function openVault(dir: string): Promise<void> {
  const run = queue.then(async () => {
    const info = await window.synote.prepareVault(dir)
    if (!(await flushAll())) throw new Error(i18next.t('switchAborted'))
    await window.synote.commitVault(dir)
    useVault.getState().setVault(info)
  })
  queue = run.catch(() => {})
  return run
}
