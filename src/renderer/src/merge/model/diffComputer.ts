/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/model/diffComputer.ts（MIT，见 merge/LICENSE.txt）

import { Range } from 'monaco-editor/editor/common/core/range.js';
import { assertFn, checkAdjacentItems } from 'monaco-editor/base/common/assert.js';
import type { IRange, Uri, editor } from 'monaco-editor';
import { MergeEditorLineRange } from './lineRange';
import { DetailedLineRangeMapping, RangeMapping } from './mapping';
import type { IReader } from '../observable';

type ITextModel = editor.ITextModel;
type LineRange = { startLineNumber: number; length: number };
type DiffRangeMapping = { originalRange: IRange; modifiedRange: IRange };
// IEditorWorkerService（src/vs/editor/common/services/editorWorker.ts）里合并编辑器用到的部分；standalone 里取 StandaloneServices 的实例
export interface IEditorWorkerService {
	computeDiff(original: Uri, modified: Uri, options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }, algorithm: 'legacy' | 'advanced'): Promise<{ changes: readonly { original: LineRange; modified: LineRange; innerChanges: readonly DiffRangeMapping[] | undefined }[] } | null>;
}

export interface IMergeDiffComputer {
	computeDiff(textModel1: ITextModel, textModel2: ITextModel, reader: IReader): Promise<IMergeDiffComputerResult>;
}

export interface IMergeDiffComputerResult {
	diffs: DetailedLineRangeMapping[] | null;
}

// 换掉 workbench 的依赖注入：worker 服务直接传入；不读 mergeEditor.diffAlgorithm 配置，固定用它的默认值 advanced
export class MergeDiffComputer implements IMergeDiffComputer {
	private readonly mergeAlgorithm = 'advanced' as const;

	constructor(
		private readonly editorWorkerService: IEditorWorkerService,
	) {
	}

	async computeDiff(textModel1: ITextModel, textModel2: ITextModel, reader: IReader): Promise<IMergeDiffComputerResult> {
		const diffAlgorithm = this.mergeAlgorithm;
		const inputVersion = textModel1.getVersionId();
		const outputVersion = textModel2.getVersionId();

		const result = await this.editorWorkerService.computeDiff(
			textModel1.uri,
			textModel2.uri,
			{
				ignoreTrimWhitespace: false,
				maxComputationTimeMs: 0,
				computeMoves: false,
			},
			diffAlgorithm,
		);

		if (!result) {
			throw new Error('Diff computation failed');
		}

		if (textModel1.isDisposed() || textModel2.isDisposed()) {
			return { diffs: null };
		}

		const changes = result.changes.map(c =>
			new DetailedLineRangeMapping(
				toLineRange(c.original),
				textModel1,
				toLineRange(c.modified),
				textModel2,
				c.innerChanges?.map(ic => toRangeMapping(ic))
			)
		);

		const newInputVersion = textModel1.getVersionId();
		const newOutputVersion = textModel2.getVersionId();

		if (inputVersion !== newInputVersion || outputVersion !== newOutputVersion) {
			return { diffs: null };
		}

		assertFn(() => {
			/*
			// This does not hold (see https://github.com/microsoft/vscode-copilot/issues/10610)
			// TODO@hediet the diff algorithm should just use compute a string edit that transforms the input to the output, nothing else

			for (const c of changes) {
				const inputRange = c.inputRange;
				const outputRange = c.outputRange;
				const inputTextModel = c.inputTextModel;
				const outputTextModel = c.outputTextModel;

				for (const map of c.rangeMappings) {
					let inputRangesValid = inputRange.startLineNumber - 1 <= map.inputRange.startLineNumber
						&& map.inputRange.endLineNumber <= inputRange.endLineNumberExclusive;
					if (inputRangesValid && map.inputRange.startLineNumber === inputRange.startLineNumber - 1) {
						inputRangesValid = map.inputRange.endColumn >= inputTextModel.getLineMaxColumn(map.inputRange.startLineNumber);
					}
					if (inputRangesValid && map.inputRange.endLineNumber === inputRange.endLineNumberExclusive) {
						inputRangesValid = map.inputRange.endColumn === 1;
					}

					let outputRangesValid = outputRange.startLineNumber - 1 <= map.outputRange.startLineNumber
						&& map.outputRange.endLineNumber <= outputRange.endLineNumberExclusive;
					if (outputRangesValid && map.outputRange.startLineNumber === outputRange.startLineNumber - 1) {
						outputRangesValid = map.outputRange.endColumn >= outputTextModel.getLineMaxColumn(map.outputRange.endLineNumber);
					}
					if (outputRangesValid && map.outputRange.endLineNumber === outputRange.endLineNumberExclusive) {
						outputRangesValid = map.outputRange.endColumn === 1;
					}

					if (!inputRangesValid || !outputRangesValid) {
						return false;
					}
				}
			}*/

			return changes.length === 0 || (changes[0].inputRange.startLineNumber === changes[0].outputRange.startLineNumber &&
				checkAdjacentItems(changes,
					(m1, m2) => m2.inputRange.startLineNumber - m1.inputRange.endLineNumberExclusive === m2.outputRange.startLineNumber - m1.outputRange.endLineNumberExclusive &&
						// There has to be an unchanged line in between (otherwise both diffs should have been joined)
						m1.inputRange.endLineNumberExclusive < m2.inputRange.startLineNumber &&
						m1.outputRange.endLineNumberExclusive < m2.outputRange.startLineNumber,
				));
		});

		return {
			diffs: changes
		};
	}
}

export function toLineRange(range: LineRange): MergeEditorLineRange {
	return MergeEditorLineRange.fromLength(range.startLineNumber, range.length);
}

export function toRangeMapping(mapping: DiffRangeMapping): RangeMapping {
	return new RangeMapping(Range.lift(mapping.originalRange), Range.lift(mapping.modifiedRange));
}
