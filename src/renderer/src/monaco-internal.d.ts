// diff.ts 用到的 Monaco 内部模块（包里没有类型声明），只声明用到的部分
declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get<T>(id: unknown): T }
}
declare module 'monaco-editor/platform/keybinding/common/keybinding.js' {
  export const IKeybindingService: unknown
}
declare module 'monaco-editor/platform/commands/common/commands.js' {
  export const CommandsRegistry: { getCommand(id: string): unknown }
}

// 合并编辑器（#70，移植自 VS Code）用到的 Monaco 内部模块。这些不是公开 API：monaco-editor 锁定精确版本，升级时回归（ADR 0003）。
// ESM 包经过 tree-shaking，类上没被 Monaco 自己用到的方法会被删掉，所以只声明实测存在的导出
declare module 'monaco-editor/editor/common/core/range.js' {
  export { Range } from 'monaco-editor'
}
declare module 'monaco-editor/editor/common/core/position.js' {
  export { Position } from 'monaco-editor'
}
declare module 'monaco-editor/editor/common/core/selection.js' {
  export { Selection } from 'monaco-editor'
}
declare module 'monaco-editor/base/common/arrays.js' {
  export type Comparator<T> = (a: T, b: T) => CompareResult
  export type CompareResult = number
  export namespace CompareResult {
    function isLessThan(r: CompareResult): boolean
    function isGreaterThan(r: CompareResult): boolean
    function isNeitherLessOrGreaterThan(r: CompareResult): boolean
    const greaterThan: 1
    const lessThan: -1
    const neitherLessOrGreaterThan: 0
  }
  export function compareBy<TItem, TCompareBy>(selector: (item: TItem) => TCompareBy, comparator: Comparator<TCompareBy>): Comparator<TItem>
  export function tieBreakComparators<TItem>(...comparators: Comparator<TItem>[]): Comparator<TItem>
  export const numberComparator: Comparator<number>
  export function equals<T>(one: readonly T[] | undefined, other: readonly T[] | undefined, itemEquals?: (a: T, b: T) => boolean): boolean
  export class ArrayQueue<T> {
    constructor(items: readonly T[])
    takeWhile(predicate: (value: T) => boolean): T[] | null
  }
}
declare module 'monaco-editor/base/common/arraysFind.js' {
  export function findLast<T>(array: readonly T[], predicate: (item: T) => boolean): T | undefined
}
declare module 'monaco-editor/base/common/assert.js' {
  export function assertFn(condition: () => boolean): void
  export function checkAdjacentItems<T>(items: readonly T[], predicate: (item1: T, item2: T) => boolean): boolean
}
declare module 'monaco-editor/base/common/errors.js' {
  export class BugIndicatingError extends Error {
    constructor(message?: string)
  }
  export function onUnexpectedError(e: unknown): undefined
}
declare module 'monaco-editor/base/common/strings.js' {
  export function splitLines(str: string): string[]
}
declare module 'monaco-editor/base/common/lifecycle.js' {
  export interface IDisposable {
    dispose(): void
  }
  export function toDisposable(fn: () => void): IDisposable
  export class DisposableStore implements IDisposable {
    add<T extends IDisposable>(o: T): T
    delete<T extends IDisposable>(o: T): void
    clear(): void
    dispose(): void
  }
  export abstract class Disposable implements IDisposable {
    protected readonly _store: DisposableStore
    protected _register<T extends IDisposable>(o: T): T
    dispose(): void
  }
}
declare module 'monaco-editor/platform/undoRedo/common/undoRedo.js' {
  export class UndoRedoGroup {}
  export const IUndoRedoService: unknown
}
declare module 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js' {
  import type { Range } from 'monaco-editor'
  type LineRange = { startLineNumber: number; endLineNumberExclusive: number; length: number }
  export type LinesDiff = { changes: { original: LineRange; modified: LineRange; innerChanges: { originalRange: Range; modifiedRange: Range }[] | undefined }[]; hitTimeout: boolean }
  export class DefaultLinesDiffComputer {
    computeDiff(original: string[], modified: string[], options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }): LinesDiff
  }
}
// 可观察值（VS Code 的 observable 库）：base.js 运行时只有实现，这里借它的路径放接口类型；合并编辑器经 merge/observable.ts 门面引用
declare module 'monaco-editor/base/common/observableInternal/base.js' {
  import type { DisposableStore } from 'monaco-editor/base/common/lifecycle.js'
  export interface IReader {
    readObservable<T>(observable: IObservableWithChange<T, any>): T
    readonly store: DisposableStore
  }
  export interface ITransaction {
    updateObserver(observer: unknown, observable: IObservableWithChange<any, any>): void
  }
  export interface IObservableWithChange<T, TChange = unknown> {
    get(): T
    read(reader: IReader | undefined): T
    map<TNew>(fn: (value: T, reader: IReader) => TNew): IObservable<TNew>
    map<TNew>(owner: object, fn: (value: T, reader: IReader) => TNew): IObservable<TNew>
    recomputeInitiallyAndOnChange(store: DisposableStore, handleValue?: (value: T) => void): IObservable<T>
    addObserver(observer: unknown): void
    removeObserver(observer: unknown): void
    readonly debugName: string
    // 只用于携带 TChange 类型
    readonly TChange?: TChange
  }
  export type IObservable<T> = IObservableWithChange<T, unknown>
  export interface ISettableObservable<T, TChange = void> extends IObservableWithChange<T, TChange> {
    set(value: T, tx: ITransaction | undefined, change?: TChange): void
  }
  export interface IObservableSignal extends IObservableWithChange<void, void> {
    trigger(tx: ITransaction | undefined): void
  }
  export interface IChangeContext {
    readonly changedObservable: IObservableWithChange<any, any>
    readonly change: unknown
    didChange<T, TChange>(observable: IObservableWithChange<T, TChange>): boolean
  }
}
declare module 'monaco-editor/base/common/observableInternal/observables/observableValue.js' {
  import type { ISettableObservable } from 'monaco-editor/base/common/observableInternal/base.js'
  export function observableValue<T, TChange = void>(owner: object | string, initialValue: T): ISettableObservable<T, TChange>
}
declare module 'monaco-editor/base/common/observableInternal/observables/derived.js' {
  import type { IObservable, IReader } from 'monaco-editor/base/common/observableInternal/base.js'
  export function derived<T>(computeFn: (reader: IReader) => T): IObservable<T>
  export function derived<T>(owner: object, computeFn: (reader: IReader) => T): IObservable<T>
  export function derivedOpts<T>(options: { owner?: object; debugName?: string; equalsFn?: (a: T, b: T) => boolean }, computeFn: (reader: IReader) => T): IObservable<T>
}
declare module 'monaco-editor/base/common/observableInternal/reactions/autorun.js' {
  import type { IChangeContext, IReader } from 'monaco-editor/base/common/observableInternal/base.js'
  import type { DisposableStore, IDisposable } from 'monaco-editor/base/common/lifecycle.js'
  export function autorun(fn: (reader: IReader) => void): IDisposable
  export function autorunOpts(options: { owner?: object; debugName?: string }, fn: (reader: IReader) => void): IDisposable
  export function autorunWithStore(fn: (reader: IReader, store: DisposableStore) => void): IDisposable
  export function autorunHandleChanges<TSummary>(
    options: { owner?: object; debugName?: string; changeTracker: { createChangeSummary: () => TSummary; handleChange: (ctx: IChangeContext, summary: TSummary) => boolean } },
    fn: (reader: IReader, summary: TSummary) => void,
  ): IDisposable
}
declare module 'monaco-editor/base/common/observableInternal/transaction.js' {
  import type { ITransaction } from 'monaco-editor/base/common/observableInternal/base.js'
  export function transaction(fn: (tx: ITransaction) => void): void
}
declare module 'monaco-editor/base/common/observableInternal/utils/utilsCancellation.js' {
  import type { IObservable } from 'monaco-editor/base/common/observableInternal/base.js'
  export function waitForState<T>(observable: IObservable<T>, predicate: (state: T) => boolean): Promise<T>
}
declare module 'monaco-editor/base/common/observableInternal/observables/observableSignal.js' {
  import type { IObservableSignal } from 'monaco-editor/base/common/observableInternal/base.js'
  export function observableSignal(debugName: string | object): IObservableSignal
}
declare module 'monaco-editor/base/common/observableInternal/observables/observableFromEvent.js' {
  import type { IObservable } from 'monaco-editor/base/common/observableInternal/base.js'
  import type { IEvent } from 'monaco-editor'
  export function observableFromEvent<T, E = unknown>(owner: object, event: IEvent<E>, getValue: (e: E | undefined) => T): IObservable<T>
}
declare module 'monaco-editor/base/common/observableInternal/observables/observableSignalFromEvent.js' {
  import type { IObservable } from 'monaco-editor/base/common/observableInternal/base.js'
  import type { IEvent } from 'monaco-editor'
  export function observableSignalFromEvent(owner: object | string, event: IEvent<any>): IObservable<void>
}
declare module 'monaco-editor/base/common/observableInternal/utils/utils.js' {
  export class KeepAliveObserver {
    constructor(forceRecompute: boolean, handleValue: ((value: unknown) => void) | undefined)
  }
}
// 单测里用 legacy 差异算法（同上游的合并编辑器单测）
declare module 'monaco-editor/editor/common/diff/legacyLinesDiffComputer.js' {
  import type { DefaultLinesDiffComputer } from 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js'
  export class LegacyLinesDiffComputer extends DefaultLinesDiffComputer {}
}
declare module 'monaco-editor/editor/common/services/editorWorker.js' {
  export const IEditorWorkerService: unknown
}
