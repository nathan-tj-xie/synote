// 颜色（和代码字体）只在这里维护一份，生成 CSS 变量（ADR 0005），主进程的窗口背景色也取这里；组件中不允许硬编码颜色
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
  // 合并中（S16）的状态色；冲突视图里本地 / 传入两侧的底色（带透明度）
  merging: '#e3a04a',
  conflictOurs: '#4f8cff24',
  conflictTheirs: '#3fb95024',
  // diff 的增删底色（带透明度，叠在 bg 上）
  diffInserted: '#3fb95026',
  diffRemoved: '#ef5b5b26',
  // 代码字体（--font-mono）：CM6 的代码块、行内代码用它；Monaco diff 整个编辑器只有一种字体，沿用与 CM6 正文共用的 body 字体（ADR 0003）
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // 实时预览：代码块 / 行内代码底色，代码块语法高亮
  codeBg: '#2a2b30',
  synKeyword: '#c792ea',
  synString: '#a5d68a',
  synNumber: '#f2a65a',
  synComment: '#7f848e',
  synFunction: '#82aaff',
  synType: '#ffcb6b',
  synTag: '#f07178',
} as const
