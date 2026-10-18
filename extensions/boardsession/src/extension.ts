/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardSession } from '@carizon/board-session';
import { BoardConnection } from './boardConnection.js';
import { managementCommands } from './boardManagementUi.js';
import { registerBoardTerminalTools } from './boardTerminalTools.js';

/** Attaches the independent BoardSession package to Chat. */
export async function activate(context: vscode.ExtensionContext) {
	const connection = new BoardConnection();
	context.subscriptions.push(connection);
	await connection.initialize();
	context.subscriptions.push(
		vscode.commands.registerCommand('boardsession.toggle', (context?: { sessionResource?: string }) => connection.toggle(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.deactivate', (context?: { sessionResource?: string }) => connection.disconnect(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.disconnect', (context?: { sessionResource?: string }) => connection.disconnect(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.cancel', (context?: { sessionResource?: string }) => connection.cancel(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.hover', async (context?: { sessionResource?: string }) => ({ value: (await connection.hover(context?.sessionResource)).value })),
		vscode.commands.registerCommand('boardsession.add', (context?: { sessionResource?: string }) => connection.addBoard(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.select', (context: { id: string; sessionResource?: string }) => connection.selectBoard(context.id, context.sessionResource)),
		vscode.commands.registerCommand('boardsession.remove', (context: { id: string; sessionResource?: string }) => connection.removeBoard(context.id, context.sessionResource)),
	);
	// Register terminal tools first so activation never fails when the optional hover bridge is unavailable.
	registerBoardTerminalTools(context, connection);
	// Best effort: the dynamic hover bridge is optional and must not break tool registration.
	try {
		for (const action of ['boardsession.toggle']) {
			await vscode.commands.executeCommand('_workbench.chat.registerActionHover', action, 'boardsession.hover', managementCommands);
			context.subscriptions.push(new vscode.Disposable(() => {
				void vscode.commands.executeCommand('_workbench.chat.unregisterActionHover', action, 'boardsession.hover');
			}));
		}
	} catch (error) {
		console.error('BoardSession hover bridge is unavailable; continuing without it.', error);
	}
	return { BoardSession };
}
