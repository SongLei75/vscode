/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export class BoardPanelInput extends EditorInput {
	static readonly ID = 'workbench.input.carizonBoardPanel';
	private static readonly inputs = new Map<string, BoardPanelInput>();
	readonly resource = undefined;

	static getOrCreate(chatResource: string, commandService: ICommandService): BoardPanelInput {
		let input = this.inputs.get(chatResource);
		if (!input || input.isDisposed()) {
			input = new BoardPanelInput(chatResource, commandService);
			this.inputs.set(chatResource, input);
		}
		return input;
	}

	constructor(readonly chatResource: string, private readonly commandService: ICommandService) {
		super();
	}

	override get typeId(): string { return BoardPanelInput.ID; }
	override getName(): string { return 'CarizonBoards'; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof BoardPanelInput && this.chatResource === other.chatResource;
	}
	override async resolve(): Promise<null> { return null; }
	override dispose(): void {
		if (!this.isDisposed()) {
			BoardPanelInput.inputs.delete(this.chatResource);
			void this.commandService.executeCommand('boardsession.panel.closed', this.chatResource);
		}
		super.dispose();
	}
}
