import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 嵌入块（S4）：Mermaid、块级 / 行内公式
async function launch(text: string) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(vault)
  mkdirSync(userData)
  writeFileSync(path.join(vault, 'a.md'), text)
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toBeVisible()
  const disk = () => readFileSync(path.join(vault, 'a.md'), 'utf8')
  return { app, win, disk }
}

// 按坐标点：行内公式上 Playwright 的命中检查误报被 .cm-line 拦截（真实点击能打开浮层）
async function clickAt(l: Locator) {
  const b = (await l.boundingBox())!
  await l.page().mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

test('embeds render; a broken one shows red source and the rest still renders', async () => {
  const text = [
    '# 标题',
    '',
    '```mermaid',
    'flowchart LR',
    '  甲 --> 乙',
    '```',
    '',
    '$$',
    'x = \\frac{1}{2}',
    '$$',
    '',
    '```math',
    'a^2',
    '```',
    '',
    '行内 $e^{i\\pi}$，价格 $5 到 $10，转义 \\$3。',
    '',
    '$$',
    '\\frac{1}{',
    '$$',
    '',
    '```mermaid',
    'flowchart LR',
    '  A -->> -->',
    '```',
    '',
    '坏的 $\\nope$ 之后 **粗**。',
  ].join('\n')
  const { app, win, disk } = await launch(text)
  await expect(win.locator('.cm-embed-mermaid svg')).toHaveCount(1, { timeout: 15_000 })
  await expect(win.locator('.cm-embed-mermaid svg')).toContainText('乙')
  await expect(win.locator('.cm-embed-math .katex-display')).toHaveCount(2)
  await expect(win.locator('.cm-embed-inline .katex')).toHaveCount(1)
  await expect(win.locator('.cm-content')).toContainText('价格 $5 到 $10，转义 $3。')
  const errors = win.locator('.cm-embed-error')
  await expect(errors).toHaveCount(3)
  await expect(errors.nth(0)).toHaveText('$$\n\\frac{1}{\n$$')
  await expect(errors.nth(0)).toHaveAttribute('title', /KaTeX parse error/)
  await expect(errors.nth(0)).toHaveCSS('color', 'rgb(239, 91, 91)')
  await expect(errors.nth(1)).toContainText('A -->> -->')
  await expect(errors.nth(2)).toHaveText('$\\nope$')
  // 失败的后面照常渲染
  await expect(win.locator('.cm-content')).toContainText('坏的 $\\nope$ 之后 粗。')
  expect(disk()).toBe(text)
  await app.close()
})

test('click opens the editor: block in a dialog saved on demand, inline in a popover written as you type', async () => {
  const { app, win, disk } = await launch('# 标题\n\n$$\na+b\n$$\n\n行内 $x$ 后\n')
  await win.locator('.cm-embed-math').click()
  const dialog = win.getByRole('dialog', { name: '编辑公式' })
  const source = dialog.getByRole('textbox', { name: '源码' })
  await expect(source).toHaveValue('a+b')
  await source.fill('a+b+c')
  await expect(dialog.getByLabel('预览')).toContainText('c')
  expect(disk()).toContain('$$\na+b\n$$') // 保存之前不写
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(disk).toBe('# 标题\n\n$$\na+b+c\n$$\n\n行内 $x$ 后\n')

  // 取消不写
  await win.locator('.cm-embed-math').click()
  await dialog.getByRole('textbox', { name: '源码' }).fill('zzz')
  await win.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await clickAt(win.locator('.cm-embed-inline'))
  const pop = win.getByRole('dialog', { name: '编辑公式' })
  const input = pop.getByRole('textbox', { name: '源码' })
  await expect(input).toHaveValue('x')
  await input.fill('y^2')
  await expect(pop.getByLabel('预览')).toContainText('y')
  await expect.poll(disk).toBe('# 标题\n\n$$\na+b+c\n$$\n\n行内 $y^2$ 后\n')
  await win.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await expect(win.locator('.cm-embed-inline .katex')).toBeVisible()
  // 点外部关闭
  await clickAt(win.locator('.cm-embed-inline'))
  await expect(pop).toBeVisible()
  await win.locator('.cm-lp-h1').click()
  await expect(pop).toHaveCount(0)
  await app.close()
})

test('arrow keys treat embeds as one unit; Enter on a selected embed opens it', async () => {
  const { app, win, disk } = await launch('开头\n$$\nx\n$$\n结尾 $y$ 后\n')
  const selected = win.locator('.cm-embed-selected')
  await win.locator('.cm-line').first().click()
  await win.keyboard.press('End')
  // 下：先停在块级公式上（选中），再按越过到下一行
  await win.keyboard.press('ArrowDown')
  await expect(selected).toHaveClass(/cm-embed-math/)
  await win.keyboard.press('Enter')
  const dialog = win.getByRole('dialog', { name: '编辑公式' })
  await expect(dialog).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await win.keyboard.press('ArrowUp')
  await expect(selected).toHaveClass(/cm-embed-math/)
  await win.keyboard.press('ArrowDown')
  await expect(selected).toHaveCount(0)
  // 行内：右移停在公式上，再右移越过，输入落在公式之后
  await win.keyboard.press('Home')
  for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
  await win.keyboard.press('ArrowRight')
  await expect(selected).toHaveClass(/cm-embed-inline/)
  await win.keyboard.press('ArrowRight')
  await expect(selected).toHaveCount(0)
  await win.keyboard.type('Z')
  // 左移同样整体越过
  await win.keyboard.press('ArrowLeft')
  await win.keyboard.press('ArrowLeft')
  await expect(selected).toHaveClass(/cm-embed-inline/)
  await win.keyboard.press('ArrowLeft')
  await win.keyboard.type('W')
  await expect.poll(disk).toBe('开头\n$$\nx\n$$\n结尾 W$y$Z 后\n')
  await app.close()
})

test('$$ or ```mermaid on an empty line plus Enter creates an embed; commands insert math', async () => {
  const { app, win, disk } = await launch('# 标题\n\n')
  await win.locator('.cm-content').click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('$$')
  await win.keyboard.press('Enter')
  const math = win.getByRole('dialog', { name: '编辑公式' })
  await math.getByRole('textbox', { name: '源码' }).fill('x^2')
  await math.getByRole('button', { name: '保存' }).click()
  await expect.poll(disk).toBe('# 标题\n\n$$\nx^2\n$$')
  await expect(win.locator('.cm-embed-math .katex')).toBeVisible()

  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter')
  await win.keyboard.type('```mermaid')
  await win.keyboard.press('Enter')
  const mmd = win.getByRole('dialog', { name: '编辑 Mermaid 图' })
  await mmd.getByRole('textbox', { name: '源码' }).fill('flowchart LR\n  A --> B')
  await mmd.getByRole('button', { name: '保存' }).click()
  await expect.poll(disk).toBe('# 标题\n\n$$\nx^2\n$$\n\n```mermaid\nflowchart LR\n  A --> B\n```')
  await expect(win.locator('.cm-embed-mermaid svg')).toBeVisible({ timeout: 15_000 })

  // 命令面板：插入行内公式（输入即写入），插入块级公式（保存才写入）
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter')
  await win.keyboard.type('设 ')
  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.getByRole('combobox', { name: '命令面板' }).fill('插入行内公式')
  await win.keyboard.press('Enter')
  const pop = win.getByRole('dialog', { name: '编辑公式' })
  await pop.getByRole('textbox', { name: '源码' }).fill('k')
  await win.keyboard.press('Enter')
  await expect.poll(disk).toMatch(/\n\n设 \$k\$$/)
  await win.keyboard.press('ControlOrMeta+Shift+p')
  await win.getByRole('combobox', { name: '命令面板' }).fill('插入块级公式')
  await win.keyboard.press('Enter')
  await math.getByRole('textbox', { name: '源码' }).fill('m')
  await math.getByRole('button', { name: '保存' }).click()
  await expect.poll(disk).toMatch(/\n\n设 \$k\$\n\n\$\$\nm\n\$\$$/)
  await expect(win.getByRole('alert')).toHaveCount(0)
  await app.close()
})
