import { tokens } from '../../shared/tokens'

export function applyTokens(el: HTMLElement = document.documentElement) {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v)
}
