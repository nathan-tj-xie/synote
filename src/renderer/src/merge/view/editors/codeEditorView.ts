/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 照 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/editors/codeEditorView.ts
// 改写（MIT，见 merge/LICENSE.txt）：用 standalone 的 monaco.editor.create 代替依赖注入建的 CodeEditorWidget；
// 不进 workbench 的 Grid，靠 flex 布局和 automaticLayout 排版；没有标题栏工具条（TitleMenu），也不搬勾选框 gutter
// （上游 mergeEditor.showCheckboxes 默认关闭）

import * as monaco from 'monaco-editor/editor/editor.api.js';
import { Disposable, type IDisposable } from 'monaco-editor/base/common/lifecycle.js';
import { Selection } from 'monaco-editor/editor/common/core/selection.js';
import type { Range } from 'monaco-editor/editor/common/core/range.js';
import { autorun, derived, type IObservable, observableFromEvent, observableValue } from '../../observable';
import type { MergeEditorViewModel } from '../viewModel';

// 上游 dom.ts 的 h('div.a@name') 简化版：只建这里用到的结构
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (className) {
		e.className = className;
	}
	e.append(...children);
	return e;
}

export abstract class CodeEditorView extends Disposable {
	readonly model;

	// 上游是 protected，外面经 view.element 放进 Grid；这里由 MergeEditor 直接摆放 root
	public readonly htmlElements;

	protected readonly checkboxesVisible;
	protected readonly showDeletionMarkers;
	protected readonly useSimplifiedDecorations;

	public readonly editor: monaco.editor.IStandaloneCodeEditor;

	public updateOptions(newOptions: Readonly<monaco.editor.IEditorOptions>): void {
		this.editor.updateOptions(newOptions);
	}

	public readonly isFocused;

	public readonly cursorPosition;

	public readonly selection;

	public readonly cursorLineNumber;

	constructor(
		public readonly viewModel: IObservable<undefined | MergeEditorViewModel>,
		options: monaco.editor.IStandaloneEditorConstructionOptions,
	) {
		super();
		this.model = this.viewModel.map(m => /** @description model */ m?.model);
		const title = el('span', 'title');
		const description = el('span', 'description');
		const detail = el('span', 'detail');
		const header = el('div', 'header', [title, description, detail]);
		const editor = el('div', 'editor');
		this.htmlElements = {
			root: el('div', 'code-view', [header, el('div', 'container', [editor])]),
			header, title, description, detail, editor,
		};
		// 不读配置，取上游的默认值
		this.checkboxesVisible = observableValue<boolean>(this, false);
		this.showDeletionMarkers = observableValue<boolean>(this, true);
		this.useSimplifiedDecorations = observableValue<boolean>(this, false);
		this.editor = this._register(monaco.editor.create(this.htmlElements.editor, { ...options, automaticLayout: true }));
		this.isFocused = observableFromEvent(this,
			(listener: (e: unknown) => void) => {
				const a = this.editor.onDidBlurEditorWidget(listener);
				const b = this.editor.onDidFocusEditorWidget(listener);
				return { dispose: () => { a.dispose(); b.dispose(); } };
			},
			() => /** @description editor.hasWidgetFocus */ this.editor.hasWidgetFocus()
		);
		this.cursorPosition = observableFromEvent(this,
			this.editor.onDidChangeCursorPosition,
			() => /** @description editor.getPosition */ this.editor.getPosition()
		);
		this.selection = observableFromEvent(this,
			this.editor.onDidChangeCursorSelection,
			() => /** @description editor.getSelections */ this.editor.getSelections()
		);
		this.cursorLineNumber = this.cursorPosition.map(p => /** @description cursorPosition.lineNumber */ p?.lineNumber);
	}
}

export function createSelectionsAutorun(
	codeEditorView: CodeEditorView,
	translateRange: (baseRange: Range, viewModel: MergeEditorViewModel) => Range
): IDisposable {
	const selections = derived(reader => {
		/** @description selections */
		const viewModel = codeEditorView.viewModel.read(reader);
		if (!viewModel) {
			return [];
		}
		const baseRange = viewModel.selectionInBase.read(reader);
		if (!baseRange || baseRange.sourceEditor === codeEditorView) {
			return [];
		}
		return baseRange.rangesInBase.map(r => translateRange(r, viewModel));
	});

	return autorun(reader => {
		/** @description set selections */
		const ranges = selections.read(reader);
		if (ranges.length === 0) {
			return;
		}
		codeEditorView.editor.setSelections(ranges.map(r => new Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)));
	});
}
