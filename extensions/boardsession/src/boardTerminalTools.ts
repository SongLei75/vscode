/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardConnection } from './boardConnection.js';

interface RunInput {
	command: string;
	timeoutMs?: number;
}

interface SendInput {
	command: string;
	appendNewline?: boolean;
}

const terminalId = 'board';

/** Registers the remote equivalents of Copilot's four executable terminal tools. */
export function registerBoardTerminalTools(
	context: vscode.ExtensionContext,
	connection: BoardConnection,
): void {
	const result = (value: object): vscode.LanguageModelToolResult =>
		new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);

	context.subscriptions.push(vscode.lm.registerTool<RunInput>('board_terminal_run', {
		prepareInvocation: ({ input }) => ({
			invocationMessage: vscode.l10n.t("Running a command on the connected board"),
			confirmationMessages: {
				title: vscode.l10n.t("Run command on remote board?"),
				message: input.command,
			},
		}),
		async invoke({ input }, token) {
			const output = await connection.invoke(session => session.exec(input.command, input.timeoutMs ?? 30_000), token);
			return result({ id: terminalId, ...output });
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool<SendInput>('board_terminal_send', {
		prepareInvocation: ({ input }) => ({
			invocationMessage: vscode.l10n.t("Sending input to the board terminal"),
			confirmationMessages: {
				title: vscode.l10n.t("Send input to remote board?"),
				message: input.command || vscode.l10n.t("(Enter)"),
			},
		}),
		async invoke({ input }, token) {
			const output = await connection.invoke(session => session.send(input.command, input.appendNewline ?? true), token);
			return result({ id: terminalId, ...output });
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool<Record<string, never>>('board_terminal_output', {
		async invoke(_options, token) {
			return result({ id: terminalId, ...await connection.invoke(session => session.read(), token) });
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool<Record<string, never>>('board_terminal_kill', {
		prepareInvocation: () => ({
			invocationMessage: vscode.l10n.t("Closing remote board terminal"),
			confirmationMessages: {
				title: vscode.l10n.t("Disconnect remote board terminal?"),
				message: vscode.l10n.t("The board session will close. Deactivate board mode explicitly to restore local tools."),
			},
		}),
		async invoke(_options, token) {
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			await connection.disconnect(false);
			return result({ id: terminalId, closed: true, text: 'Board session closed. Board mode remains selected; explicitly deactivate it before using local tools.' });
		},
	}));
}
