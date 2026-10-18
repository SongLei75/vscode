/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { BatonClient, getConnectionModes, type BoardLifecycle, type ManagedBoard, type BatonBoard, type ConnectionMode, type OpenOptions, type BoardSnapshot } from '@carizon/board-session';

type CollectedBoard = { board: ManagedBoard } | { client: BatonClient; board: BatonBoard };

/** Host input only; resource registration and chat ownership belong to BoardConnection. */
export async function collectBoard(context: vscode.ExtensionContext, cancelled: () => boolean, sessionResource: string, flowId: string): Promise<CollectedBoard> {
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
			hint = vscode.l10n.t("请输入一个 1 到 65535 之间的 TCP 端口; 留空 = 22");
		}
	};
	const modeLabels: Record<ConnectionMode, string> = {
		direct: vscode.l10n.t("Direct"), baton: vscode.l10n.t("Baton"), jumpserver: vscode.l10n.t("JumpServer"),
	};
	const mode = await showPick(vscode.l10n.t("连接模式"), getConnectionModes().map(id => ({ id, label: modeLabels[id] })), sessionResource, flowId);
	if (cancelled()) { throw new vscode.CancellationError(); }
	if (mode === 'baton') {
		const client = new BatonClient();
		// Credentials are isolated by service URL and stored in the extension host's secret storage.
		const tokenKey = `boardsession.baton.token:${client.apiUrl}:${client.authUrl}`;
		const token = await context.secrets.get(tokenKey);
		if (!await client.validateToken(token)) {
			await context.secrets.delete(tokenKey);
			let username = '';
			while (!username) { username = await ask(vscode.l10n.t("Username"), vscode.l10n.t("Baton username")); }
			let password = '';
			while (!password) { password = await ask(vscode.l10n.t("Password"), vscode.l10n.t("Baton password"), true); }
			const token = await client.login(username, password);
			await context.secrets.store(tokenKey, token);
		}
		if (cancelled()) { throw new vscode.CancellationError(); }
		const boards = await client.listAvailableBoards();
		if (!boards.length) { throw new Error(vscode.l10n.t("暂无可用板卡.")); }
		const id = await showPick(vscode.l10n.t("Baton · 可预约板卡列表"), boards.map(board => ({
			id: board.b_id, label: `${board.device_code} · ${board.vehicle_model || board.project_code || board.hardware_platform || board.type_name || ''}`,
		})), sessionResource, flowId);
		const board = boards.find(board => board.b_id === id)!;
		return { client, board };
	}
	const host = await ask(vscode.l10n.t("Board · IP / Host"), '192.168.2.62');
	const username = await ask(vscode.l10n.t("Board · User"), 'root');
	const port = await askPort(vscode.l10n.t("Board · Port"));
	const jumps: NonNullable<OpenOptions['jumps']> = [];
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
	const connection: OpenOptions = { board: { host: host || '192.168.2.62', username: username || 'root', port }, jumps };
	return { board: { id: randomUUID(), name: connection.board.host, connection, expiresAt: null } };
}

async function showPick(title: string, choices: readonly { id: string; label: string }[], sessionResource: string, flowId: string): Promise<string> {
	const id = await vscode.commands.executeCommand<string | undefined>('_workbench.chat.showPick', { id: flowId, title, choices, sessionResource });
	if (!choices.some(choice => choice.id === id)) { throw new vscode.CancellationError(); }
	return id!;
}

export async function pickBoard(snapshot: BoardSnapshot, sessionResource: string, flowId: string): Promise<string> {
	const choices = snapshot.boards.filter(board => board.available).map(board => ({ id: board.id, label: board.name }));
	choices.push({ id: 'add', label: vscode.l10n.t("添加板子") });
	return showPick(vscode.l10n.t("点击连接开发板"), choices, sessionResource, flowId);
}

/** A successful register transfers release ownership to the Manager exactly once. */
export async function reserveManagedBoard(client: BatonClient, board: BatonBoard, register: (board: ManagedBoard, lifecycle: BoardLifecycle) => void): Promise<string> {
	if (!client.listDurations().some(duration => duration.minutes === 60)) {
		throw new Error(vscode.l10n.t("Baton does not support the required 60 minute reservation."));
	}
	const reservation = await client.reserve(board, 60);
	try {
		const connection = await client.resolveConnection(reservation, board);
		const expiresAt = Date.parse(reservation.end_at);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { throw new Error(vscode.l10n.t("Baton returned an invalid reservation expiration.")); }
		const id = `baton:${client.apiUrl}:${reservation.b_id}`;
		register({ id, name: board.device_code, connection, expiresAt }, {
			renew: minutes => client.renew(reservation.b_id, minutes), release: () => client.release(reservation.b_id),
		});
		return id;
	} catch (error) {
		try { await client.release(reservation.b_id); }
		catch (releaseError) { throw new Error(vscode.l10n.t("Could not register reservation {0}: {1}. Compensation release also failed: {2}. Release this reservation through Baton.", reservation.b_id, String(error), String(releaseError))); }
		throw error;
	}
}

export const managementCommands = ['boardsession.select', 'boardsession.remove', 'boardsession.add', 'boardsession.disconnect', 'boardsession.cancel'];

/** Snapshot-derived Markdown; every link carries the chat that opened this hover. */
export function boardHover(snapshot: BoardSnapshot, sessionResource: string, boundId: string | undefined, busy: boolean): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	const link = (label: string, command: string, id?: string) => {
		const text = new vscode.MarkdownString().appendText(label).value;
		return `[${text}](command:${command}?${encodeURIComponent(JSON.stringify([{ id, sessionResource }]))})`;
	};
	markdown.appendMarkdown(link(vscode.l10n.t("添加开发板"), 'boardsession.add'));
	markdown.appendMarkdown('\n\n');
	if (busy) {
		markdown.appendText(vscode.l10n.t("正在连接…"));
		markdown.appendMarkdown('\n\n');
	}
	for (const board of snapshot.boards) {
		const command = board.id === boundId ? 'boardsession.disconnect' : 'boardsession.select';
		const name = board.available || board.id === boundId ? link(board.name, command, board.id) : new vscode.MarkdownString().appendText(board.name).value;
		markdown.appendMarkdown(board.id === boundId ? `√ **${name}**` : name);
		markdown.appendMarkdown(` · ${link(vscode.l10n.t("释放"), 'boardsession.remove', board.id)}`);
		if (board.error) { markdown.appendText(` · ${board.error.message}`); }
		markdown.appendMarkdown('  \n');
	}
	if (busy) { markdown.appendMarkdown(link(vscode.l10n.t("取消连接"), 'boardsession.cancel')); }
	return markdown;
}
