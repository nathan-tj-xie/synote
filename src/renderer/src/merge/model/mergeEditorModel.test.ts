/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/test/browser/model.test.ts（MIT，见 merge/LICENSE.txt）。
// 用例原样搬来；改动只在测试框架（mocha suite → vitest describe）和构造模型的方式（见 testTextModel.ts），
// 差异算法同上游测试一样用 legacy（应用里用 advanced）

import assert from 'node:assert';
import { describe, test } from 'vitest';
import { Disposable, DisposableStore } from 'monaco-editor/base/common/lifecycle.js';
import { LegacyLinesDiffComputer } from 'monaco-editor/editor/common/diff/legacyLinesDiffComputer.js';
import type { Range, editor } from 'monaco-editor';
import { type IReader, transaction } from '../observable';
import { type IMergeDiffComputer, type IMergeDiffComputerResult, toLineRange, toRangeMapping } from './diffComputer';
import { DetailedLineRangeMapping } from './mapping';
import { MergeEditorModel } from './mergeEditorModel';
import { createTextModel, undoRedoService } from './testTextModel';

type ITextModel = editor.ITextModel;
const isDefined = <T>(v: T | undefined | null): v is T => v !== undefined && v !== null;
// LF
const LF = 1;

describe('merge editor model', () => {
	// todo: renable when failing case is found https://github.com/microsoft/vscode/pull/190444#issuecomment-1678151428
	// ensureNoDisposablesAreLeakedInTestSuite();

	test('prepend line', async () => {
		await testMergeModel(
			{
				'languageId': 'plaintext',
				'base': 'line1\nline2',
				'input1': '0\nline1\nline2',
				'input2': '0\nline1\nline2',
				'result': ''
			},
			model => {
				assert.deepStrictEqual(model.getProjections(), {
					base: ['⟦⟧₀line1', 'line2'],
					input1: ['⟦0', '⟧₀line1', 'line2'],
					input2: ['⟦0', '⟧₀line1', 'line2'],
					result: ['⟦⟧{unrecognized}₀'],
				});

				model.toggleConflict(0, 1);
				assert.deepStrictEqual(
					{ result: model.getResult() },
					{ result: '0\nline1\nline2' }
				);

				model.toggleConflict(0, 2);
				assert.deepStrictEqual(
					{ result: model.getResult() },
					({ result: '0\n0\nline1\nline2' })
				);
			}
		);
	});

	test('empty base', async () => {
		await testMergeModel(
			{
				'languageId': 'plaintext',
				'base': '',
				'input1': 'input1',
				'input2': 'input2',
				'result': ''
			},
			model => {
				assert.deepStrictEqual(model.getProjections(), {
					base: ['⟦⟧₀'],
					input1: ['⟦input1⟧₀'],
					input2: ['⟦input2⟧₀'],
					result: ['⟦⟧{base}₀'],
				});

				model.toggleConflict(0, 1);
				assert.deepStrictEqual(
					{ result: model.getResult() },
					({ result: 'input1' })
				);

				model.toggleConflict(0, 2);
				assert.deepStrictEqual(
					{ result: model.getResult() },
					({ result: 'input2' })
				);
			}
		);
	});

	test('can merge word changes', async () => {
		await testMergeModel(
			{
				'languageId': 'plaintext',
				'base': 'hello',
				'input1': 'hallo',
				'input2': 'helloworld',
				'result': ''
			},
			model => {
				assert.deepStrictEqual(model.getProjections(), {
					base: ['⟦hello⟧₀'],
					input1: ['⟦hallo⟧₀'],
					input2: ['⟦helloworld⟧₀'],
					result: ['⟦⟧{unrecognized}₀'],
				});

				model.toggleConflict(0, 1);
				model.toggleConflict(0, 2);

				assert.deepStrictEqual(
					{ result: model.getResult() },
					{ result: 'halloworld' }
				);
			}
		);

	});

	test('can combine insertions at end of document', async () => {
		await testMergeModel(
			{
				'languageId': 'plaintext',
				'base': 'Zürich\nBern\nBasel\nChur\nGenf\nThun',
				'input1': 'Zürich\nBern\nChur\nDavos\nGenf\nThun\nfunction f(b:boolean) {}',
				'input2': 'Zürich\nBern\nBasel (FCB)\nChur\nGenf\nThun\nfunction f(a:number) {}',
				'result': 'Zürich\nBern\nBasel\nChur\nDavos\nGenf\nThun'
			},
			model => {
				assert.deepStrictEqual(model.getProjections(), {
					base: ['Zürich', 'Bern', '⟦Basel', '⟧₀Chur', '⟦⟧₁Genf', 'Thun⟦⟧₂'],
					input1: [
						'Zürich',
						'Bern',
						'⟦⟧₀Chur',
						'⟦Davos',
						'⟧₁Genf',
						'Thun',
						'⟦function f(b:boolean) {}⟧₂',
					],
					input2: [
						'Zürich',
						'Bern',
						'⟦Basel (FCB)',
						'⟧₀Chur',
						'⟦⟧₁Genf',
						'Thun',
						'⟦function f(a:number) {}⟧₂',
					],
					result: [
						'Zürich',
						'Bern',
						'⟦Basel',
						'⟧{base}₀Chur',
						'⟦Davos',
						'⟧{1✓}₁Genf',
						'Thun⟦⟧{base}₂',
					],
				});

				model.toggleConflict(2, 1);
				model.toggleConflict(2, 2);

				assert.deepStrictEqual(
					{ result: model.getResult() },
					{
						result:
							'Zürich\nBern\nBasel\nChur\nDavos\nGenf\nThun\nfunction f(b:boolean) {}\nfunction f(a:number) {}',
					}
				);
			}
		);
	});

	test('conflicts are reset', async () => {
		await testMergeModel(
			{
				'languageId': 'typescript',
				'base': `import { h } from 'vs/base/browser/dom';\nimport { Disposable, IDisposable } from 'vs/base/common/lifecycle';\nimport { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';\nimport { EditorOption } from 'vs/editor/common/config/editorOptions';\nimport { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';\nimport { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';\n`,
				'input1': `import { h } from 'vs/base/browser/dom';\nimport { Disposable, IDisposable } from 'vs/base/common/lifecycle';\nimport { observableSignalFromEvent } from 'vs/base/common/observable';\nimport { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';\nimport { autorun, IReader, observableFromEvent } from 'vs/workbench/contrib/audioCues/browser/observable';\nimport { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';\n`,
				'input2': `import { h } from 'vs/base/browser/dom';\nimport { Disposable, IDisposable } from 'vs/base/common/lifecycle';\nimport { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';\nimport { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';\nimport { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';\n`,
				'result': `import { h } from 'vs/base/browser/dom';\r\nimport { Disposable, IDisposable } from 'vs/base/common/lifecycle';\r\nimport { observableSignalFromEvent } from 'vs/base/common/observable';\r\nimport { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';\r\n<<<<<<< Updated upstream\r\nimport { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';\r\n=======\r\nimport { autorun, IReader, observableFromEvent } from 'vs/workbench/contrib/audioCues/browser/observable';\r\n>>>>>>> Stashed changes\r\nimport { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';\r\n`
			},
			model => {
				assert.deepStrictEqual(model.getProjections(), {
					base: [
						`import { h } from 'vs/base/browser/dom';`,
						`import { Disposable, IDisposable } from 'vs/base/common/lifecycle';`,
						`⟦⟧₀import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';`,
						`⟦import { EditorOption } from 'vs/editor/common/config/editorOptions';`,
						`import { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';`,
						`⟧₁import { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';`,
						'',
					],
					input1: [
						`import { h } from 'vs/base/browser/dom';`,
						`import { Disposable, IDisposable } from 'vs/base/common/lifecycle';`,
						`⟦import { observableSignalFromEvent } from 'vs/base/common/observable';`,
						`⟧₀import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';`,
						`⟦import { autorun, IReader, observableFromEvent } from 'vs/workbench/contrib/audioCues/browser/observable';`,
						`⟧₁import { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';`,
						'',
					],
					input2: [
						`import { h } from 'vs/base/browser/dom';`,
						`import { Disposable, IDisposable } from 'vs/base/common/lifecycle';`,
						`⟦⟧₀import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';`,
						`⟦import { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';`,
						`⟧₁import { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';`,
						'',
					],
					result: [
						`import { h } from 'vs/base/browser/dom';`,
						`import { Disposable, IDisposable } from 'vs/base/common/lifecycle';`,
						`⟦import { observableSignalFromEvent } from 'vs/base/common/observable';`,
						`⟧{1✓}₀import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';`,
						'⟦<<<<<<< Updated upstream',
						`import { autorun, IReader, observableFromEvent, ObservableValue } from 'vs/workbench/contrib/audioCues/browser/observable';`,
						'=======',
						`import { autorun, IReader, observableFromEvent } from 'vs/workbench/contrib/audioCues/browser/observable';`,
						'>>>>>>> Stashed changes',
						`⟧{unrecognized}₁import { LineRange } from 'vs/workbench/contrib/mergeEditor/browser/model/lineRange';`,
						'',
					],
				});
			}
		);
	});

	test('auto-solve equal edits', async () => {
		await testMergeModel(
			{
				'languageId': 'javascript',
				'base': `const { readFileSync } = require('fs');\n\nlet paths = process.argv.slice(2);\nmain(paths);\n\nfunction main(paths) {\n    // print the welcome message\n    printMessage();\n\n    let data = getLineCountInfo(paths);\n    console.log("Lines: " + data.totalLineCount);\n}\n\n/**\n * Prints the welcome message\n*/\nfunction printMessage() {\n    console.log("Welcome To Line Counter");\n}\n\n/**\n * @param {string[]} paths\n*/\nfunction getLineCountInfo(paths) {\n    let lineCounts = paths.map(path => ({ path, count: getLinesLength(readFileSync(path, 'utf8')) }));\n    return {\n        totalLineCount: lineCounts.reduce((acc, { count }) => acc + count, 0),\n        lineCounts,\n    };\n}\n\n/**\n * @param {string} str\n */\nfunction getLinesLength(str) {\n    return str.split('\\n').length;\n}\n`,
				'input1': `const { readFileSync } = require('fs');\n\nlet paths = process.argv.slice(2);\nmain(paths);\n\nfunction main(paths) {\n    // print the welcome message\n    printMessage();\n\n    const data = getLineCountInfo(paths);\n    console.log("Lines: " + data.totalLineCount);\n}\n\nfunction printMessage() {\n    console.log("Welcome To Line Counter");\n}\n\n/**\n * @param {string[]} paths\n*/\nfunction getLineCountInfo(paths) {\n    let lineCounts = paths.map(path => ({ path, count: getLinesLength(readFileSync(path, 'utf8')) }));\n    return {\n        totalLineCount: lineCounts.reduce((acc, { count }) => acc + count, 0),\n        lineCounts,\n    };\n}\n\n/**\n * @param {string} str\n */\nfunction getLinesLength(str) {\n    return str.split('\\n').length;\n}\n`,
				'input2': `const { readFileSync } = require('fs');\n\nlet paths = process.argv.slice(2);\nrun(paths);\n\nfunction run(paths) {\n    // print the welcome message\n    printMessage();\n\n    const data = getLineCountInfo(paths);\n    console.log("Lines: " + data.totalLineCount);\n}\n\nfunction printMessage() {\n    console.log("Welcome To Line Counter");\n}\n\n/**\n * @param {string[]} paths\n*/\nfunction getLineCountInfo(paths) {\n    let lineCounts = paths.map(path => ({ path, count: getLinesLength(readFileSync(path, 'utf8')) }));\n    return {\n        totalLineCount: lineCounts.reduce((acc, { count }) => acc + count, 0),\n        lineCounts,\n    };\n}\n\n/**\n * @param {string} str\n */\nfunction getLinesLength(str) {\n    return str.split('\\n').length;\n}\n`,
				'result': '<<<<<<< uiae\n>>>>>>> Stashed changes',
				resetResult: true,
			},
			async model => {
				await model.mergeModel.reset();

				assert.deepStrictEqual(model.getResult(), `const { readFileSync } = require('fs');\n\nlet paths = process.argv.slice(2);\nrun(paths);\n\nfunction run(paths) {\n    // print the welcome message\n    printMessage();\n\n    const data = getLineCountInfo(paths);\n    console.log("Lines: " + data.totalLineCount);\n}\n\nfunction printMessage() {\n    console.log("Welcome To Line Counter");\n}\n\n/**\n * @param {string[]} paths\n*/\nfunction getLineCountInfo(paths) {\n    let lineCounts = paths.map(path => ({ path, count: getLinesLength(readFileSync(path, 'utf8')) }));\n    return {\n        totalLineCount: lineCounts.reduce((acc, { count }) => acc + count, 0),\n        lineCounts,\n    };\n}\n\n/**\n * @param {string} str\n */\nfunction getLinesLength(str) {\n    return str.split('\\n').length;\n}\n`);
			}
		);
	});
});

async function testMergeModel(
	options: MergeModelOptions,
	fn: (model: MergeModelInterface) => void | Promise<void>
): Promise<void> {
	const disposables = new DisposableStore();
	const modelInterface = disposables.add(
		new MergeModelInterface(options)
	);
	await modelInterface.mergeModel.onInitialized;
	await fn(modelInterface);
	disposables.dispose();
}

interface MergeModelOptions {
	languageId: string;
	input1: string;
	input2: string;
	base: string;
	result: string;
	resetResult?: boolean;
}

function toSmallNumbersDec(value: number): string {
	const smallNumbers = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
	return value.toString().split('').map(c => smallNumbers[parseInt(c)]).join('');
}

class MergeModelInterface extends Disposable {
	public readonly mergeModel: MergeEditorModel;

	constructor(options: MergeModelOptions) {
		super();
		const input1TextModel = this._register(createTextModel(options.input1, options.languageId));
		const input2TextModel = this._register(createTextModel(options.input2, options.languageId));
		const baseTextModel = this._register(createTextModel(options.base, options.languageId));
		const resultTextModel = this._register(createTextModel(options.result, options.languageId));

		const diffComputer: IMergeDiffComputer = {
			async computeDiff(textModel1: ITextModel, textModel2: ITextModel, reader: IReader): Promise<IMergeDiffComputerResult> {
				const result = await new LegacyLinesDiffComputer().computeDiff(
					textModel1.getLinesContent(),
					textModel2.getLinesContent(),
					{ ignoreTrimWhitespace: false, maxComputationTimeMs: 10000, computeMoves: false }
				);
				const changes = result.changes.map(c =>
					new DetailedLineRangeMapping(
						toLineRange(c.original),
						textModel1,
						toLineRange(c.modified),
						textModel2,
						c.innerChanges?.map(ic => toRangeMapping(ic)).filter(isDefined)
					)
				);
				return {
					diffs: changes
				};
			}
		};

		this.mergeModel = this._register(new MergeEditorModel(
			baseTextModel,
			{
				textModel: input1TextModel,
				description: '',
				detail: '',
				title: '',
			},
			{
				textModel: input2TextModel,
				description: '',
				detail: '',
				title: '',
			},
			resultTextModel,
			diffComputer,
			{
				resetResult: options.resetResult || false
			},
			undoRedoService,
		));
	}

	getProjections(): unknown {
		interface LabeledRange {
			range: Range;
			label: string;
		}
		function applyRanges(textModel: ITextModel, ranges: LabeledRange[]): void {
			textModel.applyEdits(ranges.map(({ range, label }) => ({
				range: range,
				text: `⟦${textModel.getValueInRange(range)}⟧${label}`,
			})));
		}
		const baseRanges = this.mergeModel.modifiedBaseRanges.get();

		const baseTextModel = createTextModel(this.mergeModel.base.getValue());
		applyRanges(
			baseTextModel,
			baseRanges.map<LabeledRange>((r, idx) => ({
				range: r.baseRange.toExclusiveRange(),
				label: toSmallNumbersDec(idx),
			}))
		);

		const input1TextModel = createTextModel(this.mergeModel.input1.textModel.getValue());
		applyRanges(
			input1TextModel,
			baseRanges.map<LabeledRange>((r, idx) => ({
				range: r.input1Range.toExclusiveRange(),
				label: toSmallNumbersDec(idx),
			}))
		);

		const input2TextModel = createTextModel(this.mergeModel.input2.textModel.getValue());
		applyRanges(
			input2TextModel,
			baseRanges.map<LabeledRange>((r, idx) => ({
				range: r.input2Range.toExclusiveRange(),
				label: toSmallNumbersDec(idx),
			}))
		);

		const resultTextModel = createTextModel(this.mergeModel.resultTextModel.getValue());
		applyRanges(
			resultTextModel,
			baseRanges.map<LabeledRange>((r, idx) => ({
				range: this.mergeModel.getLineRangeInResult(r.baseRange).toExclusiveRange(),
				label: `{${this.mergeModel.getState(r).get()}}${toSmallNumbersDec(idx)}`,
			}))
		);

		const result = {
			base: baseTextModel.getValue(LF).split('\n'),
			input1: input1TextModel.getValue(LF).split('\n'),
			input2: input2TextModel.getValue(LF).split('\n'),
			result: resultTextModel.getValue(LF).split('\n'),
		};
		baseTextModel.dispose();
		input1TextModel.dispose();
		input2TextModel.dispose();
		resultTextModel.dispose();
		return result;
	}

	toggleConflict(conflictIdx: number, inputNumber: 1 | 2): void {
		const baseRange = this.mergeModel.modifiedBaseRanges.get()[conflictIdx];
		if (!baseRange) {
			throw new Error();
		}
		const state = this.mergeModel.getState(baseRange).get();
		transaction(tx => {
			this.mergeModel.setState(baseRange, state.toggle(inputNumber), true, tx);
		});
	}

	getResult(): string {
		return this.mergeModel.resultTextModel.getValue();
	}
}
