/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardConnection } from './boardConnection.js';

interface FileInput {
	localPath: string;
	remotePath: string;
}

/** Exposes board SCP transfers without using or interrupting the persistent shell. */
export function registerBoardFileTools(context: vscode.ExtensionContext, connection: BoardConnection): void {
	const result = (value: object): vscode.LanguageModelToolResult =>
		new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);

	context.subscriptions.push(vscode.lm.registerTool<FileInput>('board_file_upload', {
		prepareInvocation: ({ input }) => ({
			invocationMessage: vscode.l10n.t("Uploading files to the connected board"),
			confirmationMessages: {
				title: vscode.l10n.t("Upload files to remote board?"),
				message: vscode.l10n.t("{0} → {1}", input.localPath, input.remotePath),
			},
		}),
		async invoke({ input, chatSessionResource }, token) {
			const controller = new AbortController();
			await connection.invoke(chatSessionResource,
				session => session.upload(input.localPath, input.remotePath, controller.signal),
				token, () => controller.abort());
			return result({ uploaded: true, localPath: input.localPath, remotePath: input.remotePath });
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool<FileInput>('board_file_download', {
		prepareInvocation: ({ input }) => ({
			invocationMessage: vscode.l10n.t("Downloading files from the connected board"),
			confirmationMessages: {
				title: vscode.l10n.t("Download files from remote board?"),
				message: vscode.l10n.t("{0} → {1}", input.remotePath, input.localPath),
			},
		}),
		async invoke({ input, chatSessionResource }, token) {
			const controller = new AbortController();
			await connection.invoke(chatSessionResource,
				session => session.download(input.remotePath, input.localPath, controller.signal),
				token, () => controller.abort());
			return result({ downloaded: true, remotePath: input.remotePath, localPath: input.localPath });
		},
	}));
}
