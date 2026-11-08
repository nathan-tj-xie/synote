/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/scrollSynchronizer.ts（MIT，见 LICENSE.txt）

import { Disposable } from 'monaco-editor/base/common/lifecycle.js';
import { BugIndicatingError } from 'monaco-editor/base/common/errors.js';
import type { editor } from 'monaco-editor';
import { derived, type IObservable } from '../observable';
import { DocumentLineRangeMap } from '../model/mapping';
import { ReentrancyBarrier } from '../base';
import type { BaseCodeEditorView } from './editors/baseCodeEditorView';
import type { IMergeEditorLayout } from './mergeEditor';
import type { MergeEditorViewModel } from './viewModel';
import type { InputCodeEditorView } from './editors/inputCodeEditorView';
import type { ResultCodeEditorView } from './editors/resultCodeEditorView';
import type { CodeEditorView } from './editors/codeEditorView';

type CodeEditorWidget = editor.ICodeEditor;
// ScrollType.Immediate（src/vs/editor/common/editorCommon.ts）
const ScrollType = { Immediate: 1 } as const;
const isDefined = <T>(v: T | undefined | null): v is T => v !== undefined && v !== null;

export class ScrollSynchronizer extends Disposable {
	private get model() { return this.viewModel.get()?.model; }

	private readonly reentrancyBarrier = new ReentrancyBarrier();

	public readonly updateScrolling: () => void;

	// 只有 columns 布局：结果栏总和两侧锁定。共同祖先栏放在三栏之间时同样逐行对齐（见 mergeEditor.ts 的 shouldAlignBase），也锁定
	private get lockResultWithInputs() { return true; }
	private get lockBaseWithInputs() { return this.layout.get().showBase && !this.layout.get().showBaseAtTop; }

	private _isSyncing = true;

	constructor(
		private readonly viewModel: IObservable<MergeEditorViewModel | undefined>,
		private readonly input1View: InputCodeEditorView,
		private readonly input2View: InputCodeEditorView,
		private readonly baseView: IObservable<BaseCodeEditorView | undefined>,
		private readonly inputResultView: ResultCodeEditorView,
		private readonly layout: IObservable<IMergeEditorLayout>,
	) {
		super();

		const s = derived((reader) => {
			const baseView = this.baseView.read(reader);
			const editors = [this.input1View, this.input2View, this.inputResultView, baseView].filter(isDefined);

			const alignScrolling = (source: CodeEditorView, updateScrollLeft: boolean, updateScrollTop: boolean) => {
				this.reentrancyBarrier.runExclusivelyOrSkip(() => {
					if (updateScrollLeft) {
						const scrollLeft = source.editor.getScrollLeft();
						for (const editorView of editors) {
							if (editorView !== source) {
								editorView.editor.setScrollLeft(scrollLeft, ScrollType.Immediate);
							}
						}
					}
					if (updateScrollTop) {
						const scrollTop = source.editor.getScrollTop();
						for (const editorView of editors) {
							if (editorView !== source) {
								if (this._shouldLock(source, editorView)) {
									editorView.editor.setScrollTop(scrollTop, ScrollType.Immediate);
								} else {
									const m = this._getMapping(source, editorView);
									if (m) {
										this._synchronizeScrolling(source.editor, editorView.editor, m);
									}
								}
							}
						}
					}
				});
			};

			for (const editorView of editors) {
				reader.store.add(editorView.editor.onDidScrollChange(e => {
					if (!this._isSyncing) {
						return;
					}
					alignScrolling(editorView, e.scrollLeftChanged, e.scrollTopChanged);
				}));
			}

			return {
				update: () => {
					alignScrolling(this.inputResultView, true, true);
				}
			};
		}).recomputeInitiallyAndOnChange(this._store);

		this.updateScrolling = () => {
			s.get().update();
		};
	}

	public stopSync(): void {
		this._isSyncing = false;
	}

	public startSync(): void {
		this._isSyncing = true;
	}

	private _shouldLock(editor1: CodeEditorView, editor2: CodeEditorView): boolean {
		const isInput = (editor: CodeEditorView) => editor === this.input1View || editor === this.input2View;
		if (isInput(editor1) && editor2 === this.inputResultView || isInput(editor2) && editor1 === this.inputResultView) {
			return this.lockResultWithInputs;
		}
		if (isInput(editor1) && editor2 === this.baseView.get() || isInput(editor2) && editor1 === this.baseView.get()) {
			return this.lockBaseWithInputs;
		}
		if (isInput(editor1) && isInput(editor2)) {
			return true;
		}
		// 上游 mixed 布局里结果栏和共同祖先栏从不同时对齐；这里两者都对齐时一起锁定，滚动结果栏不会让共同祖先栏按映射错开
		if (editor1 === this.inputResultView && editor2 === this.baseView.get() || editor2 === this.inputResultView && editor1 === this.baseView.get()) {
			return this.lockBaseWithInputs;
		}
		return false;
	}

	private _getMapping(editor1: CodeEditorView, editor2: CodeEditorView): DocumentLineRangeMap | undefined {
		if (editor1 === this.input1View) {
			if (editor2 === this.input2View) {
				return undefined;
			} else if (editor2 === this.inputResultView) {
				return this.model?.input1ResultMapping.get()!;
			} else if (editor2 === this.baseView.get()) {
				const b = this.model?.baseInput1Diffs.get();
				if (!b) { return undefined; }
				return new DocumentLineRangeMap(b, -1).reverse();
			}
		} else if (editor1 === this.input2View) {
			if (editor2 === this.input1View) {
				return undefined;
			} else if (editor2 === this.inputResultView) {
				return this.model?.input2ResultMapping.get()!;
			} else if (editor2 === this.baseView.get()) {
				const b = this.model?.baseInput2Diffs.get();
				if (!b) { return undefined; }
				return new DocumentLineRangeMap(b, -1).reverse();
			}
		} else if (editor1 === this.inputResultView) {
			if (editor2 === this.input1View) {
				return this.model?.resultInput1Mapping.get()!;
			} else if (editor2 === this.input2View) {
				return this.model?.resultInput2Mapping.get()!;
			} else if (editor2 === this.baseView.get()) {
				const b = this.model?.resultBaseMapping.get();
				if (!b) { return undefined; }
				return b;
			}
		} else if (editor1 === this.baseView.get()) {
			if (editor2 === this.input1View) {
				const b = this.model?.baseInput1Diffs.get();
				if (!b) { return undefined; }
				return new DocumentLineRangeMap(b, -1);
			} else if (editor2 === this.input2View) {
				const b = this.model?.baseInput2Diffs.get();
				if (!b) { return undefined; }
				return new DocumentLineRangeMap(b, -1);
			} else if (editor2 === this.inputResultView) {
				const b = this.model?.baseResultMapping.get();
				if (!b) { return undefined; }
				return b;
			}
		}

		throw new BugIndicatingError();
	}

	private _synchronizeScrolling(scrollingEditor: CodeEditorWidget, targetEditor: CodeEditorWidget, mapping: DocumentLineRangeMap | undefined) {
		if (!mapping) {
			return;
		}

		const visibleRanges = scrollingEditor.getVisibleRanges();
		if (visibleRanges.length === 0) {
			return;
		}
		const topLineNumber = visibleRanges[0].startLineNumber - 1;

		const result = mapping.project(topLineNumber);
		const sourceRange = result.inputRange;
		const targetRange = result.outputRange;

		const resultStartTopPx = targetEditor.getTopForLineNumber(targetRange.startLineNumber);
		const resultEndPx = targetEditor.getTopForLineNumber(targetRange.endLineNumberExclusive);

		const sourceStartTopPx = scrollingEditor.getTopForLineNumber(sourceRange.startLineNumber);
		const sourceEndPx = scrollingEditor.getTopForLineNumber(sourceRange.endLineNumberExclusive);

		const factor = Math.min((scrollingEditor.getScrollTop() - sourceStartTopPx) / (sourceEndPx - sourceStartTopPx), 1);
		const resultScrollPosition = resultStartTopPx + (resultEndPx - resultStartTopPx) * factor;

		targetEditor.setScrollTop(resultScrollPosition, ScrollType.Immediate);
	}
}
