/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/editor/common/core/text/textLength.ts（MIT，见 merge/LICENSE.txt），
// 只取合并编辑器用到的部分：Monaco 包里的那份被 tree-shaking 删掉了 isZero、isGreaterThan、equals

/**
 * Represents a non-negative length of text in terms of line and column count.
*/
export class TextLength {
	public static zero = new TextLength(0, 0);

	constructor(
		public readonly lineCount: number,
		public readonly columnCount: number
	) { }

	public isZero() {
		return this.lineCount === 0 && this.columnCount === 0;
	}

	public isGreaterThan(other: TextLength): boolean {
		if (this.lineCount !== other.lineCount) {
			return this.lineCount > other.lineCount;
		}
		return this.columnCount > other.columnCount;
	}

	public equals(other: TextLength): boolean {
		return this.lineCount === other.lineCount && this.columnCount === other.columnCount;
	}

	public add(other: TextLength): TextLength {
		if (other.lineCount === 0) {
			return new TextLength(this.lineCount, this.columnCount + other.columnCount);
		} else {
			return new TextLength(this.lineCount + other.lineCount, other.columnCount);
		}
	}

	public toString() {
		return `${this.lineCount},${this.columnCount}`;
	}
}
