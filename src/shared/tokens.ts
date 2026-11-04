// 颜色只在这里维护一份，生成 CSS 变量（ADR 0005），主进程的窗口背景色也取这里；组件中不允许硬编码颜色
export const tokens = {
  bg: '#1e1f22',
  bgRaised: '#26272b',
  bgHover: '#2f3136',
  bgSelected: '#2b3a55',
  border: '#3a3c42',
  fg: '#d7d9de',
  fgMuted: '#8a8f98',
  accent: '#4f8cff',
  danger: '#ef5b5b',
  onAccent: '#ffffff',
  // diff 的增删底色（带透明度，叠在 bg 上）
  diffInserted: '#3fb95026',
  diffRemoved: '#ef5b5b26',
} as const
