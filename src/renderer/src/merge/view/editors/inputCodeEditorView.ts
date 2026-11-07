/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 照 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/editors/inputCodeEditorView.ts
// 改写（MIT，见 merge/LICENSE.txt）：decorations 照搬；不搬勾选框 gutter（ModifiedBaseRangeGutterItemModel、
// MergeConflictGutterItemView，上游默认不显示）和标题栏工具条。小地图关着，概览尺的颜色直接用色值（standalone 没有主题色注册表）

import * as monaco from 'monaco-editor/editor/editor.api.js';
import { autorunOpts, derivedOpts, type IObservable } from '../../observable';
import { applyObservableDecorations } from '../../utils';
import { handledConflictMinimapOverViewRulerColor, unhandledConflictMinimapOverViewRulerColor } from '../colors';
import type { MergeEditorViewModel } from '../viewModel';
import { CodeEditorView, createSelectionsAutorun } from './codeEditorView';

type IModelDeltaDecoration = monaco.editor.IModelDeltaDecoration;
const { OverviewRulerLane } = monaco.editor;

export class InputCodeEditorView extends CodeEditorView {
	public readonly otherInputNumber;

	constructor(
		public readonly inputNumber: 1 | 2,
		viewModel: IObservable<MergeEditorViewModel | undefined>,
		options: monaco.editor.IStandaloneEditorConstructionOptions,
	) {
		super(viewModel, options);
		this.otherInputNumber = this.inputNumber === 1 ? 2 : 1;
		this.decorations = derivedOpts({ debugName: `input${this.inputNumber}.decorations` }, reader => {
			const viewModel = this.viewModel.read(reader);
			if (!viewModel) {
				return [];
			}
			const model = viewModel.model;
			const textModel = (this.inputNumber === 1 ? model.input1 : model.input2).textModel;

			const activeModifiedBaseRange = viewModel.activeModifiedBaseRange.read(reader);

			const result = new Array<IModelDeltaDecoration>();

			const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader);
			const showDeletionMarkers = this.showDeletionMarkers.read(reader);
			const diffWithThis = viewModel.baseCodeEditorView.read(reader) !== undefined && viewModel.baseShowDiffAgainst.read(reader) === this.inputNumber;
			const useSimplifiedDecorations = !diffWithThis && this.useSimplifiedDecorations.read(reader);

			for (const modifiedBaseRange of model.modifiedBaseRanges.read(reader)) {
				const range = modifiedBaseRange.getInputRange(this.inputNumber);
				if (!range) {
					continue;
				}

				const blockClassNames = ['merge-editor-block'];
				let blockPadding: [top: number, right: number, bottom: number, left: number] = [0, 0, 0, 0];
				const isHandled = model.isInputHandled(modifiedBaseRange, this.inputNumber).read(reader);
				if (isHandled) {
					blockClassNames.push('handled');
				}
				if (modifiedBaseRange === activeModifiedBaseRange) {
					blockClassNames.push('focused');
					blockPadding = [0, 2, 0, 2];
				}
				if (modifiedBaseRange.isConflicting) {
					blockClassNames.push('conflicting');
				}
				const inputClassName = this.inputNumber === 1 ? 'input i1' : 'input i2';
				blockClassNames.push(inputClassName);

				if (!modifiedBaseRange.isConflicting && !showNonConflictingChanges && isHandled) {
					continue;
				}

				if (useSimplifiedDecorations && !isHandled) {
					blockClassNames.push('use-simplified-decorations');
				}

				result.push({
					range: range.toInclusiveRangeOrEmpty(),
					options: {
						showIfCollapsed: true,
						blockClassName: blockClassNames.join(' '),
						blockPadding,
						blockIsAfterEnd: range.startLineNumber > textModel.getLineCount(),
						overviewRuler: modifiedBaseRange.isConflicting ? {
							position: OverviewRulerLane.Center,
							color: isHandled ? handledConflictMinimapOverViewRulerColor : unhandledConflictMinimapOverViewRulerColor,
						} : undefined
					} as monaco.editor.IModelDecorationOptions
				});

				if (!useSimplifiedDecorations && (modifiedBaseRange.isConflicting || !model.isHandled(modifiedBaseRange).read(reader))) {
					const inputDiffs = modifiedBaseRange.getInputDiffs(this.inputNumber);
					for (const diff of inputDiffs) {
						const range = diff.outputRange.toInclusiveRange();
						if (range) {
							result.push({
								range,
								options: {
									className: `merge-editor-diff ${inputClassName}`,
									isWholeLine: true,
								}
							});
						}

						if (diff.rangeMappings) {
							for (const d of diff.rangeMappings) {
								if (showDeletionMarkers || !d.outputRange.isEmpty()) {
									result.push({
										range: d.outputRange,
										options: {
											className: d.outputRange.isEmpty() ? `merge-editor-diff-empty-word ${inputClassName}` : `merge-editor-diff-word ${inputClassName}`,
											showIfCollapsed: true,
										}
									});
								}
							}
						}
					}
				}
			}
			return result;
		});

		this.htmlElements.root.classList.add('input', this.inputNumber === 1 ? 'i1' : 'i2');

		this._register(
			createSelectionsAutorun(this, (baseRange, viewModel) =>
				viewModel.model.translateBaseRangeToInput(this.inputNumber, baseRange)
			)
		);

		this._register(autorunOpts({ debugName: `input${this.inputNumber}: update labels & text model` }, reader => {
			const vm = this.viewModel.read(reader);
			if (!vm) {
				return;
			}

			this.editor.setModel(this.inputNumber === 1 ? vm.model.input1.textModel : vm.model.input2.textModel);

			const title = this.inputNumber === 1
				? vm.model.input1.title || 'Input 1'
				: vm.model.input2.title || 'Input 2';

			const description = this.inputNumber === 1
				? vm.model.input1.description
				: vm.model.input2.description;

			const detail = this.inputNumber === 1
				? vm.model.input1.detail
				: vm.model.input2.detail;

			this.htmlElements.title.textContent = title;
			this.htmlElements.description.textContent = description ?? '';
			this.htmlElements.detail.textContent = detail ?? '';
		}));


		this._register(applyObservableDecorations(this.editor, this.decorations));
	}

	private readonly decorations;
}
