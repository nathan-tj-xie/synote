// PROTOTYPE（#6）：两种 diff 方案并排对比，?variant=a|b 切换；用完即弃，不要合入 main
//   a = CM6 实时预览 + @codemirror/merge
//   b = CM6 实时预览 + Monaco diff editor
import { markdown } from '@codemirror/lang-markdown';
import { MergeView } from '@codemirror/merge';
import { EditorState, Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap';
import { basicSetup } from 'codemirror';
import { livePreview, livePreviewTheme } from './livePreview';
import { HEAD, WORKING } from './sample';

const VARIANTS = { a: 'CM6 + @codemirror/merge', b: 'CM6 + Monaco diff' } as const;
type Variant = keyof typeof VARIANTS;

const params = new URLSearchParams(location.search);
let variant: Variant = params.get('variant') === 'b' ? 'b' : 'a';
let mode: 'edit' | 'diff' = params.get('mode') === 'diff' ? 'diff' : 'edit';
let head = HEAD;
let working = WORKING;
let currentPath = '示例笔记.md';

const $ = (id: string) => document.getElementById(id)!;
const pane = $('pane');

// ---- 外壳适配：Electron 走 preload，Tauri 走 invoke，浏览器只有示例笔记 ----
type Shell = { name: string; listVault(): Promise<{ root: string; files: string[] }>; readNote(rel: string): Promise<string> };
declare global { interface Window { synote?: Shell; __TAURI_INTERNALS__?: unknown } }

async function detectShell(): Promise<Shell | null> {
  if (window.synote) return window.synote;
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return {
      name: 'Tauri',
      listVault: () => invoke('list_vault'),
      readNote: (rel) => invoke('read_note', { rel }),
    };
  }
  return null;
}

// ---- 共享的编辑器配置：字体与键位两种方案一致 ----
const FONT = '14px Menlo, "PingFang SC", "Microsoft YaHei", monospace';
const shared: Extension = [
  basicSetup,
  keymap.of(vscodeKeymap),
  markdown(),
  oneDark,
  EditorView.lineWrapping,
  EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { font: FONT } }),
];

let dispose: () => void = () => {};

function mountEdit() {
  const view = new EditorView({
    parent: pane,
    state: EditorState.create({
      doc: working,
      extensions: [
        shared,
        livePreview,
        livePreviewTheme,
        EditorView.theme({ '.cm-scroller': { font: '15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' } }),
        EditorView.updateListener.of((u) => { if (u.docChanged) working = u.state.doc.toString(); }),
      ],
    }),
  });
  view.focus();
  dispose = () => view.destroy();
}

function mountMerge() {
  const mv = new MergeView({
    parent: pane,
    a: { doc: head, extensions: [shared, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
    b: {
      doc: working,
      extensions: [shared, EditorView.updateListener.of((u) => { if (u.docChanged) working = u.state.doc.toString(); })],
    },
    revertControls: 'a-to-b',
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  mv.dom.style.height = '100%';
  mv.b.focus();
  dispose = () => mv.destroy();
}

async function mountMonaco() {
  const t0 = performance.now();
  const monaco = await import('./monaco');
  if (mode !== 'diff' || variant !== 'b') return; // 加载期间已切走
  const original = monaco.editor.createModel(head, 'markdown');
  const modified = monaco.editor.createModel(working, 'markdown');
  const de = monaco.editor.createDiffEditor(pane, {
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: 'Menlo, "PingFang SC", "Microsoft YaHei", monospace',
    fontSize: 14,
    wordWrap: 'on',
    diffWordWrap: 'on',
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderMarginRevertIcon: true,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
    experimental: { showMoves: true },
    minimap: { enabled: false },
  });
  de.setModel({ original, modified });
  modified.onDidChangeContent(() => { working = modified.getValue(); });
  de.getModifiedEditor().focus();
  stat('monaco 懒加载+挂载', performance.now() - t0);
  dispose = () => { de.dispose(); original.dispose(); modified.dispose(); };
}

function render() {
  dispose();
  dispose = () => {};
  pane.innerHTML = '';
  if (mode === 'edit') mountEdit();
  else if (variant === 'a') mountMerge();
  else void mountMonaco();
  $('mode-edit').classList.toggle('on', mode === 'edit');
  $('mode-diff').classList.toggle('on', mode === 'diff');
  $('variant-label').textContent = `${variant.toUpperCase()} (${VARIANTS[variant]})`;
  $('path').textContent = currentPath;
  const p = new URLSearchParams(location.search);
  p.set('variant', variant);
  p.set('mode', mode);
  history.replaceState(null, '', `?${p}`);
}

function setMode(m: typeof mode) { mode = m; render(); }
function cycle(step: number) {
  const keys = Object.keys(VARIANTS) as Variant[];
  variant = keys[(keys.indexOf(variant) + step + keys.length) % keys.length];
  render();
}

$('mode-edit').onclick = () => setMode('edit');
$('mode-diff').onclick = () => setMode('diff');
$('prev').onclick = () => cycle(-1);
$('next').onclick = () => cycle(1);
$('reset').onclick = () => { working = head === HEAD ? WORKING : head; render(); };
window.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+Shift+D：编辑 ↔ diff，两种方案用同一快捷键
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    setMode(mode === 'edit' ? 'diff' : 'edit');
    return;
  }
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') cycle(-1);
  if (e.key === 'ArrowRight') cycle(1);
}, true);

// ---- 性能数据 ----
function stat(label: string, ms: number) {
  const li = document.createElement('li');
  li.textContent = `${label}: ${ms.toFixed(0)} ms`;
  console.log(`[stat] ${li.textContent}`);
  // Tauri 的 WebKit console 不进终端，转发给 Rust 打印
  if (window.__TAURI_INTERNALS__) void import('@tauri-apps/api/core').then((m) => m.invoke('log', { msg: li.textContent }));
  $('stats').append(li);
}

async function openNote(shell: Shell, rel: string) {
  head = working = await shell.readNote(rel); // 无 git 时以打开时内容为 HEAD
  currentPath = rel;
  render();
}

async function boot() {
  const shell = await detectShell();
  $('shell').textContent = shell?.name ?? 'Browser';
  render();
  if (!shell) { $('tree').textContent = '浏览器模式：只有内置示例笔记。用 pnpm electron / pnpm tauri dev 打开 10k 库。'; return; }

  const t0 = performance.now();
  const { root, files } = await shell.listVault();
  const t1 = performance.now();
  $('tree').innerHTML = files.map((f) => `<div data-p="${f.replace(/"/g, '&quot;')}">${f}</div>`).join('');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const t2 = performance.now();
  if (files[0]) await openNote(shell, files[0]);
  await new Promise((r) => requestAnimationFrame(r));
  const t3 = performance.now();
  $('root').textContent = `${root}（${files.length} 篇）`;
  stat('列目录（IPC + fs）', t1 - t0);
  stat('文件树渲染', t2 - t1);
  stat('打开首篇笔记', t3 - t2);
  stat('自页面导航起到首屏', t3);
  $('tree').onclick = (e) => {
    const p = (e.target as HTMLElement).dataset.p;
    if (p) void openNote(shell, p);
  };
}

void boot();
