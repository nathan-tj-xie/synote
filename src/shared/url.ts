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
