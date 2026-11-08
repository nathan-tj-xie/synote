/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/conflictActions.ts（MIT，见 LICENSE.txt）

import { Disposable, type IDisposable } from 'monaco-editor/base/common/lifecycle.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { autorun, derived, type IObservable, transaction } from '../observable';
import { ModifiedBaseRange, ModifiedBaseRangeState, ModifiedBaseRangeStateKind } from '../model/modifiedBaseRange';
import { FixedZoneWidget } from './fixedZoneWidget';
import type { MergeEditorViewModel } from './viewModel';

type ICodeEditor = monaco.editor.ICodeEditor;
type IViewZoneChangeAccessor = monaco.editor.IViewZoneChangeAccessor;
const { EditorOption } = monaco.editor;
// 文案由调用方按 i18n 给出：key 是上游 localize 的 key，title 是 {0} 处的输入栏标题
export type ConflictActionLabels = (key: string, title?: string) => string;
// 上游 dom.ts 的 $(tag, attrs, ...children)
function $(tag: 'span' | 'a', attrs: { title?: string; role?: string; onclick?: () => void } | undefined, ...children: string[]): HTMLElement {
	const e = document.createElement(tag);
	if (attrs?.title) { e.title = attrs.title; }
	if (attrs?.role) { e.setAttribute('role', attrs.role); }
	if (attrs?.onclick) { e.onclick = attrs.onclick; }
	e.append(...children);
	return e;
}

export class ConflictActionsFactory extends Disposable {
	private readonly _styleClassName: string;
	private readonly _styleElement: HTMLStyleElement;

	constructor(private readonly _editor: ICodeEditor) {
		super();

		this._register(this._editor.onDidChangeConfiguration((e) => {
			if (e.hasChanged(EditorOption.fontInfo) || e.hasChanged(EditorOption.codeLensFontSize) || e.hasChanged(EditorOption.codeLensFontFamily)) {
				this._updateLensStyle();
			}
		}));

		// 编辑器 id 本身就唯一，不用再取 hash；样式表随工厂销毁
		this._styleClassName = '_conflictActionsFactory_' + this._editor.getId().replace(/\W/g, '_');
		this._styleElement = document.head.appendChild(document.createElement('style'));
		this._register({ dispose: () => this._styleElement.remove() });

		this._updateLensStyle();
	}

	private _updateLensStyle(): void {
		const { codeLensHeight, fontSize } = this._getLayoutInfo();
		const fontFamily = this._editor.getOption(EditorOption.codeLensFontFamily);
		const editorFontInfo = this._editor.getOption(EditorOption.fontInfo);

		const fontFamilyVar = `--codelens-font-family${this._styleClassName}`;
		const fontFeaturesVar = `--codelens-font-features${this._styleClassName}`;

		let newStyle = `
		.${this._styleClassName} { line-height: ${codeLensHeight}px; font-size: ${fontSize}px; padding-right: ${Math.round(fontSize * 0.5)}px; font-feature-settings: var(${fontFeaturesVar}) }
		`;
		if (fontFamily) {
			newStyle += `.${this._styleClassName} { font-family: var(${fontFamilyVar}), inherit}`;
		}
		this._styleElement.textContent = newStyle;
		this._editor.getContainerDomNode().style?.setProperty(fontFamilyVar, fontFamily ?? 'inherit');
		this._editor.getContainerDomNode().style?.setProperty(fontFeaturesVar, editorFontInfo.fontFeatureSettings);
	}

	private _getLayoutInfo() {
		const lineHeightFactor = Math.max(1.3, this._editor.getOption(EditorOption.lineHeight) / this._editor.getOption(EditorOption.fontSize));
		let fontSize = this._editor.getOption(EditorOption.codeLensFontSize);
		if (!fontSize || fontSize < 5) {
			fontSize = (this._editor.getOption(EditorOption.fontSize) * .9) | 0;
		}
		return {
			fontSize,
			codeLensHeight: (fontSize * lineHeightFactor) | 0,
		};
	}

	// 操作行 view zone 的高度：共同祖先栏放中间时要留同样高的占位，各栏才对得齐
	public get widgetHeight(): number {
		return this._getLayoutInfo().codeLensHeight + 2;
	}

	public createWidget(viewZoneChangeAccessor: IViewZoneChangeAccessor, lineNumber: number, items: IObservable<IContentWidgetAction[]>, viewZoneIdsToCleanUp: string[]): IDisposable {
		const layoutInfo = this._getLayoutInfo();
		return new ActionsContentWidget(
			this._editor,
			viewZoneChangeAccessor,
			lineNumber,
			layoutInfo.codeLensHeight + 2,
			this._styleClassName,
			items,
			viewZoneIdsToCleanUp,
		);
	}
}

export class ActionsSource {
	constructor(
		private readonly viewModel: MergeEditorViewModel,
		private readonly modifiedBaseRange: ModifiedBaseRange,
		private readonly t: ConflictActionLabels,
	) {
	}

	private getItemsInput(inputNumber: 1 | 2): IObservable<IContentWidgetAction[]> {
		return derived(reader => {
			/** @description items */
			const viewModel = this.viewModel;
			const modifiedBaseRange = this.modifiedBaseRange;

			if (!viewModel.model.hasBaseRange(modifiedBaseRange)) {
				return [];
			}

			const state = viewModel.model.getState(modifiedBaseRange).read(reader);
			const handled = viewModel.model.isHandled(modifiedBaseRange).read(reader);
			const model = viewModel.model;

			const result: IContentWidgetAction[] = [];

			const inputData = inputNumber === 1 ? viewModel.model.input1 : viewModel.model.input2;
			const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader);

			if (!modifiedBaseRange.isConflicting && handled && !showNonConflictingChanges) {
				return [];
			}

			const otherInputNumber = inputNumber === 1 ? 2 : 1;

			if (state.kind !== ModifiedBaseRangeStateKind.unrecognized && !state.isInputIncluded(inputNumber)) {
				if (!state.isInputIncluded(otherInputNumber) || !this.viewModel.shouldUseAppendInsteadOfAccept.read(reader)) {
					result.push(
						command(this.t('accept', inputData.title), async () => {
							transaction((tx) => {
								model.setState(
									modifiedBaseRange,
									state.withInputValue(inputNumber, true, false),
									inputNumber,
									tx
								);
							});
						}, this.t('acceptTooltip', inputData.title))
					);

					if (modifiedBaseRange.canBeCombined) {
						const commandName = modifiedBaseRange.isOrderRelevant
							? this.t('acceptBoth0First', inputData.title)
							: this.t('acceptBoth');

						result.push(
							command(commandName, async () => {
								transaction((tx) => {
									model.setState(
										modifiedBaseRange,
										ModifiedBaseRangeState.base
											.withInputValue(inputNumber, true)
											.withInputValue(otherInputNumber, true, true),
										true,
										tx
									);
								});
							}, this.t('acceptBothTooltip')),
						);
					}
				} else {
					result.push(
						command(this.t('append', inputData.title), async () => {
							transaction((tx) => {
								model.setState(
									modifiedBaseRange,
									state.withInputValue(inputNumber, true, false),
									inputNumber,
									tx
								);
							});
						}, this.t('appendTooltip', inputData.title))
					);

					if (modifiedBaseRange.canBeCombined) {
						result.push(
							command(this.t('combine', inputData.title), async () => {
								transaction((tx) => {
									model.setState(
										modifiedBaseRange,
										state.withInputValue(inputNumber, true, true),
										inputNumber,
										tx
									);
								});
							}, this.t('acceptBothTooltip')),
						);
					}
				}

				if (!model.isInputHandled(modifiedBaseRange, inputNumber).read(reader)) {
					result.push(
						command(
							this.t('ignore'),
							async () => {
								transaction((tx) => {
									model.setInputHandled(modifiedBaseRange, inputNumber, true, tx);
								});
							},
							this.t('markAsHandledTooltip')
						)
					);
				}

			}
			return result;
		});
	}

	public readonly itemsInput1 = this.getItemsInput(1);
	public readonly itemsInput2 = this.getItemsInput(2);

	public readonly resultItems = derived(this, reader => {
		const viewModel = this.viewModel;
		const modifiedBaseRange = this.modifiedBaseRange;

		const state = viewModel.model.getState(modifiedBaseRange).read(reader);
		const model = viewModel.model;

		const result: IContentWidgetAction[] = [];

		if (state.kind === ModifiedBaseRangeStateKind.unrecognized) {
			result.push({
				text: this.t('manualResolution'),
				tooltip: this.t('manualResolutionTooltip'),
			});
		} else if (state.kind === ModifiedBaseRangeStateKind.base) {
			result.push({
				text: this.t('noChangesAccepted'),
				tooltip: this.t('noChangesAcceptedTooltip'),
			});

		} else {
			const labels = [];
			if (state.includesInput1) {
				labels.push(model.input1.title);
			}
			if (state.includesInput2) {
				labels.push(model.input2.title);
			}
			if (state.kind === ModifiedBaseRangeStateKind.both && state.firstInput === 2) {
				labels.reverse();
			}
			result.push({
				text: `${labels.join(' + ')}`
			});
		}

		const stateToggles: IContentWidgetAction[] = [];
		if (state.includesInput1) {
			stateToggles.push(
				command(
					this.t('remove', model.input1.title),
					async () => {
						transaction((tx) => {
							model.setState(
								modifiedBaseRange,
								state.withInputValue(1, false),
								true,
								tx
							);
						});
					},
					this.t('removeTooltip', model.input1.title)
				)
			);
		}
		if (state.includesInput2) {
			stateToggles.push(
				command(
					this.t('remove', model.input2.title),
					async () => {
						transaction((tx) => {
							model.setState(
								modifiedBaseRange,
								state.withInputValue(2, false),
								true,
								tx
							);
						});
					},
					this.t('removeTooltip', model.input2.title)
				)
			);
		}
		if (
			state.kind === ModifiedBaseRangeStateKind.both &&
			state.firstInput === 2
		) {
			stateToggles.reverse();
		}
		result.push(...stateToggles);

		if (state.kind === ModifiedBaseRangeStateKind.unrecognized) {
			result.push(
				command(
					this.t('resetToBase'),
					async () => {
						transaction((tx) => {
							model.setState(
								modifiedBaseRange,
								ModifiedBaseRangeState.base,
								true,
								tx
							);
						});
					},
					this.t('resetToBaseTooltip')
				)
			);
		}

		return result;
	});

	public readonly isEmpty = derived(this, reader => {
		return this.itemsInput1.read(reader).length + this.itemsInput2.read(reader).length + this.resultItems.read(reader).length === 0;
	});

	public readonly inputIsEmpty = derived(this, reader => {
		return this.itemsInput1.read(reader).length + this.itemsInput2.read(reader).length === 0;
	});
}

function command(title: string, action: () => Promise<void>, tooltip?: string): IContentWidgetAction {
	return {
		text: title,
		action,
		tooltip,
	};
}

export interface IContentWidgetAction {
	text: string;
	tooltip?: string;
	action?: () => Promise<void>;
}

class ActionsContentWidget extends FixedZoneWidget {
	private readonly _domNode = Object.assign(document.createElement('div'), { className: 'merge-editor-conflict-actions' });

	constructor(
		editor: ICodeEditor,
		viewZoneAccessor: IViewZoneChangeAccessor,
		afterLineNumber: number,
		height: number,

		className: string,
		items: IObservable<IContentWidgetAction[]>,
		viewZoneIdsToCleanUp: string[],
	) {
		super(editor, viewZoneAccessor, afterLineNumber, height, viewZoneIdsToCleanUp);

		this.widgetDomNode.appendChild(this._domNode);

		this._domNode.classList.add(className);

		this._register(autorun(reader => {
			/** @description update commands */
			const i = items.read(reader);
			this.setState(i);
		}));
	}

	private setState(items: IContentWidgetAction[]) {
		const children: HTMLElement[] = [];
		let isFirst = true;
		for (const item of items) {
			if (isFirst) {
				isFirst = false;
			} else {
				children.push($('span', undefined, '\u00a0|\u00a0'));
			}
			const title = [item.text];

			if (item.action) {
				children.push($('a', { title: item.tooltip, role: 'button', onclick: () => item.action!() }, ...title));
			} else {
				children.push($('span', { title: item.tooltip }, ...title));
			}
		}

		this._domNode.replaceChildren(...children);
	}
}
