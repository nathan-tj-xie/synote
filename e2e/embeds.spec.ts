import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 嵌入块（S4）：Mermaid、块级 / 行内公式
async function launch(text: string, more: Record<string, string> = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'synote-e2e-'))
  const vault = path.join(base, 'vault')
  const userData = path.join(base, 'user-data')
  mkdirSync(vault)
  mkdirSync(userData)
  writeFileSync(path.join(vault, 'a.md'), text)
  for (const [p, c] of Object.entries(more)) writeFileSync(path.join(vault, p), c)
  writeFileSync(path.join(userData, 'recent.json'), JSON.stringify([vault]))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, SYNOTE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await expect(win.locator('.cm-content')).toBeVisible()
  const disk = (p = 'a.md') => readFileSync(path.join(vault, p), 'utf8')
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

test('embeds inside quotes and lists render and keep their prefixes when edited; $$ content may look like a list', async () => {
  const text = '# 标题\n\n> $$\n> a\n> $$\n\n- 项\n\n  ```mermaid\n  flowchart LR\n    甲 --> 乙\n  ```\n\n$$\n- x + y\n$$\n'
  const { app, win, disk } = await launch(text)
  await expect(win.locator('.cm-embed-box.cm-lp-quote .cm-embed-math .katex')).toBeVisible()
  await expect(win.locator('.cm-embed-box .cm-embed-mermaid svg')).toContainText('乙', { timeout: 15_000 })
  await expect(win.locator('.cm-embed-math .katex')).toHaveCount(2)
  await win.locator('.cm-embed-math').first().click()
  const dialog = win.getByRole('dialog', { name: '编辑公式' })
  await dialog.getByRole('textbox', { name: '源码' }).fill('b\nc')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect.poll(disk).toBe(text.replace('> $$\n> a\n> $$', () => '> $$\n> b\n> c\n> $$'))
  await app.close()
})

test('$$x$$ written inline opens the dialog; a source with a newline cannot be saved', async () => {
  const { app, win, disk } = await launch('前 $$x$$ 后\n')
  await win.locator('.cm-embed-math .katex').click()
  const dialog = win.getByRole('dialog', { name: '编辑公式' })
  const source = dialog.getByRole('textbox', { name: '源码' })
  const save = dialog.getByRole('button', { name: '保存' })
  await expect(source).toHaveValue('x')
  // 行内公式不能跨行，换成空格又会让 `+y` 被 % 注释吞掉：不让保存
  await source.fill('x% comment\n+y')
  await expect(save).toBeDisabled()
  await expect(dialog.getByRole('status')).toHaveText('行内公式不能换行，需要多行请改用块级公式')
  await source.press('ControlOrMeta+Enter')
  await expect(dialog).toBeVisible()
  expect(disk()).toBe('前 $$x$$ 后\n')
  await source.fill('x + y')
  await expect(dialog.getByRole('status')).toHaveCount(0)
  await save.click()
  await expect.poll(disk).toBe('前 $$x + y$$ 后\n')
  await app.close()
})

test('an edit request never writes into another note or another formula', async () => {
  const same = '# 标题\n\n$$\na\n$$\n'
  const { app, win, disk } = await launch(same, { 'b.md': same })
  // 弹窗开着时用快速切换换到内容相同的 b.md：请求作废，两篇都不被写
  await win.locator('.cm-embed-math').click()
  await win.getByRole('dialog', { name: '编辑公式' }).getByRole('textbox', { name: '源码' }).fill('zzz')
  await win.keyboard.press('ControlOrMeta+p')
  await win.getByRole('combobox', { name: '快速切换' }).fill('b.md')
  await win.keyboard.press('Enter')
  await expect(win.getByRole('tab', { name: 'b', selected: true })).toBeVisible()
  await expect(win.getByRole('dialog', { name: '编辑公式' })).toHaveCount(0)
  await win.waitForTimeout(800)
  expect(disk()).toBe(same)
  expect(disk('b.md')).toBe(same)

  // 从公式 A 的浮层直接点公式 B：之后的输入改的是 B
  await win.getByRole('treeitem', { name: 'a.md' }).click()
  await win.locator('.cm-content').click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.type('\n甲 $p$ 乙 $q$ 丙')
  await expect(win.locator('.cm-embed-inline')).toHaveCount(2)
  await clickAt(win.locator('.cm-embed-inline').first())
  const input = win.getByRole('dialog', { name: '编辑公式' }).getByRole('textbox', { name: '源码' })
  await expect(input).toHaveValue('p')
  await clickAt(win.locator('.cm-embed-inline').nth(1))
  await expect(input).toHaveValue('q')
  await input.fill('r')
  await expect.poll(disk).toBe(same + '\n甲 $p$ 乙 $r$ 丙')
  await expect(win.getByRole('alert')).toHaveCount(0)
  await app.close()
})

test('typing next to a block embed (end of note, between adjacent blocks, after closing the editor) never sticks to its delimiters', async () => {
  // 文末的块级公式：保存后、取消后接着输入都落在块外的新行；取消不改文件
  const { app, win, disk } = await launch('$$\nx\n$$')
  const dialog = win.getByRole('dialog', { name: '编辑公式' })
  await win.locator('.cm-embed-math').click()
  await dialog.getByRole('textbox', { name: '源码' }).fill('y')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(win.locator('.cm-content')).toBeFocused()
  await win.keyboard.type('Z')
  await expect.poll(disk).toBe('$$\ny\n$$\nZ')
  await expect(win.locator('.cm-embed-math .katex')).toBeVisible()
  await app.close()

  const m = await launch('前\n\n```mermaid\nflowchart LR\n  A --> B\n```')
  await m.win.locator('.cm-embed-mermaid').click()
  await m.win.keyboard.press('Escape')
  await expect(m.win.locator('.cm-content')).toBeFocused()
  await m.win.waitForTimeout(700)
  expect(m.disk()).toBe('前\n\n```mermaid\nflowchart LR\n  A --> B\n```')
  await m.win.keyboard.type('Z')
  await expect.poll(m.disk).toBe('前\n\n```mermaid\nflowchart LR\n  A --> B\n```\nZ')
  await m.app.close()

  // 两个相邻的块（只隔一个换行）：从第二块左移越过、关闭第一块后，输入都落在两块之间的新行，两块照常渲染
  const two = '$$\na\n$$\n$$\nb\n$$\n后'
  const k = await launch(two)
  await expect(k.win.locator('.cm-embed-math .katex')).toHaveCount(2)
  await k.win.locator('.cm-line').last().click()
  await k.win.keyboard.press('Home')
  await k.win.keyboard.press('ArrowLeft')
  await k.win.keyboard.press('ArrowLeft')
  await k.win.keyboard.type('Z')
  await expect.poll(k.disk).toBe('$$\na\n$$\nZ\n$$\nb\n$$\n后')
  await k.win.keyboard.press('ControlOrMeta+z')
  await expect.poll(k.disk).toBe(two)
  await k.win.locator('.cm-embed-math').first().click()
  await k.win.keyboard.press('Escape')
  await expect(k.win.locator('.cm-content')).toBeFocused()
  await k.win.keyboard.type('W')
  await expect.poll(k.disk).toBe('$$\na\n$$\nW\n$$\nb\n$$\n后')
  await expect(k.win.locator('.cm-embed-math .katex')).toHaveCount(2)
  // 光标停在第一块之后时用命令插入行内公式：同样落在块外，连续输入都写进同一个公式
  await k.win.keyboard.press('ControlOrMeta+z')
  await expect.poll(k.disk).toBe(two)
  await k.win.locator('.cm-embed-math').first().click()
  await k.win.keyboard.press('Escape')
  await expect(k.win.locator('.cm-content')).toBeFocused()
  await k.win.keyboard.press('ControlOrMeta+Shift+p')
  await k.win.getByRole('combobox', { name: '命令面板' }).fill('插入行内公式')
  await k.win.keyboard.press('Enter')
  const input = k.win.getByRole('dialog', { name: '编辑公式' }).getByRole('textbox', { name: '源码' })
  await input.pressSequentially('k^2')
  await expect.poll(k.disk).toBe('$$\na\n$$\n$k^2$\n$$\nb\n$$\n后')
  await expect(k.win.getByRole('alert')).toHaveCount(0)
  await k.app.close()
})

test('saving an untouched formula leaves its source byte for byte', async () => {
  const text = '$$  x  $$\n\n$$ a\nb $$\n'
  const { app, win, disk } = await launch(text)
  for (const i of [0, 1]) {
    await win.locator('.cm-embed-math').nth(i).click()
    await win.getByRole('dialog', { name: '编辑公式' }).getByRole('button', { name: '保存' }).click()
  }
  // 改过的也不去首尾空白
  await win.locator('.cm-embed-math').first().click()
  await win.getByRole('dialog', { name: '编辑公式' }).getByRole('textbox', { name: '源码' }).fill('  y  ')
  await win.getByRole('dialog', { name: '编辑公式' }).getByRole('button', { name: '保存' }).click()
  await expect.poll(disk).toBe('$$  y  $$\n\n$$ a\nb $$\n')
  await app.close()
})
