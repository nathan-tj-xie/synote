/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/base/common/controlFlow.ts（MIT，见 merge/LICENSE.txt）；
// Monaco 包里没有这个模块

import { BugIndicatingError } from 'monaco-editor/base/common/errors.js';

/**
 * A ReentrancyBarrier can be used to prevent reentrant calls to a function.
 */
export class ReentrancyBarrier {
	private _isOccupied = false;

	public makeExclusiveOrSkip<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void {
		return (...args: TArgs) => {
			if (this._isOccupied) {
				return;
			}
			this._isOccupied = true;
			try {
				return fn(...args);
			} finally {
				this._isOccupied = false;
			}
		};
	}

	public runExclusivelyOrSkip(fn: () => void): void {
		if (this._isOccupied) {
			return;
		}
		this._isOccupied = true;
		try {
			fn();
		} finally {
			this._isOccupied = false;
		}
	}

	public runExclusivelyOrThrow(fn: () => void): void {
		if (this._isOccupied) {
			throw new BugIndicatingError(`ReentrancyBarrier: reentrant call detected!`);
		}
		this._isOccupied = true;
		try {
			fn();
		} finally {
			this._isOccupied = false;
		}
	}

	public get isOccupied() {
		return this._isOccupied;
	}
}
