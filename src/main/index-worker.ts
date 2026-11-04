// 索引 utility process 入口：主进程发 { id, method, args }，回 { id, result | error }；索引变化时推 { event: 'changed', paths }
import { Indexer } from './indexer'

let idx: Indexer | null = null
const port = process.parentPort

port.on('message', async ({ data }) => {
  const { id, method, args } = data as { id: number; method: string; args: unknown[] }
  try {
    let result: unknown
    if (method === 'open') {
      const [dbFile, root] = args as [string, string]
      idx = new Indexer(dbFile, root, (paths) => port.postMessage({ event: 'changed', paths }))
      idx.watch()
      await idx.reconcile()
    } else {
      if (!idx) throw new Error('index not open')
      result = await (idx as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args)
    }
    port.postMessage({ id, result })
  } catch (e) {
    port.postMessage({ id, error: String(e) })
  }
})
