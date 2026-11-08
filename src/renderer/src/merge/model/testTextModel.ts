// 单测用（#70）：在 node 里直接构造 Monaco 内部的 TextModel，对应上游 src/vs/editor/test/common/testTextModel.ts 的 createTextModel。
// 只给 TextModel 构造时真正用到的服务，别的都是空壳
// @ts-expect-error Monaco 内部模块，没有类型声明
import { TextModel } from 'monaco-editor/editor/common/model/textModel.js'
// @ts-expect-error 同上
import { UndoRedoService } from 'monaco-editor/platform/undoRedo/common/undoRedoService.js'
// @ts-expect-error 同上
import { LanguageService } from 'monaco-editor/editor/common/services/languageService.js'
// @ts-expect-error 同上
import { LanguageConfigurationService } from 'monaco-editor/editor/common/languages/languageConfigurationRegistry.js'
import type { editor } from 'monaco-editor'
import type { IUndoRedoService } from './mergeEditorModel'

export const undoRedoService: IUndoRedoService = new UndoRedoService({}, {})
const languageService = new LanguageService()
const configurationService = { onDidChangeConfiguration: () => ({ dispose() {} }), getValue: () => undefined }
const languageConfigurationService = new LanguageConfigurationService(configurationService, languageService)
// TextModel 用它构造分词部件：按构造函数的参数顺序补上服务（最后一个是 tree-sitter，不支持任何语言）
const instantiationService = {
  createInstance: (C: new (...a: unknown[]) => unknown, ...args: unknown[]) =>
    new C(...args, languageService, languageConfigurationService, instantiationService, { supportsLanguage: () => false }),
}

// 不给 uri 时 TextModel 自己分配 inmemory://model/<n>，各自一个撤销栈
export function createTextModel(text: string, languageId = 'plaintext'): editor.ITextModel {
  return new TextModel(text, languageId, TextModel.DEFAULT_CREATION_OPTIONS, null, undoRedoService, languageService, languageConfigurationService, instantiationService)
}
