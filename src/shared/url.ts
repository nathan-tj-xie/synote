// 链接路径的百分号解码，主进程（索引的链接抽取）和渲染进程（图片路径）共用。
// 用 decodeURIComponent 而不是 decodeURI：后者不解 %23、%26、%3F 等保留字符，而文件名里可以有 # & ?。
// 不是合法的百分号编码时保留原文
export function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// decodeComponent 的逆过程，只编码会让链接失效或解码出歧义的 ASCII 字符（空白、% ( ) < > # ? & \ 等）；
// 非 ASCII 保持原样（ADR 0001），这样在 GitHub 上可点、索引和实时预览解码后还原成原路径
export const encodeSegment = (s: string) =>
  s.replace(/[\x00-\x20%()<>#?&\\\x7f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

// 从笔记 note 指向 target（都相对库根）的标准相对链接，按笔记所在目录计算
export function relativeLink(note: string, target: string): string {
  const from = note.split('/').slice(0, -1)
  const to = target.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].map(encodeSegment).join('/')
}
