// PROTOTYPE：mermaid 独立编辑窗口——左侧源码、右侧实时预览，保存后整块写回笔记
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap';
import { basicSetup } from 'codemirror';
import { renderMermaid } from './livePreview';

export function openMermaidEditor(host: EditorView, from: number, to: number, src: string) {
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-modal';
  overlay.innerHTML = `<div class="mm-win">
    <div class="mm-bar">编辑 mermaid 图<span class="mm-hint">⌘S 保存 · Esc 取消</span>
      <button data-a="cancel">取消</button><button data-a="save" class="on">保存</button></div>
    <div class="mm-body"><div class="mm-code"></div><div class="mm-preview"></div></div></div>`;
  document.body.append(overlay);
  const preview = overlay.querySelector<HTMLElement>('.mm-preview')!;

  let timer = 0;
  const refresh = (text: string) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      renderMermaid(text)
        .then((svg) => { preview.innerHTML = svg; })
        .catch((e) => { preview.textContent = `mermaid error: ${e.message ?? e}`; });
    }, 200);
  };

  const close = (save: boolean) => {
    if (save) {
      host.dispatch({ changes: { from, to, insert: '```mermaid\n' + code.state.doc.toString().replace(/\n*$/, '') + '\n```' } });
    }
    code.destroy();
    overlay.remove();
    host.focus();
  };

  const code = new EditorView({
    parent: overlay.querySelector('.mm-code')!,
    doc: src.replace(/\n$/, ''),
    extensions: [
      keymap.of([
        { key: 'Mod-s', run: () => { close(true); return true; } },
        { key: 'Escape', run: () => { close(false); return true; } },
      ]),
      basicSetup,
      keymap.of(vscodeKeymap),
      markdown(),
      oneDark,
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { font: '14px Menlo, "PingFang SC", "Microsoft YaHei", monospace' } }),
      EditorView.updateListener.of((u) => { if (u.docChanged) refresh(u.state.doc.toString()); }),
    ],
  });
  overlay.onclick = (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a) close(a === 'save');
    else if (e.target === overlay) close(false);
  };
  refresh(src);
  code.focus();
}
