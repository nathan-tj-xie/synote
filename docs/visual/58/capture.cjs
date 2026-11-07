const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const root = process.env.SYNOTE_WORKTREE || process.cwd();
const phase = process.env.SYNOTE_CAPTURE_PHASE || 'capture';
const { _electron: electron, expect } = require(path.join(root, 'node_modules/@playwright/test'));
const out = path.join(__dirname, phase); fs.mkdirSync(out,{recursive:true});
const base = fs.mkdtempSync('/tmp/synote-58-fixture-');
const vault = path.join(base,'山间笔记'); fs.mkdirSync(vault);
const git = (...args) => execFileSync('git',args,{cwd:vault,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-11-01T10:00:00+08:00',GIT_COMMITTER_DATE:'2026-11-01T10:00:00+08:00'}}).trim();
const put = (name,text) => {const p=path.join(vault,name); fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text)};
const manuscript = `# 留下思考的路径\n\n笔记是可以慢慢生长的想法。把观察写下来，再用链接连接它们，下一次回来时就能继续思考。\n\n## 今天的记录\n\n我们正在整理一个关于**山间步道**的小型笔记库：保留原始记录，也记录每次修改的原因。\n\n> 好的工具让注意力留在内容里。\n\n- [x] 整理沿途观察\n- [ ] 为照片补充说明\n- [ ] 回顾 [行走计划](行走计划.md)\n\n## 可以带走的方法\n\n用标准 Markdown 保存文字，用 Git 记录变化。每一次提交，都是思考过程中的一个清晰节点。\n\n\`const note = { title: '山间步道', revised: true }\`\n\n| 记录 | 频率 | 目的 |\n| --- | --- | --- |\n| 观察 | 每天 | 留下细节 |\n| 回顾 | 每周 | 发现联系 |\n\n\`\`\`typescript\nfunction remember(thought: string) {\n  return thought.trim()\n}\n\`\`\`\n`;
put('开始阅读.md', manuscript.replace('每一次提交','每一份笔记'));
put('行走计划.md','# 行走计划\n\n周末沿溪流向北，留意植物和水声。\n\n回到 [开始阅读](开始阅读.md)，整理今天的观察。\n');
put('研究/观察日志.md','# 观察日志\n\n山间步道在雨后显得更加安静。参见 [开始阅读](../开始阅读.md)。\n');
put('公式与图示.md','# 公式与图示\n\n把关系画出来，也让公式成为笔记的一部分。\n\n```mermaid\nflowchart LR\n  A[观察] --> B[记录]\n  B --> C[建立联系]\n  C --> D[重新理解]\n```\n\n$$\nE = mc^2\n$$\n\n行走距离可以写作 $d = vt$，帮助我们估计下一段路。\n');
put('旧记录.md','# 旧记录\n\n这份记录已合并到行走计划。\n');put('attachments/旧草图.txt','unreferenced draft');
git('init','-b','main');git('config','user.name','林间');git('config','user.email','visual@example.invalid');git('add','.');git('commit','-m','建立步道笔记');
put('开始阅读.md',manuscript.replace('下一次回来时就能继续思考','回顾时就能继续思考'));git('add','.');git('commit','-m','补充每周回顾的方法');
put('开始阅读.md',manuscript);put('行走计划.md',fs.readFileSync(path.join(vault,'行走计划.md'),'utf8')+'\n带上地图和水，午后返回。\n');git('add','行走计划.md');fs.unlinkSync(path.join(vault,'旧记录.md'));put('研究/新的问题.md','# 新的问题\n\n如何把零散观察连接起来？\n');
let app,win;const frames=[];
async function launch(empty=false){const ud=path.join(base,empty?'welcome-user':'vault-user');fs.mkdirSync(ud,{recursive:true});fs.writeFileSync(path.join(ud,'recent.json'),JSON.stringify(empty?[]:[vault]));app=await electron.launch({args:[root],cwd:root,env:{...process.env,SYNOTE_USER_DATA:ud}});win=await app.firstWindow();win.setDefaultTimeout(12000);await app.evaluate(({BrowserWindow,nativeTheme})=>{nativeTheme.themeSource='dark';BrowserWindow.getAllWindows()[0].setContentSize(1280,800)});await expect(win.getByRole(empty?'button':'tree',empty?{name:'打开笔记库…'}:{})).toBeVisible();}
async function shot(name){await win.waitForTimeout(450);await win.screenshot({path:path.join(out,name+'.png'),scale:'css'});frames.push(name);console.log(name);}
async function cmd(text){await win.keyboard.press('Meta+Shift+p');await win.getByRole('combobox').fill(text);await win.keyboard.press('Enter');}
async function open(name){await win.keyboard.press('Meta+p');await win.getByRole('combobox').fill(name);await win.keyboard.press('Enter');await expect(win.getByRole('tab',{name:new RegExp(name.replace('.md',''))})).toBeVisible();await win.waitForTimeout(350);}
(async()=>{try{
await launch(true);await shot('01-welcome');await app.close();app=null;
await launch();await open('行走计划');await open('开始阅读');await win.getByRole('treeitem',{name:'研究',exact:true}).click();await win.keyboard.press('ArrowRight');await shot('02-manuscript');
await win.keyboard.press('Meta+Shift+p');await shot('03-command-palette');await win.keyboard.press('Escape');await win.keyboard.press('Meta+p');await win.getByRole('combobox').fill('行');await shot('04-quick-switch');await win.keyboard.press('Escape');
await win.getByRole('button',{name:'搜索',exact:true}).click();await win.getByPlaceholder('在笔记中搜索').fill('观察');await expect(win.getByText(/个文件，.*处命中/)).toBeVisible();await shot('05-search');
await win.getByRole('button',{name:'文件',exact:true}).click();await cmd('重命名');await expect(win.getByRole('dialog')).toBeVisible();await shot('06-rename');await win.keyboard.press('Escape');
await cmd('清理孤儿');await expect(win.getByRole('dialog')).toBeVisible();await shot('07-orphans');await win.keyboard.press('Escape');
await cmd('显示 / 隐藏历史栏');await expect(win.getByRole('complementary',{name:'历史'})).toBeVisible();await shot('08-history');await win.getByRole('complementary',{name:'历史'}).getByRole('button').last().click();await expect(win.locator('.monaco-diff-editor')).toBeVisible();await shot('09-history-diff');await win.getByRole('complementary',{name:'历史'}).getByRole('button').last().click();await cmd('显示 / 隐藏历史栏');
await win.keyboard.press('Meta+Shift+d');await expect(win.locator('.monaco-diff-editor')).toBeVisible();await shot('10-worktree-diff');await win.keyboard.press('Meta+Shift+d');
await win.getByRole('button',{name:'Git',exact:true}).click();await expect(win.getByPlaceholder('提交信息（⌘Enter 提交）')).toBeVisible();await win.getByPlaceholder('提交信息（⌘Enter 提交）').fill('整理步道记录，补充出行安排');await shot('11-git');await win.getByTitle('旧记录.md',{exact:true}).click();await expect(win.getByRole('dialog')).toBeVisible();await shot('11a-deleted-diff');await win.keyboard.press('Escape');await win.getByRole('button',{name:'push',exact:true}).click();await expect(win.getByText('push失败',{exact:true})).toBeVisible();await shot('11b-git-error');
await win.getByRole('button',{name:'文件',exact:true}).click();await open('公式与图示');await expect(win.locator('.cm-embed-mermaid svg')).toBeVisible({timeout:20000});await shot('12-embeds');await win.locator('.cm-embed-mermaid').click();await expect(win.getByRole('dialog')).toBeVisible();await shot('13-mermaid-editor');await win.keyboard.press('Escape');await win.locator('.cm-embed-math').click();await shot('14-math-editor');await win.keyboard.press('Escape');const ib=await win.locator('.cm-embed-inline').boundingBox();await win.mouse.click(ib.x+ib.width/2,ib.y+ib.height/2);await shot('15-inline-math');await win.keyboard.press('Escape');
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,650));await shot('16-narrow-editor');await app.close();app=null;
// Real merge state in the disposable fixture; no production data involved.
git('add','.');git('commit','-m','整理工作中的笔记');git('checkout','-b','incoming');put('冲突笔记.md','# 路线安排\n\n沿溪流向东走，午后返回。\n');git('add','.');git('commit','-m','添加路线安排');git('checkout','main');put('冲突笔记.md','# 路线安排\n\n沿山脊向北走，傍晚返回。\n');git('add','.');git('commit','-m','记录本地路线');try{git('merge','incoming')}catch{}
await launch();await expect(win.getByText(/合并中，还有/)).toBeVisible();await win.getByRole('button',{name:'Git',exact:true}).click();await win.waitForTimeout(2500);await win.getByTitle('冲突笔记.md',{exact:true}).click();await expect(win.locator('[data-conflict-view] .monaco-editor')).toBeVisible();await expect(win.locator('.codelens-decoration a',{hasText:'接受当前'}).first()).toBeVisible({timeout:15000});await shot('17-merge');await win.getByRole('button',{name:'放弃合并',exact:true}).click();await expect(win.getByRole('alertdialog')).toBeVisible();await shot('18-abort-merge');await win.keyboard.press('Escape');
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,650));await shot('19-narrow-merge');
}finally{if(app)await app.close();fs.writeFileSync(path.join(out,'metadata.json'),JSON.stringify({worktree:root,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),platform:process.platform,phase,viewport:'1280x800; narrow 900x650',fixture:base,frames},null,2));}})().catch(e=>{console.error(e);process.exitCode=1});
