/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 合并编辑器（#70）用的 observable 门面，对应 VS Code 的 src/vs/base/common/observable.ts：实现取自 Monaco 内部模块，
// Monaco 包里被 tree-shaking 删掉的几个（keepObserved、derivedObservableWithWritableCache）按上游实现补上
import type { IDisposable } from 'monaco-editor/base/common/lifecycle.js'
import { toDisposable } from 'monaco-editor/base/common/lifecycle.js'
import type { IObservable, IReader, ITransaction } from 'monaco-editor/base/common/observableInternal/base.js'
import { derived } from 'monaco-editor/base/common/observableInternal/observables/derived.js'
import { observableSignal } from 'monaco-editor/base/common/observableInternal/observables/observableSignal.js'
import { KeepAliveObserver } from 'monaco-editor/base/common/observableInternal/utils/utils.js'

export type { IChangeContext, IObservable, IObservableSignal, IObservableWithChange, IReader, ISettableObservable, ITransaction } from 'monaco-editor/base/common/observableInternal/base.js'
export { derived, derivedOpts } from 'monaco-editor/base/common/observableInternal/observables/derived.js'
export { observableValue } from 'monaco-editor/base/common/observableInternal/observables/observableValue.js'
export { observableSignal } from 'monaco-editor/base/common/observableInternal/observables/observableSignal.js'
export { observableFromEvent } from 'monaco-editor/base/common/observableInternal/observables/observableFromEvent.js'
export { observableSignalFromEvent } from 'monaco-editor/base/common/observableInternal/observables/observableSignalFromEvent.js'
export { autorun, autorunHandleChanges, autorunOpts, autorunWithStore } from 'monaco-editor/base/common/observableInternal/reactions/autorun.js'
export { transaction } from 'monaco-editor/base/common/observableInternal/transaction.js'
export { waitForState } from 'monaco-editor/base/common/observableInternal/utils/utilsCancellation.js'

// 以下两个移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/base/common/observableInternal/utils/utils.ts（MIT，见 merge/LICENSE.txt）

// 没有观察者时 derived 不缓存；保持观察，模型里的映射只在依赖变化时重算
export function keepObserved<T>(observable: IObservable<T>): IDisposable {
  const o = new KeepAliveObserver(false, undefined)
  observable.addObserver(o)
  return toDisposable(() => observable.removeObserver(o))
}

export function derivedObservableWithWritableCache<T>(
  owner: object,
  computeFn: (reader: IReader, lastValue: T | undefined) => T,
): IObservable<T> & { clearCache(tx: ITransaction): void; setCache(newValue: T | undefined, tx: ITransaction | undefined): void } {
  let lastValue: T | undefined = undefined
  const onChange = observableSignal('derivedObservableWithWritableCache')
  const observable = derived(owner, (reader) => {
    onChange.read(reader)
    lastValue = computeFn(reader, lastValue)
    return lastValue
  })
  return Object.assign(observable, {
    clearCache: (tx: ITransaction) => {
      lastValue = undefined
      onChange.trigger(tx)
    },
    setCache: (newValue: T | undefined, tx: ITransaction | undefined) => {
      lastValue = newValue
      onChange.trigger(tx)
    },
  })
}
