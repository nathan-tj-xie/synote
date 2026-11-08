// 合并编辑器模型（#70）：上游单测没覆盖、而冲突视图依赖的几条行为——两侧都要按勾选顺序拼接、手改后算已手动处理、
// 重置回 base、剩余冲突数。模型照搬上游，这里锁住移植后的行为
import { describe, expect, test } from 'vitest'
import { LegacyLinesDiffComputer } from 'monaco-editor/editor/common/diff/legacyLinesDiffComputer.js'
import { Range } from 'monaco-editor/editor/common/core/range.js'
import type { editor } from 'monaco-editor'
import { transaction } from '../observable'
import { type IMergeDiffComputer, toLineRange, toRangeMapping } from './diffComputer'
import { DetailedLineRangeMapping } from './mapping'
import { MergeEditorModel } from './mergeEditorModel'
import { ModifiedBaseRangeState, ModifiedBaseRangeStateKind } from './modifiedBaseRange'
import { createTextModel, undoRedoService } from './testTextModel'

const diffComputer: IMergeDiffComputer = {
  async computeDiff(a: editor.ITextModel, b: editor.ITextModel) {
    const r = new LegacyLinesDiffComputer().computeDiff(a.getLinesContent(), b.getLinesContent(), { ignoreTrimWhitespace: false, maxComputationTimeMs: 10000, computeMoves: false })
    return { diffs: r.changes.map((c) => new DetailedLineRangeMapping(toLineRange(c.original), a, toLineRange(c.modified), b, c.innerChanges?.map(toRangeMapping))) }
  },
}

// 结果栏照 VS Code 打开带冲突标记的文件时那样初始化（resetResult）
async function open(base: string, ours: string, theirs: string) {
  const input = (text: string) => ({ textModel: createTextModel(text), title: undefined, description: undefined, detail: undefined })
  const result = createTextModel('<<<<<<< HEAD\n=======\n>>>>>>> x\n')
  const m = new MergeEditorModel(createTextModel(base), input(ours), input(theirs), result, diffComputer, { resetResult: true }, undoRedoService)
  await m.onInitialized
  const range = (i: number) => m.modifiedBaseRanges.get()[i]
  const set = (i: number, s: ModifiedBaseRangeState) => transaction((tx) => m.setState(range(i), s, true, tx))
  const kind = (i: number) => m.getState(range(i)).get().kind
  return { m, result, range, set, kind }
}

describe('merge editor model (synote)', () => {
  test('non-conflicting changes are merged, conflicts show base and stay unhandled', async () => {
    const { m, result, kind } = await open('a\nb\nc\n', 'A\nb\nc1\n', 'a\nb\nc2\n')
    expect(result.getValue()).toBe('A\nb\nc\n')
    expect(m.modifiedBaseRanges.get().map((r) => r.isConflicting)).toEqual([false, true])
    expect(kind(1)).toBe(ModifiedBaseRangeStateKind.base)
    expect(m.unhandledConflictsCount.get()).toBe(1)
  })

  test('accepting both sides concatenates in the order they were checked; unchecking removes one side', async () => {
    const { m, result, set, range } = await open('x\n', 'ours\n', 'theirs\n')
    const st = () => m.getState(range(0)).get()
    set(0, st().withInputValue(2, true))
    set(0, st().withInputValue(1, true))
    expect(result.getValue()).toBe('theirs\nours\n')
    expect(m.unhandledConflictsCount.get()).toBe(0)
    set(0, st().withInputValue(2, false))
    expect(result.getValue()).toBe('ours\n')
    set(0, st().withInputValue(1, false))
    expect(result.getValue()).toBe('x\n')
  })

  test('smart combination merges word-level changes of both sides', async () => {
    const { result, range, set } = await open('hello world\n', 'hallo world\n', 'hello welt\n')
    expect(range(0).canBeCombined).toBe(true)
    set(0, ModifiedBaseRangeState.base.withInputValue(1, true).withInputValue(2, true, true))
    expect(result.getValue()).toBe('hallo welt\n')
  })

  test('a manual edit in the result is recognised as manual resolution; reset to base restores base', async () => {
    const { m, result, kind, set } = await open('a\nb\nc\n', 'a\nB1\nc\n', 'a\nB2\nc\n')
    result.pushEditOperations(null, [{ range: new Range(2, 1, 2, 2), text: '手改' }], () => null)
    await new Promise((r) => setTimeout(r, 0))
    await m.onInitialized
    await expect.poll(() => kind(0)).toBe(ModifiedBaseRangeStateKind.unrecognized)
    set(0, ModifiedBaseRangeState.base)
    expect(result.getValue()).toBe('a\nb\nc\n')
    expect(kind(0)).toBe(ModifiedBaseRangeStateKind.base)
  })
})
