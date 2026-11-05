import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 实时预览性能测量（S3 验收「打开和输入不卡顿」）：只在设了 SYNOTE_PERF 时跑，不进 CI。
// SYNOTE_EXE 指向打包产物（如 dist/mac-arm64/Synote.app/Contents/MacOS/Synote），不设则跑 out/ 构建
test.skip(!process.env.SYNOTE_PERF, 'set SYNOTE_PERF=1 to measure')

// 约 5000 行、各种语法混排的笔记
function bigNote(): string {
  const block = (i: number) => [
    `## 第 ${i} 节 *强调* **加粗** \`code\``,
    '',
    `正文段落 ${i}，带 [链接](其他/笔记${i}.md)、~~删除线~~ 和 ![图](attachments/a.png)。中文和 English 混排，再来一点长文本让它折行：${'内容'.repeat(30)}`,
    '',
    '- 列表项一',
    '- 列表项二 **粗**',
    '  - 嵌套项',
    '- [ ] 待办',
    '- [x] 已办',
    '',
    '> 引用一行',
    '> 引用第二行 *斜*',
    '',
    '```ts',
    `function f${i}(a: number): string {`,
    '  return `${a}` // 注释',
    '}',
    '```',
    '',
    '| 列 A | 列 B |',
    '|:-----|-----:|',
    `| ${i} | 值 |`,
    '',
    '---',
    '',
  ]
  const lines = ['# 大笔记', '']
  for (let i = 0; lines.length < 5000; i++) lines.push(...block(i))
  return lines.join('\n')
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1)
  return `n=${s.length} median=${q(0.5)}ms p95=${q(0.95)}ms max=${s.at(-1)!.toFixed(1)}ms`
}

// 逐键延迟：keydown 到下一帧画完（rAF 之后的宏任务）
async function typeLatency(win: Page, text: string): Promise<number[]> {
  await win.evaluate(() => {
    const g = window as unknown as { lat: number[]; hooked?: true }
    g.lat = []
    if (!g.hooked && (g.hooked = true)) window.addEventListener('keydown', () => {
      const t0 = performance.now()
      requestAnimationFrame(() => setTimeout(() => g.lat.push(performance.now() - t0)))
    }, true)
  })
  await win.keyboard.type(text, { delay: 40 })
  await win.waitForTimeout(200)
  return win.evaluate(() => (window as unknown as { lat: number[] }).lat)
}

test('open and type in a 5000-line note', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-perf-'))
  const vault = path.join(base, 'vault')
  mkdirSync(path.join(vault, 'attachments'), { recursive: true })
  mkdirSync(path.join(base, 'user-data'))
  const text = bigNote()
  writeFileSync(path.join(vault, '大笔记.md'), text)
  writeFileSync(path.join(vault, 'attachments/a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
  writeFileSync(path.join(base, 'user-data', 'recent.json'), JSON.stringify([vault]))
  const exe = process.env.SYNOTE_EXE
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), env: { ...process.env, SYNOTE_USER_DATA: path.join(base, 'user-data') } })
  const win = await app.firstWindow()
  await expect(win.getByRole('tree')).toBeVisible()

  const t0 = Date.now()
  await win.getByRole('treeitem', { name: '大笔记.md' }).click()
  await expect(win.locator('.cm-lp-table').first()).toBeVisible()
  const open = Date.now() - t0
  console.log(`[perf] ${text.split('\n').length} lines, ${text.length} chars; open → first render: ${open}ms`)

  await win.locator('.cm-line').nth(4).click()
  await win.keyboard.press('End')
  const top = await typeLatency(win, 'abcdefghij'.repeat(10))
  console.log(`[perf] typing near top: ${stats(top)}`, process.env.SYNOTE_PERF === 'raw' ? top.map(Math.round).join(' ') : '')
  await win.keyboard.press('ControlOrMeta+End')
  await win.waitForTimeout(500)
  console.log(`[perf] typing at end: ${stats(await typeLatency(win, 'abcdefghij'.repeat(10)))}`)
  // 文首连续回车：后面整篇的行号和语法树都要跟着移动
  await win.keyboard.press('ControlOrMeta+Home')
  console.log(`[perf] Enter at top: ${stats(await typeLatency(win, '\n\n\n\n\n'.repeat(4)))}`)
  await app.close()
})
