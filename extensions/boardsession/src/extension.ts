/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardSession } from '@carizon/board-session';
import { BoardConnection } from './boardConnection.js';
import { BoardManagementUi } from './boardManagementUi.js';
import { registerBoardTerminalTools } from './boardTerminalTools.js';

/** Attaches the independent BoardSession package to Chat. */
export async function activate(context: vscode.ExtensionContext) {
	const connection = new BoardConnection();
	context.subscriptions.push(connection);
	context.subscriptions.push(new BoardManagementUi(connection));
	await connection.initialize();
	context.subscriptions.push(
		vscode.commands.registerCommand('boardsession.toggle', (context?: { sessionResource?: string }) => connection.toggle(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.deactivate', (context?: { sessionResource?: string }) => connection.disconnect(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.disconnect', (context?: { sessionResource?: string }) => connection.disconnect(context?.sessionResource)),
		vscode.commands.registerCommand('boardsession.cancel', (context?: { sessionResource?: string }) => connection.cancel(context?.sessionResource)),
	);
	registerBoardTerminalTools(context, connection);
	return { BoardSession };
}
