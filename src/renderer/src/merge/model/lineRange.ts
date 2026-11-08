/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4（MIT，见 merge/LICENSE.txt）：
// src/vs/workbench/contrib/mergeEditor/browser/model/lineRange.ts；
// 基类 LineRange 取自 src/vs/editor/common/core/ranges/lineRange.ts 中合并编辑器用到的部分（Monaco 包里的那份被 tree-shaking 删掉了 compareByStart、containsRange）

import { compareBy, numberComparator } from 'monaco-editor/base/common/arrays.js';
import { BugIndicatingError } from 'monaco-editor/base/common/errors.js';
import { Range } from 'monaco-editor/editor/common/core/range.js';
import type { editor } from 'monaco-editor';

type ITextModel = editor.ITextModel;

// Constants.MAX_SAFE_SMALL_INTEGER（src/vs/base/common/uint.ts）
const MAX_SAFE_SMALL_INTEGER = 1 << 30;

export class LineRange {
	public static readonly compareByStart = compareBy<LineRange, number>(l => l.startLineNumber, numberComparator);

	public readonly startLineNumber: number;
	public readonly endLineNumberExclusive: number;

	constructor(
		startLineNumber: number,
		endLineNumberExclusive: number,
	) {
		if (startLineNumber > endLineNumberExclusive) {
			throw new BugIndicatingError(`startLineNumber ${startLineNumber} cannot be after endLineNumberExclusive ${endLineNumberExclusive}`);
		}
		this.startLineNumber = startLineNumber;
		this.endLineNumberExclusive = endLineNumberExclusive;
	}

	public contains(lineNumber: number): boolean {
		return this.startLineNumber <= lineNumber && lineNumber < this.endLineNumberExclusive;
	}

	public containsRange(range: LineRange): boolean {
		return this.startLineNumber <= range.startLineNumber && range.endLineNumberExclusive <= this.endLineNumberExclusive;
	}

	get isEmpty(): boolean {
		return this.startLineNumber === this.endLineNumberExclusive;
	}

	public get length(): number {
		return this.endLineNumberExclusive - this.startLineNumber;
	}

	public toString(): string {
		return `[${this.startLineNumber},${this.endLineNumberExclusive})`;
	}

	public intersectsOrTouches(other: LineRange): boolean {
		return this.startLineNumber <= other.endLineNumberExclusive && other.startLineNumber <= this.endLineNumberExclusive;
	}

	public equals(b: LineRange): boolean {
		return this.startLineNumber === b.startLineNumber && this.endLineNumberExclusive === b.endLineNumberExclusive;
	}

	public toInclusiveRange(): Range | null {
		if (this.isEmpty) {
			return null;
		}
		return new Range(this.startLineNumber, 1, this.endLineNumberExclusive - 1, Number.MAX_SAFE_INTEGER);
	}

	public toExclusiveRange(): Range {
		return new Range(this.startLineNumber, 1, this.endLineNumberExclusive, 1);
	}
}

/**
 * TODO: Deprecate in favor of LineRange!
 */
export class MergeEditorLineRange extends LineRange {
	static fromLineNumbers(startLineNumber: number, endExclusiveLineNumber: number): MergeEditorLineRange {
		return MergeEditorLineRange.fromLength(startLineNumber, endExclusiveLineNumber - startLineNumber);
	}

	static fromLength(startLineNumber: number, length: number): MergeEditorLineRange {
		return new MergeEditorLineRange(startLineNumber, startLineNumber + length);
	}

	public join(other: MergeEditorLineRange): MergeEditorLineRange {
		return MergeEditorLineRange.fromLineNumbers(Math.min(this.startLineNumber, other.startLineNumber), Math.max(this.endLineNumberExclusive, other.endLineNumberExclusive));
	}

	public isAfter(range: MergeEditorLineRange): boolean {
		return this.startLineNumber >= range.endLineNumberExclusive;
	}

	public isBefore(range: MergeEditorLineRange): boolean {
		return range.startLineNumber >= this.endLineNumberExclusive;
	}

	public delta(lineDelta: number): MergeEditorLineRange {
		return MergeEditorLineRange.fromLength(this.startLineNumber + lineDelta, this.length);
	}

	public deltaEnd(delta: number): MergeEditorLineRange {
		return MergeEditorLineRange.fromLength(this.startLineNumber, this.length + delta);
	}

	public deltaStart(lineDelta: number): MergeEditorLineRange {
		return MergeEditorLineRange.fromLength(this.startLineNumber + lineDelta, this.length - lineDelta);
	}

	public getLines(model: ITextModel): string[] {
		const result = new Array(this.length);
		for (let i = 0; i < this.length; i++) {
			result[i] = model.getLineContent(this.startLineNumber + i);
		}
		return result;
	}

	public toInclusiveRangeOrEmpty(): Range {
		if (this.isEmpty) {
			return new Range(this.startLineNumber, 1, this.startLineNumber, 1);
		}
		return new Range(this.startLineNumber, 1, this.endLineNumberExclusive - 1, MAX_SAFE_SMALL_INTEGER);
	}
}
