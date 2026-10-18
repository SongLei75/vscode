/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ObservableMap } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { chatSessionToolOverrides } from '../../../common/tools/languageModelToolsService.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { Emitter } from '../../../../../../base/common/event.js';

interface IActionHoverProvider {
	commandId: string;
	allowedCommands: string[];
	commandService: ICommandService;
}

const providers = new Map<string, IActionHoverProvider>();

interface IChatToolbarHoverChange {
	actionId: string;
	sessionResource?: URI;
}

const hoverChanges = new Emitter<IChatToolbarHoverChange>();
export const onDidChangeChatToolbarHover = hoverChanges.event;

CommandsRegistry.registerCommand('_workbench.chat.invalidateActionHover', (_accessor, actionId: string, sessionResource?: string) => {
	if (!actionId || typeof actionId !== 'string' || (sessionResource !== undefined && typeof sessionResource !== 'string')) {
		throw new Error('Invalid chat action hover invalidation');
	}
	if (providers.has(actionId)) {
		hoverChanges.fire({ actionId, sessionResource: sessionResource === undefined ? undefined : URI.parse(sessionResource) });
	}
});

// Internal bridge: extensions own the content and callbacks, the toolbar owns rendering.
CommandsRegistry.registerCommand('_workbench.chat.registerActionHover', (accessor, actionId: string, commandId: string, allowedCommands: string[]) => {
	if (!actionId || typeof actionId !== 'string' || !commandId || typeof commandId !== 'string' ||
		!Array.isArray(allowedCommands) || allowedCommands.some(command => typeof command !== 'string')) {
		throw new Error('Invalid chat action hover provider');
	}
	providers.set(actionId, { commandId, allowedCommands: [...allowedCommands], commandService: accessor.get(ICommandService) });
});

CommandsRegistry.registerCommand('_workbench.chat.unregisterActionHover', (_accessor, actionId: string, commandId: string) => {
	if (providers.get(actionId)?.commandId === commandId) { providers.delete(actionId); }
});

/** Resolves on each hover, including providers registered after the toolbar was rendered. */
export function getChatToolbarHover(actionId: string, fallback: string | undefined, context: () => { sessionResource?: string }): IManagedHoverContent {
	return {
		markdownNotSupportedFallback: fallback,
		markdown: async token => {
			const provider = providers.get(actionId);
			if (!provider || token.isCancellationRequested) { return fallback; }
			try {
				const content = await provider.commandService.executeCommand<{ value: string } | undefined>(provider.commandId, context());
				if (token.isCancellationRequested || providers.get(actionId) !== provider) { return undefined; }
				if (typeof content?.value !== 'string') { return fallback; }
				return { value: content.value, isTrusted: { enabledCommands: provider.allowedCommands }, supportHtml: false };
			} catch {
				// A stopped extension host or failed provider must not break the toolbar.
				return fallback;
			}
		},
	};
}

interface IChatSessionActionState {
	active: boolean;
	busy: boolean;
	connected: boolean;
	label: string;
}

export const chatSessionActionStates = new ObservableMap<string, ReadonlyMap<string, IChatSessionActionState>>();

// Extensions supply only UI state and tool IDs; resource ownership stays in the extension.
CommandsRegistry.registerCommand('_workbench.chat.setSessionActionState', (_accessor, sessionResource: string, actionId: string, state: IChatSessionActionState | undefined, tools: Record<string, boolean> | undefined) => {
	if (typeof sessionResource !== 'string' || typeof actionId !== 'string') { throw new Error('Invalid chat action state'); }
	const key = sessionResource ? URI.parse(sessionResource).toString() : '';
	if (state) { chatSessionActionStates.set(key, new Map([[actionId, state]])); }
	else { chatSessionActionStates.delete(key); }
	if (tools) { chatSessionToolOverrides.set(key, new Map(Object.entries(tools))); }
	else { chatSessionToolOverrides.delete(key); }
});
