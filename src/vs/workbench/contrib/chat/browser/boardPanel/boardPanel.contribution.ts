/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BoardPanelEditor, boardPanelUpdates } from './boardPanelEditor.js';
import { BoardPanelInput } from './boardPanelInput.js';
import { BoardPanelMessage } from './boardPanelView.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(BoardPanelEditor, BoardPanelEditor.ID, 'CarizonBoards'),
	[new SyncDescriptor(BoardPanelInput)],
);

CommandsRegistry.registerCommand('_workbench.boardPanel.open', async (accessor, resource: string) => {
	if (typeof resource !== 'string' || !resource) { return; }
	await accessor.get(IEditorService).openEditor(BoardPanelInput.getOrCreate(resource, accessor.get(ICommandService)), { pinned: true });
});

CommandsRegistry.registerCommand('_workbench.boardPanel.receive', (_accessor, resource: string, message: BoardPanelMessage) => {
	if (typeof resource === 'string' && message && (message.type === 'state' || message.type === 'error')) {
		boardPanelUpdates.fire({ resource, message });
	}
});
