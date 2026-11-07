/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/model/editing.ts（MIT，见 merge/LICENSE.txt）

import { equals } from 'monaco-editor/base/common/arrays.js';
import { Range } from 'monaco-editor/editor/common/core/range.js';
import type { editor } from 'monaco-editor';
import { MergeEditorLineRange } from './lineRange';

type IIdentifiedSingleEditOperation = editor.IIdentifiedSingleEditOperation;

/**
 * Represents an edit, expressed in whole lines:
 * At (before) {@link MergeEditorLineRange.startLineNumber}, delete {@link MergeEditorLineRange.length} many lines and insert {@link newLines}.
*/
export class LineRangeEdit {
	constructor(
		public readonly range: MergeEditorLineRange,
		public readonly newLines: string[]
	) { }

	public equals(other: LineRangeEdit): boolean {
		return this.range.equals(other.range) && equals(this.newLines, other.newLines);
	}

	public toEdits(modelLineCount: number): IIdentifiedSingleEditOperation[] {
		return new LineEdits([this]).toEdits(modelLineCount);
	}
}

export class RangeEdit {
	constructor(
		public readonly range: Range,
		public readonly newText: string
	) { }

	public equals(other: RangeEdit): boolean {
		return Range.equalsRange(this.range, other.range) && this.newText === other.newText;
	}
}

export class LineEdits {
	constructor(public readonly edits: readonly LineRangeEdit[]) { }

	public toEdits(modelLineCount: number): IIdentifiedSingleEditOperation[] {
		return this.edits.map((e) => {
			if (e.range.endLineNumberExclusive <= modelLineCount) {
				return {
					range: new Range(e.range.startLineNumber, 1, e.range.endLineNumberExclusive, 1),
					text: e.newLines.map(s => s + '\n').join(''),
				};
			}

			if (e.range.startLineNumber === 1) {
				return {
					range: new Range(1, 1, modelLineCount, Number.MAX_SAFE_INTEGER),
					text: e.newLines.join('\n'),
				};
			}

			return {
				range: new Range(e.range.startLineNumber - 1, Number.MAX_SAFE_INTEGER, modelLineCount, Number.MAX_SAFE_INTEGER),
				text: e.newLines.map(s => '\n' + s).join(''),
			};
		});
	}
}
