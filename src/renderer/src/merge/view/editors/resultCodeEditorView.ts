/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 照 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/editors/resultCodeEditorView.ts
// 改写（MIT，见 merge/LICENSE.txt）：decorations 照搬；剩余冲突数从 ActionBar 换成标题栏里的按钮（点了跳到下一个未处理的冲突）；
// 不搬 context key、勾选框 gutter 和标题栏工具条

import * as monaco from 'monaco-editor/editor/editor.api.js';
import { CompareResult } from 'monaco-editor/base/common/arrays.js';
import { autorun, derived, type IObservable } from '../../observable';
import { MergeEditorLineRange } from '../../model/lineRange';
import { applyObservableDecorations, join } from '../../utils';
import { handledConflictMinimapOverViewRulerColor, unhandledConflictMinimapOverViewRulerColor } from '../colors';
import type { MergeEditorViewModel } from '../viewModel';
import { CodeEditorView, createSelectionsAutorun, el } from './codeEditorView';

type IModelDeltaDecoration = monaco.editor.IModelDeltaDecoration;
const { OverviewRulerLane } = monaco.editor;

export class ResultCodeEditorView extends CodeEditorView {
	constructor(
		viewModel: IObservable<MergeEditorViewModel | undefined>,
		options: monaco.editor.IStandaloneEditorConstructionOptions,
		labels: { title: string; remaining: (count: number) => string; next: string; allHandled: string },
	) {
		super(viewModel, options);

		this.htmlElements.root.classList.add(`result`);

		this._register(autorun(reader => {
			/** @description update labels & text model */
			const vm = this.viewModel.read(reader);
			if (!vm) {
				return;
			}
			this.editor.setModel(vm.model.resultTextModel);
			this.htmlElements.title.textContent = labels.title;
		}));

		const remainingConflicts = el('button', 'remaining');
		this.htmlElements.detail.append(remainingConflicts);

		this._register(autorun(reader => {
			/** @description update remainingConflicts label */
			const vm = this.viewModel.read(reader);
			if (!vm) {
				return;
			}

			const model = vm.model;
			if (!model) {
				return;
			}
			const count = model.unhandledConflictsCount.read(reader);

			remainingConflicts.textContent = labels.remaining(count);
			remainingConflicts.disabled = count === 0;
			remainingConflicts.title = count > 0 ? labels.next : labels.allHandled;
			remainingConflicts.onclick = () => vm.goToNextModifiedBaseRange(m => !model.isHandled(m).read(undefined));
		}));


		this._register(applyObservableDecorations(this.editor, this.decorations));

		this._register(
			createSelectionsAutorun(this, (baseRange, viewModel) =>
				viewModel.model.translateBaseRangeToResult(baseRange)
			)
		);
	}

	private readonly decorations = derived(this, reader => {
		const viewModel = this.viewModel.read(reader);
		if (!viewModel) {
			return [];
		}
		const model = viewModel.model;
		const textModel = model.resultTextModel;
		const result = new Array<IModelDeltaDecoration>();

		const baseRangeWithStoreAndTouchingDiffs = join(
			model.modifiedBaseRanges.read(reader),
			model.baseResultDiffs.read(reader),
			(baseRange, diff) => baseRange.baseRange.intersectsOrTouches(diff.inputRange)
				? CompareResult.neitherLessOrGreaterThan
				: MergeEditorLineRange.compareByStart(
					baseRange.baseRange,
					diff.inputRange
				)
		);

		const activeModifiedBaseRange = viewModel.activeModifiedBaseRange.read(reader);

		const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader);

		for (const m of baseRangeWithStoreAndTouchingDiffs) {
			const modifiedBaseRange = m.left;

			if (modifiedBaseRange) {
				const blockClassNames = ['merge-editor-block'];
				let blockPadding: [top: number, right: number, bottom: number, left: number] = [0, 0, 0, 0];
				const isHandled = model.isHandled(modifiedBaseRange).read(reader);
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
				blockClassNames.push('result');

				if (!modifiedBaseRange.isConflicting && !showNonConflictingChanges && isHandled) {
					continue;
				}

				const range = model.getLineRangeInResult(modifiedBaseRange.baseRange, reader);
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

			if (!modifiedBaseRange || modifiedBaseRange.isConflicting) {
				for (const diff of m.rights) {
					const range = diff.outputRange.toInclusiveRange();
					if (range) {
						result.push({
							range,
							options: {
								className: `merge-editor-diff result`,
								isWholeLine: true,
							}
						});
					}

					if (diff.rangeMappings) {
						for (const d of diff.rangeMappings) {
							result.push({
								range: d.outputRange,
								options: {
									className: `merge-editor-diff-word result`,
									
								}
							});
						}
					}
				}
			}
		}
		return result;
	});
}
