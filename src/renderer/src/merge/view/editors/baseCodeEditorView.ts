/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 照 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/editors/baseCodeEditorView.ts
// 改写（MIT，见 merge/LICENSE.txt）：decorations 照搬；不搬勾选框 gutter 和标题栏工具条

import * as monaco from 'monaco-editor/editor/editor.api.js';
import { autorun, derived, type IObservable } from '../../observable';
import { applyObservableDecorations } from '../../utils';
import { handledConflictMinimapOverViewRulerColor, unhandledConflictMinimapOverViewRulerColor } from '../colors';
import type { MergeEditorViewModel } from '../viewModel';
import { CodeEditorView, createSelectionsAutorun } from './codeEditorView';

type IModelDeltaDecoration = monaco.editor.IModelDeltaDecoration;
const { OverviewRulerLane } = monaco.editor;

export class BaseCodeEditorView extends CodeEditorView {
	constructor(
		viewModel: IObservable<MergeEditorViewModel | undefined>,
		options: monaco.editor.IStandaloneEditorConstructionOptions,
		labels: { title: string; compareWith: (title: string) => string; compareWithTooltip: string },
	) {
		super(viewModel, options);

		this.htmlElements.root.classList.add(`base`);

		this._register(
			createSelectionsAutorun(this, (baseRange, viewModel) => baseRange)
		);

		this._register(
			autorun(reader => {
				/** @description update labels & text model */
				const vm = this.viewModel.read(reader);
				if (!vm) {
					return;
				}
				this.editor.setModel(vm.model.base);
				this.htmlElements.title.textContent = labels.title;

				const baseShowDiffAgainst = vm.baseShowDiffAgainst.read(reader);

				const description = this.htmlElements.description;
				description.textContent = baseShowDiffAgainst ? labels.compareWith((baseShowDiffAgainst === 1 ? vm.model.input1.title : vm.model.input2.title) ?? '') : '';
				description.title = baseShowDiffAgainst ? labels.compareWithTooltip : '';
			})
		);

		this._register(applyObservableDecorations(this.editor, this.decorations));
	}

	private readonly decorations = derived(this, reader => {
		const viewModel = this.viewModel.read(reader);
		if (!viewModel) {
			return [];
		}
		const model = viewModel.model;
		const textModel = model.base;

		const activeModifiedBaseRange = viewModel.activeModifiedBaseRange.read(reader);
		const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader);
		const showDeletionMarkers = this.showDeletionMarkers.read(reader);

		const result: IModelDeltaDecoration[] = [];
		for (const modifiedBaseRange of model.modifiedBaseRanges.read(reader)) {

			const range = modifiedBaseRange.baseRange;
			if (!range) {
				continue;
			}

			const isHandled = model.isHandled(modifiedBaseRange).read(reader);
			if (!modifiedBaseRange.isConflicting && isHandled && !showNonConflictingChanges) {
				continue;
			}

			const blockClassNames = ['merge-editor-block'];
			let blockPadding: [top: number, right: number, bottom: number, left: number] = [0, 0, 0, 0];
			if (isHandled) {
				blockClassNames.push('handled');
			}
			if (modifiedBaseRange === activeModifiedBaseRange) {
				blockClassNames.push('focused');
				blockPadding = [0, 2, 0, 2];
			}
			blockClassNames.push('base');

			const inputToDiffAgainst = viewModel.baseShowDiffAgainst.read(reader);

			if (inputToDiffAgainst) {
				for (const diff of modifiedBaseRange.getInputDiffs(inputToDiffAgainst)) {
					const range = diff.inputRange.toInclusiveRange();
					if (range) {
						result.push({
							range,
							options: {
								className: `merge-editor-diff base`,
								isWholeLine: true,
							}
						});
					}

					for (const diff2 of diff.rangeMappings) {
						if (showDeletionMarkers || !diff2.inputRange.isEmpty()) {
							result.push({
								range: diff2.inputRange,
								options: {
									className: diff2.inputRange.isEmpty() ? `merge-editor-diff-empty-word base` : `merge-editor-diff-word base`,
									showIfCollapsed: true,
								},
							});
						}
					}
				}
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
		}
		return result;
	});
}
