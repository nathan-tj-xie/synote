/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/test/browser/mapping.test.ts（MIT，见 merge/LICENSE.txt）。
// 用例原样搬来；mocha 里按 this.test.title 取位置的写法改成 vitest 的 test.each

import assert from 'node:assert';
import { describe, test } from 'vitest';
import { Position } from 'monaco-editor/editor/common/core/position.js';
import { Range } from 'monaco-editor/editor/common/core/range.js';
import { TextLength } from './textLength';
import { DocumentRangeMap, RangeMapping } from './mapping';

describe('merge editor mapping', () => {
	describe('DocumentRangeMap', () => {
		const documentMap = createDocumentRangeMap([
			'1:3',
			['0:2', '0:3'],
			'1:1',
			['1:2', '3:3'],
			'0:2',
			['0:2', '0:3'],
		]);

		test('map', () => assert.deepStrictEqual(documentMap.rangeMappings.map(m => m.toString()), [
			'[2:4, 2:6) -> [2:4, 2:7)',
			'[3:2, 4:3) -> [3:2, 6:4)',
			'[4:5, 4:7) -> [6:6, 6:9)'
		]));

		test.each([
			['1:1', '[1:1, 1:1) -> [1:1, 1:1)'],
			['2:3', '[2:3, 2:3) -> [2:3, 2:3)'],
			['2:4', '[2:4, 2:6) -> [2:4, 2:7)'],
			['2:5', '[2:4, 2:6) -> [2:4, 2:7)'],
			['2:6', '[2:6, 2:6) -> [2:7, 2:7)'],
			['2:7', '[2:7, 2:7) -> [2:8, 2:8)'],
			['3:1', '[3:1, 3:1) -> [3:1, 3:1)'],
			['3:2', '[3:2, 4:3) -> [3:2, 6:4)'],
			['4:2', '[3:2, 4:3) -> [3:2, 6:4)'],
			['4:3', '[4:3, 4:3) -> [6:4, 6:4)'],
			['4:4', '[4:4, 4:4) -> [6:5, 6:5)'],
			['4:5', '[4:5, 4:7) -> [6:6, 6:9)'],
		])('%s', (pos, expected) => assert.deepStrictEqual(documentMap.project(parsePos(pos)).toString(), expected));
	});
});

function parsePos(str: string): Position {
	const [lineCount, columnCount] = str.split(':');
	return new Position(parseInt(lineCount, 10), parseInt(columnCount, 10));
}

function parseLengthObj(str: string): TextLength {
	const [lineCount, columnCount] = str.split(':');
	return new TextLength(parseInt(lineCount, 10), parseInt(columnCount, 10));
}

function toPosition(length: TextLength): Position {
	return new Position(length.lineCount + 1, length.columnCount + 1);
}

function createDocumentRangeMap(items: ([string, string] | string)[]) {
	const mappings: RangeMapping[] = [];
	let lastLen1 = new TextLength(0, 0);
	let lastLen2 = new TextLength(0, 0);
	for (const item of items) {
		if (typeof item === 'string') {
			const len = parseLengthObj(item);
			lastLen1 = lastLen1.add(len);
			lastLen2 = lastLen2.add(len);
		} else {
			const len1 = parseLengthObj(item[0]);
			const len2 = parseLengthObj(item[1]);
			mappings.push(new RangeMapping(
				Range.fromPositions(toPosition(lastLen1), toPosition(lastLen1.add(len1))),
				Range.fromPositions(toPosition(lastLen2), toPosition(lastLen2.add(len2))),
			));
			lastLen1 = lastLen1.add(len1);
			lastLen2 = lastLen2.add(len2);
		}
	}

	return new DocumentRangeMap(mappings, lastLen1.lineCount);
}
