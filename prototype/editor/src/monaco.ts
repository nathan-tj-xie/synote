// PROTOTYPE：Monaco 只加载 diff 需要的部分，worker 走 Vite ?worker
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/markdown/register';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
export const editor = monaco.editor;
