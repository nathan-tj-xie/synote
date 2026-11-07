/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// 移植自 microsoft/vscode@31c3885f65f041e5a000cee1a15716b12b0797a4 src/vs/workbench/contrib/mergeEditor/browser/view/fixedZoneWidget.ts（MIT，见 merge/LICENSE.txt）；
// dom.ts 的 h() 和 Event.runAndSubscribe 换成直接写

import { Disposable } from 'monaco-editor/base/common/lifecycle.js';
import type { editor } from 'monaco-editor';

type ICodeEditor = editor.ICodeEditor;
type IOverlayWidget = editor.IOverlayWidget;
type IViewZoneChangeAccessor = editor.IViewZoneChangeAccessor;

export abstract class FixedZoneWidget extends Disposable {
	private static counter = 0;
	private readonly overlayWidgetId = `fixedZoneWidget-${FixedZoneWidget.counter++}`;
	private readonly viewZoneId: string;

	protected readonly widgetDomNode = Object.assign(document.createElement('div'), { className: 'fixed-zone-widget' });
	private readonly overlayWidget: IOverlayWidget = {
		getId: () => this.overlayWidgetId,
		getDomNode: () => this.widgetDomNode,
		getPosition: () => null
	};

	constructor(
		private readonly editor: ICodeEditor,
		viewZoneAccessor: IViewZoneChangeAccessor,
		afterLineNumber: number,
		height: number,
		viewZoneIdsToCleanUp: string[],
	) {
		super();

		this.viewZoneId = viewZoneAccessor.addZone({
			domNode: document.createElement('div'),
			afterLineNumber: afterLineNumber,
			heightInPx: height,
			ordinal: 50000 + 1,
			onComputedHeight: (height) => {
				this.widgetDomNode.style.height = `${height}px`;
			},
			onDomNodeTop: (top) => {
				this.widgetDomNode.style.top = `${top}px`;
			}
		});
		viewZoneIdsToCleanUp.push(this.viewZoneId);

		const layout = () => {
			this.widgetDomNode.style.left = this.editor.getLayoutInfo().contentLeft + 'px';
		};
		layout();
		this._register(this.editor.onDidLayoutChange(layout));

		this.editor.addOverlayWidget(this.overlayWidget);

		this._register({
			dispose: () => {
				this.editor.removeOverlayWidget(this.overlayWidget);
			},
		});
	}
}
