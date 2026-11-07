/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/utils.ts（MIT，见 merge/LICENSE.txt），
// 只取用到的函数（PersistentStore 等依赖 workbench 存储服务的不搬）

import { ArrayQueue, CompareResult } from 'monaco-editor/base/common/arrays.js';
import { DisposableStore, type IDisposable } from 'monaco-editor/base/common/lifecycle.js';
import type { editor } from 'monaco-editor';
import { autorunOpts, type IObservable } from './observable';

export function applyObservableDecorations(editor: editor.ICodeEditor, decorations: IObservable<editor.IModelDeltaDecoration[]>): IDisposable {
	const d = new DisposableStore();
	let decorationIds: string[] = [];
	d.add(autorunOpts({ debugName: `Apply decorations from ${decorations.debugName}` }, reader => {
		const d = decorations.read(reader);
		// 公开 API 的 ICodeEditor 没有 changeDecorations，deltaDecorations 等价
		decorationIds = editor.deltaDecorations(decorationIds, d);
	}));
	d.add({
		dispose: () => {
			decorationIds = editor.deltaDecorations(decorationIds, []);
		}
	});
	return d;
}

export function* leftJoin<TLeft, TRight>(
	left: Iterable<TLeft>,
	right: readonly TRight[],
	compare: (left: TLeft, right: TRight) => CompareResult,
): IterableIterator<{ left: TLeft; rights: TRight[] }> {
	const rightQueue = new ArrayQueue(right);
	for (const leftElement of left) {
		rightQueue.takeWhile(rightElement => CompareResult.isGreaterThan(compare(leftElement, rightElement)));
		const equals = rightQueue.takeWhile(rightElement => CompareResult.isNeitherLessOrGreaterThan(compare(leftElement, rightElement)));
		yield { left: leftElement, rights: equals || [] };
	}
}

export function* join<TLeft, TRight>(
	left: Iterable<TLeft>,
	right: readonly TRight[],
	compare: (left: TLeft, right: TRight) => CompareResult,
): IterableIterator<{ left?: TLeft; rights: TRight[] }> {
	const rightQueue = new ArrayQueue(right);
	for (const leftElement of left) {
		const skipped = rightQueue.takeWhile(rightElement => CompareResult.isGreaterThan(compare(leftElement, rightElement)));
		if (skipped) {
			yield { rights: skipped };
		}
		const equals = rightQueue.takeWhile(rightElement => CompareResult.isNeitherLessOrGreaterThan(compare(leftElement, rightElement)));
		yield { left: leftElement, rights: equals || [] };
	}
}
