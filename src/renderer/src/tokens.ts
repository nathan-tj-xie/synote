// 颜色只在这里维护一份，生成 CSS 变量（ADR 0005）；组件中不允许硬编码颜色
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
} as const

export function applyTokens(el: HTMLElement = document.documentElement) {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v)
}
