/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './boardPanel.css';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { BoardPanelInput } from './boardPanelInput.js';
import { BoardPanelMessage, BoardPanelView } from './boardPanelView.js';

export const boardPanelUpdates = new Emitter<{ resource: string; message: BoardPanelMessage }>();

export class BoardPanelEditor extends EditorPane {
	static readonly ID = 'workbench.editor.carizonBoardPanel';
	private container?: HTMLElement;
	private resource?: string;
	private readonly views = new Map<string, BoardPanelView>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(BoardPanelEditor.ID, group, telemetryService, themeService, storageService);
		this._register(boardPanelUpdates.event(({ resource, message }) => this.views.get(resource)?.accept(message)));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = parent;
	}

	override async setInput(input: BoardPanelInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (this.resource && this.resource !== input.chatResource) { this.setPanelVisible(false); }
		await super.setInput(input, options, context, token);
		this.resource = input.chatResource;
		let view = this.views.get(this.resource);
		if (!view) {
			const resource = this.resource;
			view = new BoardPanelView(message => {
				void this.commandService.executeCommand('boardsession.panel.message', resource, message).catch(error => console.error('Board panel action failed', error));
			});
			this.views.set(resource, view);
			this._register(input.onWillDispose(() => this.views.delete(resource)));
		}
		this.container?.replaceChildren(view.element);
		void this.commandService.executeCommand('boardsession.panel.message', this.resource, { type: 'ready' });
		this.setPanelVisible(this.isVisible());
	}

	protected override setEditorVisible(visible: boolean): void {
		this.setPanelVisible(visible);
	}

	private setPanelVisible(visible: boolean): void {
		if (this.resource) { void this.commandService.executeCommand('boardsession.panel.visible', this.resource, visible); }
	}

	override clearInput(): void {
		this.setPanelVisible(false);
		this.resource = undefined;
		this.container?.replaceChildren();
		super.clearInput();
	}

	override layout(_dimension: Dimension): void {
		// The container fills the editor; CSS controls scrolling and responsive layout.
	}
}
