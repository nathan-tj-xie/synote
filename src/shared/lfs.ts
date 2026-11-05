// Git LFS 指针（research/lfs 2.1，git-lfs docs/spec.md「The Pointer」）：主进程（去重、读历史）和渲染进程（占位）共用
export type LfsPointer = { oid: string; size: number }

const VERSIONS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1']

// 严格识别：< 1024 字节的 UTF-8 文本，每行 `key value` 以 LF 结尾；第一行是 version，其余按 key 字母序、不重复；
// 必须有 `oid sha256:<64 位小写 hex>` 和 `size <十进制>`。空文件虽是自己的指针，但没有要下载的内容，不算
export function parseLfsPointer(b: Uint8Array): LfsPointer | null {
  if (b.length === 0 || b.length >= 1024) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return null
  }
  if (!text.endsWith('\n')) return null
  const [first, ...rest] = text.slice(0, -1).split('\n').map((l) => /^([a-z0-9.-]+) (.+)$/.exec(l))
  if (first?.[1] !== 'version' || !VERSIONS.includes(first[2])) return null
  const kv = new Map<string, string>()
  let prev = ''
  for (const m of rest) {
    if (!m || m[1] <= prev) return null
    kv.set((prev = m[1]), m[2])
  }
  const oid = /^sha256:([0-9a-f]{64})$/.exec(kv.get('oid') ?? '')?.[1]
  const size = kv.get('size') ?? ''
  return oid && /^\d+$/.test(size) ? { oid, size: Number(size) } : null
}

// 占位里显示的大小
export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)
