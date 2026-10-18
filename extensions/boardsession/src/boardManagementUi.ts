/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	BoardManager,
	type BatonBoardInput,
	type BatonCredentials,
	type BoardState,
	type StaticBoardInput,
} from '@carizon/board-session';

type CollectedBoard =
	| { providerId: 'static'; input: StaticBoardInput }
	| { providerId: 'baton'; input: BatonBoardInput };

const staticId = 'static';
const batonId = 'baton';

/** The Chat owns UI; Manager and its providers own discovery, acquisition and lifetime. */
export async function collectBoard(manager: BoardManager, cancelled: () => boolean, sessionResource: string, flowId: string): Promise<CollectedBoard> {
	const ask = async (title: string, placeholder: string, password = false): Promise<string> => {
		if (cancelled()) { throw new vscode.CancellationError(); }
		const value = await vscode.commands.executeCommand<string | undefined>('_workbench.chat.showInput', {
			id: flowId, title, placeholder, password, sessionResource,
		});
		if (value === undefined || cancelled()) { throw new vscode.CancellationError(); }
		return password ? value : value.trim();
	};
	const askPort = async (title: string): Promise<number> => {
		let hint = vscode.l10n.t("22 (default)");
		for (;;) {
			const value = await ask(title, hint);
			const port = Number(value || 22);
			if (/^\d*$/.test(value) && port > 0 && port <= 65535) { return port; }
			hint = vscode.l10n.t("Enter a TCP port from 1 to 65535; empty = 22");
		}
	};
	// Preserve the original three user-visible modes. Both Direct and JumpServer
	// are handled by the new package's single static provider.
	const providers = new Set(manager.getProviders().map(provider => provider.id));
	const modes: { id: string; label: string }[] = [];
	if (providers.has(staticId)) { modes.push({ id: 'direct', label: vscode.l10n.t("Direct") }); }
	if (providers.has(batonId)) { modes.push({ id: 'baton', label: vscode.l10n.t("Baton") }); }
	if (providers.has(staticId)) { modes.push({ id: 'jumpserver', label: vscode.l10n.t("JumpServer") }); }
	const mode = await showPick(vscode.l10n.t("连接模式"), modes, sessionResource, flowId);
	if (cancelled()) { throw new vscode.CancellationError(); }

	if (mode === 'baton') {
		// An existing valid token is reused by the package's provider in this host.
		// Its token is intentionally private and is not exported for SecretStorage.
		try {
			await manager.login(batonId);
		} catch (error) {
			if (!(error instanceof TypeError) || !error.message.includes('Baton authentication requires')) { throw error; }
			let username = '';
			while (!username) { username = await ask(vscode.l10n.t("Username"), vscode.l10n.t("Baton username")); }
			let password = '';
			while (!password) { password = await ask(vscode.l10n.t("Password"), vscode.l10n.t("Baton password"), true); }
			const credentials: BatonCredentials = { username, password };
			if (cancelled()) { throw new vscode.CancellationError(); }
			await manager.login(batonId, credentials);
		}
		if (cancelled()) { throw new vscode.CancellationError(); }
		const boards = await manager.listAvailableBoards(batonId);
		if (cancelled()) { throw new vscode.CancellationError(); }
		if (!boards.length) { throw new Error(vscode.l10n.t("暂无可用板卡.")); }
		const boardId = await showPick(vscode.l10n.t("Baton · 可预约板卡列表"), boards.map(board => ({
			id: board.id, label: board.name,
		})), sessionResource, flowId);
		const input: BatonBoardInput = { boardId };
		return { providerId: 'baton', input };
	}

	const host = await ask(vscode.l10n.t("Board · IP / Host"), '192.168.2.62');
	const username = await ask(vscode.l10n.t("Board · User"), 'root');
	const port = await askPort(vscode.l10n.t("Board · Port"));
	const jumps: NonNullable<StaticBoardInput['jumps']> = [];
	for (let index = 1; mode === 'jumpserver'; index++) {
		const host = await ask(vscode.l10n.t("Jump {0} · IP / Host", index), vscode.l10n.t("留空以完成并连接"));
		if (!host) {
			if (jumps.length) { break; }
			void vscode.window.showWarningMessage(vscode.l10n.t("JumpServer 至少需要一个跳板。直接连接板卡可以使用 Direct 模式。"));
			index--;
			continue;
		}
		const username = await ask(vscode.l10n.t("Jump {0} · User", index), 'root');
		const port = await askPort(vscode.l10n.t("Jump {0} · Port", index));
		const password = await ask(vscode.l10n.t("Jump {0} · Password", index), vscode.l10n.t("留空以使用默认密码"), true);
		jumps.push({ host, username: username || 'root', port, password: password || '123456' });
	}
	const input: StaticBoardInput = { board: { host: host || '192.168.2.62', username: username || 'root', port }, jumps };
	return { providerId: 'static', input };
}

async function showPick(title: string, choices: readonly { id: string; label: string }[], sessionResource: string, flowId: string): Promise<string> {
	const id = await vscode.commands.executeCommand<string | undefined>('_workbench.chat.showPick', { id: flowId, title, choices, sessionResource });
	if (!choices.some(choice => choice.id === id)) { throw new vscode.CancellationError(); }
	return id!;
}

export async function pickBoard(snapshot: readonly BoardState[], sessionResource: string, flowId: string): Promise<string> {
	const choices = snapshot.filter(board => board.available).map(board => ({ id: board.id, label: board.name }));
	choices.push({ id: 'add', label: vscode.l10n.t("添加板子") });
	return showPick(vscode.l10n.t("点击连接开发板"), choices, sessionResource, flowId);
}

export const managementCommands = ['boardsession.select', 'boardsession.remove', 'boardsession.add', 'boardsession.disconnect', 'boardsession.cancel'];

/** Snapshot-derived Markdown; only the registered management commands are trusted. */
export function boardHover(snapshot: readonly BoardState[], sessionResource: string, boundId: string | undefined, busy: boolean): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	const link = (label: string, command: string, id?: string) => {
		const text = new vscode.MarkdownString().appendText(label).value;
		return '[' + text + '](command:' + command + '?' + encodeURIComponent(JSON.stringify([{ id, sessionResource }])) + ')';
	};
	markdown.appendMarkdown(link(vscode.l10n.t("添加开发板"), 'boardsession.add'));
	markdown.appendMarkdown('\n\n');
	if (busy) {
		markdown.appendText(vscode.l10n.t("正在连接…"));
		markdown.appendMarkdown('\n\n');
	}
	for (const board of snapshot) {
		const command = board.id === boundId ? 'boardsession.disconnect' : 'boardsession.select';
		const name = board.available || board.id === boundId ? link(board.name, command, board.id) : new vscode.MarkdownString().appendText(board.name).value;
		markdown.appendMarkdown(board.id === boundId ? '√ **' + name + '**' : name);
		markdown.appendMarkdown(' · ' + link(vscode.l10n.t("释放"), 'boardsession.remove', board.id));
		if (board.error) { markdown.appendText(' · ' + board.error.message); }
		markdown.appendMarkdown('  \n');
	}
	if (busy) { markdown.appendMarkdown(link(vscode.l10n.t("取消连接"), 'boardsession.cancel')); }
	return markdown;
}
