/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 照 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/mergeEditor.ts
// 改写（MIT，见 merge/LICENSE.txt）。不是 workbench 的 EditorPane：没有 EditorInput、依赖注入、context key、视图状态存储、遥测。
// 保留的结构：setModel 对应 setInput（建视图模型、按布局放对齐用的 view zone、首次定位到第一个冲突），
// applyLayout / toggleShowBaseTop / toggleShowBaseCenter 对应上游的布局切换，setViewZones 照搬。
// 布局只有上游的 columns 一种：左 input1（当前）｜中 结果｜右 input2（传入）；共同祖先栏放顶部或当前与结果之间，
// 放中间时和其他栏逐行对齐（上游 columns 布局里共同祖先只能放顶部）。分栏不可拖动，靠 flex 平分

import * as monaco from 'monaco-editor/editor/editor.api.js';
import { Disposable, DisposableStore, type IDisposable } from 'monaco-editor/base/common/lifecycle.js';
import { autorunWithStore, type IReader, observableValue, transaction } from '../observable';
import type { MergeEditorModel } from '../model/mergeEditorModel';
import { BaseCodeEditorView } from './editors/baseCodeEditorView';
import { el } from './editors/codeEditorView';
import { InputCodeEditorView } from './editors/inputCodeEditorView';
import { ResultCodeEditorView } from './editors/resultCodeEditorView';
import type { ConflictActionLabels } from './conflictActions';
import { ScrollSynchronizer } from './scrollSynchronizer';
import { MergeEditorViewModel } from './viewModel';
import { ViewZoneComputer } from './viewZones';
import './mergeEditor.css';

type ICodeEditor = monaco.editor.ICodeEditor;
type IViewZoneChangeAccessor = monaco.editor.IViewZoneChangeAccessor;
// ScrollType.Smooth
const ScrollTypeSmooth = 0;

export interface IMergeEditorLayout {
	readonly showBase: boolean;
	readonly showBaseAtTop: boolean;
}

export interface MergeEditorLabels {
	result: { title: string; remaining: (count: number) => string; next: string; allHandled: string };
	base: { title: string; compareWith: (title: string) => string; compareWithTooltip: string };
	actions: ConflictActionLabels;
}

// 上游存在 profile 存储里；这里记在内存，切换笔记、关掉再打开都沿用，重启后回到默认（隐藏）
let lastLayout: IMergeEditorLayout = { showBase: false, showBaseAtTop: true };

export class MergeEditor extends Disposable {
	private readonly _sessionDisposables = this._register(new DisposableStore());
	private readonly _viewModel = observableValue<MergeEditorViewModel | undefined>(this, undefined);
	public get viewModel() { return this._viewModel; }

	public readonly root = el('div', 'merge-editor');
	private readonly top = el('div', 'merge-editor-top');
	private readonly columns = el('div', 'merge-editor-columns');

	private readonly input1View;
	private readonly baseView = observableValue<BaseCodeEditorView | undefined>(this, undefined);
	private readonly input2View;
	private readonly inputResultView;
	private readonly _layoutModeObs = observableValue<IMergeEditorLayout>(this, lastLayout);
	private readonly viewZoneComputer;
	private readonly scrollSynchronizer;
	private readonly baseViewDisposables = this._register(new DisposableStore());
	// 上游 mergeEditor/showNonConflictingChanges 默认关闭
	private readonly showNonConflictingChanges = observableValue(this, false);

	constructor(
		parent: HTMLElement,
		private readonly options: monaco.editor.IStandaloneEditorConstructionOptions,
		private readonly labels: MergeEditorLabels,
	) {
		super();
		parent.append(this.root);
		this.root.append(this.top, this.columns);
		this._register({ dispose: () => this.root.remove() });

		// 对应上游 applyOptions：输入栏只读、不要 glyph margin
		const inputOptions = { ...options, minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 2 };
		const readOnlyInputOptions = { ...inputOptions, readOnly: true, readOnlyMessage: undefined };
		this.input1View = this._register(new InputCodeEditorView(1, this._viewModel, readOnlyInputOptions));
		this.input2View = this._register(new InputCodeEditorView(2, this._viewModel, readOnlyInputOptions));
		this.inputResultView = this._register(new ResultCodeEditorView(this._viewModel, inputOptions, labels.result));

		this.viewZoneComputer = new ViewZoneComputer(
			this.input1View.editor,
			this.input2View.editor,
			this.inputResultView.editor,
			labels.actions,
		);
		this._register(this.viewZoneComputer);
		this.scrollSynchronizer = this._register(new ScrollSynchronizer(this._viewModel, this.input1View, this.input2View, this.baseView, this.inputResultView, this._layoutModeObs));

		this.applyLayout(lastLayout);
	}

	public get layout(): IMergeEditorLayout {
		return this._layoutModeObs.get();
	}

	public get resultEditor(): ICodeEditor {
		return this.inputResultView.editor;
	}

	public get input1Editor(): ICodeEditor {
		return this.input1View.editor;
	}

	public get input2Editor(): ICodeEditor {
		return this.input2View.editor;
	}

	// 对应上游 setInput：模型由调用方建好，归调用方销毁
	public setModel(model: MergeEditorModel): void {
		this._sessionDisposables.clear();
		transaction(tx => {
			this._viewModel.set(undefined, tx);
		});

		const viewModel = new MergeEditorViewModel(
			model,
			this.input1View,
			this.input2View,
			this.inputResultView,
			this.baseView,
			this.showNonConflictingChanges,
		);

		transaction(tx => {
			this._viewModel.set(viewModel, tx);
		});
		this._sessionDisposables.add(viewModel);
		this._sessionDisposables.add({ dispose: () => transaction(tx => this._viewModel.set(undefined, tx)) });

		const viewZoneRegistrationStore = new DisposableStore();
		this._sessionDisposables.add(viewZoneRegistrationStore);
		// Set the view zones before restoring view state!
		// Otherwise scrolling will be off
		this._sessionDisposables.add(autorunWithStore((reader) => {
			/** @description update alignment view zones */
			const baseView = this.baseView.read(reader);

			const resultScrollTop = this.inputResultView.editor.getScrollTop();
			this.scrollSynchronizer.stopSync();

			viewZoneRegistrationStore.clear();

			this.inputResultView.editor.changeViewZones(resultViewZoneAccessor => {
				const layout = this._layoutModeObs.read(reader);
				const shouldAlignResult = true;
				const shouldAlignBase = layout.showBase && !layout.showBaseAtTop;

				this.input1View.editor.changeViewZones(input1ViewZoneAccessor => {
					this.input2View.editor.changeViewZones(input2ViewZoneAccessor => {
						if (baseView) {
							baseView.editor.changeViewZones(baseViewZoneAccessor => {
								viewZoneRegistrationStore.add(this.setViewZones(reader,
									viewModel,
									this.input1View.editor,
									input1ViewZoneAccessor,
									this.input2View.editor,
									input2ViewZoneAccessor,
									baseView.editor,
									baseViewZoneAccessor,
									shouldAlignBase,
									this.inputResultView.editor,
									resultViewZoneAccessor,
									shouldAlignResult
								));
							});
						} else {
							viewZoneRegistrationStore.add(this.setViewZones(reader,
								viewModel,
								this.input1View.editor,
								input1ViewZoneAccessor,
								this.input2View.editor,
								input2ViewZoneAccessor,
								undefined,
								undefined,
								false,
								this.inputResultView.editor,
								resultViewZoneAccessor,
								shouldAlignResult
							));
						}
					});
				});
			});

			this.inputResultView.editor.setScrollTop(resultScrollTop, ScrollTypeSmooth);

			this.scrollSynchronizer.startSync();
			this.scrollSynchronizer.updateScrolling();
		}));

		let disposed = false;
		this._sessionDisposables.add({ dispose: () => { disposed = true; } });
		model.onInitialized.then(() => {
			if (disposed) {
				return;
			}
			const firstConflict = model.modifiedBaseRanges.get().find(r => r.isConflicting);
			if (!firstConflict) {
				return;
			}
			this.input1View.editor.revealLineInCenter(firstConflict.input1Range.startLineNumber);
			transaction(tx => {
				/** @description setActiveModifiedBaseRange */
				viewModel.setActiveModifiedBaseRange(firstConflict, tx);
			});
		});
	}

	private setViewZones(
		reader: IReader,
		viewModel: MergeEditorViewModel,
		input1Editor: ICodeEditor,
		input1ViewZoneAccessor: IViewZoneChangeAccessor,
		input2Editor: ICodeEditor,
		input2ViewZoneAccessor: IViewZoneChangeAccessor,
		baseEditor: ICodeEditor | undefined,
		baseViewZoneAccessor: IViewZoneChangeAccessor | undefined,
		shouldAlignBase: boolean,
		resultEditor: ICodeEditor,
		resultViewZoneAccessor: IViewZoneChangeAccessor,
		shouldAlignResult: boolean,
	): IDisposable {
		const input1ViewZoneIds: string[] = [];
		const input2ViewZoneIds: string[] = [];
		const baseViewZoneIds: string[] = [];
		const resultViewZoneIds: string[] = [];

		const viewZones = this.viewZoneComputer.computeViewZones(reader, viewModel, {
			codeLensesVisible: true,
			showNonConflictingChanges: this.showNonConflictingChanges.read(reader),
			shouldAlignBase,
			shouldAlignResult,
		});

		const disposableStore = new DisposableStore();

		if (baseViewZoneAccessor) {
			for (const v of viewZones.baseViewZones) {
				v.create(baseViewZoneAccessor, baseViewZoneIds, disposableStore);
			}
		}

		for (const v of viewZones.resultViewZones) {
			v.create(resultViewZoneAccessor, resultViewZoneIds, disposableStore);
		}

		for (const v of viewZones.input1ViewZones) {
			v.create(input1ViewZoneAccessor, input1ViewZoneIds, disposableStore);
		}

		for (const v of viewZones.input2ViewZones) {
			v.create(input2ViewZoneAccessor, input2ViewZoneIds, disposableStore);
		}

		disposableStore.add({
			dispose: () => {
				input1Editor.changeViewZones(a => {
					for (const zone of input1ViewZoneIds) {
						a.removeZone(zone);
					}
				});
				input2Editor.changeViewZones(a => {
					for (const zone of input2ViewZoneIds) {
						a.removeZone(zone);
					}
				});
				baseEditor?.changeViewZones(a => {
					for (const zone of baseViewZoneIds) {
						a.removeZone(zone);
					}
				});
				resultEditor.changeViewZones(a => {
					for (const zone of resultViewZoneIds) {
						a.removeZone(zone);
					}
				});
			}
		});

		return disposableStore;
	}

	// 对应上游 clearInput
	public clearModel(): void {
		this._sessionDisposables.clear();
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			editor.setModel(null);
		}
		this.baseView.get()?.editor.setModel(null);
	}

	public focus(): void {
		this.inputResultView.editor.focus();
	}

	// 交接锁期间（pull、放弃合并等改写工作区时）结果栏只读，冲突块上的操作也点不了：它们直接改结果模型，不经编辑器的只读检查
	public setReadOnly(on: boolean): void {
		this.inputResultView.editor.updateOptions({ readOnly: on });
		this.root.classList.toggle('read-only', on);
	}

	// --- layout

	public toggleBase(): void {
		this.setLayout({
			...this.layout,
			showBase: !this.layout.showBase
		});
	}

	public toggleShowBaseTop(): void {
		const showBaseTop = this.layout.showBase && this.layout.showBaseAtTop;
		this.setLayout({
			...this.layout,
			showBaseAtTop: true,
			showBase: !showBaseTop,
		});
	}

	public toggleShowBaseCenter(): void {
		const showBaseCenter = this.layout.showBase && !this.layout.showBaseAtTop;
		this.setLayout({
			...this.layout,
			showBaseAtTop: false,
			showBase: !showBaseCenter,
		});
	}

	public setLayout(newLayout: IMergeEditorLayout): void {
		const value = this.layout;
		if (JSON.stringify(value) === JSON.stringify(newLayout)) {
			return;
		}
		this.applyLayout(newLayout);
	}

	private applyLayout(layout: IMergeEditorLayout): void {
		transaction(tx => {
			/** @description applyLayout */

			if (layout.showBase && !this.baseView.get()) {
				this.baseViewDisposables.clear();
				const baseView = this.baseViewDisposables.add(
					new BaseCodeEditorView(
						this.viewModel,
						{ ...this.options, minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 2, readOnly: true, readOnlyMessage: undefined },
						this.labels.base,
					)
				);
				this.baseView.set(baseView, tx);
			} else if (!layout.showBase && this.baseView.get()) {
				this.baseView.set(undefined, tx);
				this.baseViewDisposables.clear();
			}

			// 上游这里重建 Grid；这里只是把各栏的 DOM 放到顶部 / 分栏里
			const base = this.baseView.get()?.htmlElements.root;
			this.top.replaceChildren(...(base && layout.showBaseAtTop ? [base] : []));
			this.top.hidden = !(base && layout.showBaseAtTop);
			this.columns.replaceChildren(...[
				this.input1View.htmlElements.root,
				base && !layout.showBaseAtTop ? base : undefined,
				this.inputResultView.htmlElements.root,
				this.input2View.htmlElements.root,
			].filter((e): e is HTMLDivElement => !!e));

			lastLayout = layout;
			this._layoutModeObs.set(layout, tx);
		});
	}
}
