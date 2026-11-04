// PROTOTYPE：最小实时预览——光标不在的节点隐藏标记，mermaid 块渲染为 SVG
import { syntaxTree } from '@codemirror/language';
import { EditorState, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import mermaid from 'mermaid';
import { openMermaidEditor } from './mermaidEditor';

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

const svgCache = new Map<string, string>();
let seq = 0;

export async function renderMermaid(src: string): Promise<string> {
  const cached = svgCache.get(src);
  if (cached) return cached;
  const { svg } = await mermaid.render(`m${seq++}`, src);
  svgCache.set(src, svg);
  return svg;
}

class MermaidWidget extends WidgetType {
  constructor(readonly src: string) { super(); }
  eq(o: MermaidWidget) { return o.src === this.src; }
  get estimatedHeight() { return 200; }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'cm-mermaid';
    el.title = '点击在独立窗口中编辑 mermaid 源码';
    el.textContent = 'rendering…';
    renderMermaid(this.src)
      .then((svg) => { el.innerHTML = svg; view.requestMeasure(); })
      .catch((e) => { el.textContent = `mermaid error: ${e.message ?? e}`; });
    // 点击图 → 打开独立的编辑窗口，正文里的图保持渲染态；位置在点击时现算，避免 widget 复用后位置过期
    el.onmousedown = (e) => {
      e.preventDefault();
      let node = syntaxTree(view.state).resolveInner(view.posAtDOM(el), 1);
      while (node.name !== 'FencedCode' && node.parent) node = node.parent;
      if (node.name === 'FencedCode') openMermaidEditor(view, node.from, node.to, this.src);
    };
    return el;
  }
  ignoreEvent() { return false; }
}

const hide = Decoration.replace({});
const HIDE_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark']);

function build(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const touches = (from: number, to: number) => sel.from <= to && sel.to >= from;
  const doc = state.doc;

  syntaxTree(state).iterate({
    enter(n) {
      const parent = n.node.parent;
      if (/^ATXHeading[1-6]$/.test(n.name)) {
        decos.push(Decoration.line({ class: `cm-lp-h${n.name.slice(-1)}` }).range(doc.lineAt(n.from).from));
      }
      if (n.name === 'FencedCode') {
        const info = n.node.getChild('CodeInfo');
        // mermaid 块始终渲染为图，不随光标切换成源码
        if (info && doc.sliceString(info.from, info.to) === 'mermaid') {
          const text = n.node.getChild('CodeText');
          const src = text ? doc.sliceString(text.from, text.to) : '';
          decos.push(Decoration.replace({ widget: new MermaidWidget(src), block: true }).range(n.from, n.to));
        }
        return false;
      }
      if (n.name === 'StrongEmphasis') decos.push(Decoration.mark({ class: 'cm-lp-strong' }).range(n.from, n.to));
      if (n.name === 'Emphasis') decos.push(Decoration.mark({ class: 'cm-lp-em' }).range(n.from, n.to));
      if (n.name === 'Link' && !touches(n.from, n.to)) {
        // [名字](路径.md) → 只显示名字
        const marks = n.node.getChildren('LinkMark');
        if (marks.length >= 2) {
          decos.push(hide.range(marks[0].from, marks[0].to));
          decos.push(Decoration.mark({ class: 'cm-lp-link' }).range(marks[0].to, marks[1].from));
          decos.push(hide.range(marks[1].from, n.to));
        }
        return false;
      }
      if (HIDE_MARKS.has(n.name) && parent && !touches(parent.from, parent.to)) {
        // 标题标记连带后面的空格一起隐藏
        const to = n.name === 'HeaderMark' && doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to;
        decos.push(hide.range(n.from, to));
      }
    },
  });
  return Decoration.set(decos, true);
}

export const livePreview = StateField.define<DecorationSet>({
  create: build,
  update: (v, tr) => (tr.docChanged || tr.selection ? build(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
});

export const livePreviewTheme = EditorView.baseTheme({
  '.cm-lp-h1': { fontSize: '1.8em', fontWeight: '700' },
  '.cm-lp-h2': { fontSize: '1.45em', fontWeight: '700' },
  '.cm-lp-h3': { fontSize: '1.2em', fontWeight: '700' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-link': { color: '#7aa2f7', textDecoration: 'underline', cursor: 'pointer' },
  '.cm-mermaid': { padding: '8px', background: '#1e2230', borderRadius: '6px', cursor: 'pointer', textAlign: 'center' },
});
