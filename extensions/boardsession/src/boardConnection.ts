/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BoardManager, BoardSession, type BatonClient, type BatonBoard, type BoardEvent } from '@carizon/board-session';
import { boardHover, collectBoard, pickBoard, reserveManagedBoard } from './boardManagementUi.js';

interface ChatBinding {
	boardId: string;
	session: BoardSession;
}

interface ChatOperation {
	cancelled: boolean;
	flowId: string;
}

const boardTools = ['board_terminal_run', 'board_terminal_send', 'board_terminal_output', 'board_terminal_kill'];
const localTerminalTools = ['run_in_terminal', 'send_to_terminal', 'get_terminal_output', 'kill_terminal', 'terminal_selection', 'terminal_last_command', 'vscode_get_terminal_confirmation'];

/** Owns chat bindings and host interactions. The npm Manager owns resources and their lifecycle. */
export class BoardConnection implements vscode.Disposable {
	private readonly manager = new BoardManager();
	private readonly bindings = new Map<string, ChatBinding>();
	// Retain mode after SSH loss or resource release, until the user explicitly returns to local tools.
	private readonly boardModes = new Set<string>();
	private readonly operations = new Map<string, ChatOperation>();
	private readonly reservations = new Map<string, Promise<string>>();
	private readonly batonBoards = new Map<string, string>();
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.unsubscribe = this.manager.onDidChange(event => this.onBoardEvent(event));
	}

	private chatKey(resource: string | vscode.Uri | undefined): string {
		if (!resource) { throw new Error(vscode.l10n.t("This action requires a Chat session. Use that chat's connection button.")); }
		const uri = typeof resource === 'string' ? vscode.Uri.parse(resource, true) : resource;
		return uri.toString();
	}

	async initialize(): Promise<void> {
		const identityFile = vscode.workspace.getConfiguration('boardsession').get<string>('identityFile');
		const defaultIdentity = fileURLToPath(new URL('../prebuilds/debug.key', import.meta.resolve('@carizon/board-session')));
		const identity = await readFile(identityFile || defaultIdentity);
		try { await BoardSession.setIdentity(identity); }
		finally { identity.fill(0); }
		await vscode.commands.executeCommand('_workbench.chat.setSessionActionState', '', 'boardsession.toggle', undefined,
			Object.fromEntries(boardTools.map(id => [id, false])));
	}

	private async publishState(key: string): Promise<void> {
		if (this.disposed) { return; }
		const binding = this.bindings.get(key);
		if (binding?.session.isClosed) {
			this.bindings.delete(key);
			await this.manager.closeSession(binding.session);
		}
		const active = this.boardModes.has(key);
		const busy = this.operations.has(key);
		const connected = this.bindings.has(key);
		const label = busy ? vscode.l10n.t("Board · Cancel Connection") : connected ? vscode.l10n.t("Board · Connected") : active ? vscode.l10n.t("Board · Disconnected / Released") : vscode.l10n.t("Connect to Board");
		const tools = active ? Object.fromEntries([...boardTools.map(id => [id, true]), ...localTerminalTools.map(id => [id, false])]) : undefined;
		await vscode.commands.executeCommand('_workbench.chat.setSessionActionState', key, 'boardsession.toggle', { active, busy, connected, label }, tools);
	}

	private async invalidateHover(key?: string): Promise<void> {
		if (this.disposed) { return; }
		try {
			if (key === undefined) {
				await vscode.commands.executeCommand('_workbench.chat.invalidateActionHover', 'boardsession.toggle');
			} else {
				await vscode.commands.executeCommand('_workbench.chat.invalidateActionHover', 'boardsession.toggle', key);
			}
		} catch (error) {
			console.error('Board hover refresh failed', error);
		}
	}

	private onBoardEvent(event: BoardEvent): void {
		if (this.disposed) { return; }
		if (event.type === 'released' || event.type === 'expired' || event.type === 'releaseFailed') {
			for (const [key, binding] of this.bindings) {
				if (binding.boardId === event.id) {
					this.bindings.delete(key);
					void this.publishState(key).catch(error => console.error('Board UI refresh failed', error));
				}
			}
		}
		if (event.error) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Board {0}: {1}. Open the connection hover to inspect or remove the resource.", event.name, event.error.message));
		} else if (event.type === 'released' || event.type === 'expired') {
			void vscode.window.showInformationMessage(vscode.l10n.t("Board {0} was released or expired. Its chats remain in board mode; reconnect or explicitly return to local tools.", event.name));
		}
		void this.invalidateHover();
	}

	async hover(resource?: string): Promise<vscode.MarkdownString> {
		const key = this.chatKey(resource);
		const snapshot = await this.manager.refresh();
		await this.publishState(key);
		return boardHover(snapshot, key, this.bindings.get(key)?.boardId, this.operations.has(key));
	}

	private async runUi(key: string, operation: (cancelled: () => boolean, flowId: string) => Promise<void>): Promise<void> {
		if (this.disposed || this.operations.has(key)) { return; }
		const state: ChatOperation = { cancelled: false, flowId: `boardsession:${randomUUID()}` };
		this.operations.set(key, state);
		const cancelled = () => this.disposed || state.cancelled;
		try {
			await this.publishState(key);
			await this.invalidateHover(key);
			await operation(cancelled, state.flowId);
		} catch (error) {
			if (!(error instanceof vscode.CancellationError) && !cancelled()) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Board operation failed: {0}", String(error)));
			}
		} finally {
			await vscode.commands.executeCommand('_workbench.chat.closeInput', state.flowId);
			if (this.operations.get(key) === state) { this.operations.delete(key); }
			await this.publishState(key);
			await this.invalidateHover(key);
		}
	}

	private async connect(key: string, id: string, cancelled: () => boolean): Promise<void> {
		if (cancelled()) { throw new vscode.CancellationError(); }
		const previous = this.bindings.get(key);
		const wasInBoardMode = this.boardModes.has(key);
		if (previous?.boardId === id && !previous.session.isClosed) {
			await this.closeChatBinding(key, true);
			return;
		}
		const session = await this.manager.openBoard(id);
		let bound = false;
		try {
			if (cancelled()) { throw new vscode.CancellationError(); }
			// Publish the execution guard before replacing the session. Failed switching keeps the old binding.
			this.boardModes.add(key);
			await this.publishState(key);
			if (cancelled()) { throw new vscode.CancellationError(); }
			this.bindings.set(key, { boardId: id, session });
			bound = true;
			if (previous) { await this.manager.closeSession(previous.session); }
		} catch (error) {
			// A failed first connection must not strand a local chat in board mode.
			if (!bound && !wasInBoardMode) { this.boardModes.delete(key); }
			throw error;
		} finally {
			if (!bound) {
				try { await this.manager.closeSession(session); }
				catch (error) { console.error('Board session cleanup failed', error); }
			}
		}
	}

	private acquireBaton(client: BatonClient, board: BatonBoard): Promise<string> {
		const deviceKey = `${client.apiUrl}:${board.b_id}`;
		const existing = this.batonBoards.get(deviceKey);
		if (existing && this.manager.getBoard(existing)) { return Promise.resolve(existing); }
		const pending = this.reservations.get(deviceKey);
		if (pending) { return pending; }
		const acquiring = reserveManagedBoard(client, board, (managed, lifecycle) => {
			if (this.disposed) { throw new vscode.CancellationError(); }
			this.manager.addBoard(managed, lifecycle);
			this.batonBoards.set(deviceKey, managed.id);
			void this.invalidateHover();
		});
		this.reservations.set(deviceKey, acquiring);
		void acquiring.finally(() => this.reservations.delete(deviceKey)).catch(() => {});
		return acquiring;
	}

	private async add(key: string, cancelled: () => boolean, flowId: string): Promise<void> {
		const collected = await collectBoard(this.context, cancelled, key, flowId);
		if (cancelled()) { throw new vscode.CancellationError(); }
		let id: string;
		if ('client' in collected) {
			id = await this.acquireBaton(collected.client, collected.board);
		} else {
			this.manager.addBoard(collected.board);
			id = collected.board.id;
			await this.invalidateHover();
		}
		// Once registered, the Manager owns the resource, even if this chat's SSH open fails/cancels.
		await this.connect(key, id, cancelled);
	}

	async toggle(resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		if (this.operations.has(key)) { await this.cancel(key); return; }
		await this.runUi(key, async (cancelled, flowId) => {
			const snapshot = await this.manager.refresh();
			const choice = await pickBoard(snapshot, key, flowId);
			if (choice === 'add') { await this.add(key, cancelled, flowId); }
			else { await this.connect(key, choice, cancelled); }
		});
	}

	async addBoard(resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		await this.runUi(key, (cancelled, flowId) => this.add(key, cancelled, flowId));
	}

	async selectBoard(id: string, resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		await this.runUi(key, cancelled => this.connect(key, id, cancelled));
	}

	async removeBoard(id: string, resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		await this.runUi(key, async cancelled => {
			const board = this.manager.getBoard(id);
			if (!board) { return; }
			const confirm = vscode.l10n.t("释放");
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Remove {0}? This closes all its SSH sessions and releases its reservation if present.", board.name), { modal: true }, confirm) !== confirm || cancelled()) { return; }
			await this.manager.removeBoard(id);
		});
	}

	/** Cancel only this call's captured SSH, including when its chat switches during execution. */
	async invoke<T>(resource: vscode.Uri | undefined, operation: (session: BoardSession) => T | Promise<T>, token: vscode.CancellationToken): Promise<T> {
		const key = this.chatKey(resource);
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const binding = this.bindings.get(key);
		if (!binding || binding.session.isClosed) {
			await this.publishState(key);
			await this.invalidateHover(key);
			throw new Error(vscode.l10n.t("Board disconnected or released. Reconnect from this chat; no command was sent locally."));
		}
		const listener = token.onCancellationRequested(() => {
			void this.manager.closeSession(binding.session).finally(async () => {
				await this.publishState(key);
				await this.invalidateHover(key);
			}).catch(error => console.error('Board cancellation failed', error));
		});
		try {
			const result = await operation(binding.session);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			return result;
		} finally {
			listener.dispose();
			await this.publishState(key);
			if (binding.session.isClosed) { await this.invalidateHover(key); }
		}
	}

	async cancel(resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		const operation = this.operations.get(key);
		if (operation) {
			operation.cancelled = true;
			await vscode.commands.executeCommand('_workbench.chat.closeInput', operation.flowId);
		}
	}

	private async closeChatBinding(key: string, restoreLocal: boolean): Promise<void> {
		const binding = this.bindings.get(key);
		this.bindings.delete(key);
		try {
			if (binding) { await this.manager.closeSession(binding.session); }
		} finally {
			if (restoreLocal) { this.boardModes.delete(key); }
			await this.publishState(key);
			await this.invalidateHover(key);
		}
	}

	/** Only an explicit user action restores local tools; tool kill keeps board mode selected. */
	async disconnect(resource?: string, restoreLocal = true): Promise<void> {
		const key = this.chatKey(resource);
		await this.cancel(key);
		await this.closeChatBinding(key, restoreLocal);
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		for (const operation of this.operations.values()) {
			operation.cancelled = true;
			void vscode.commands.executeCommand('_workbench.chat.closeInput', operation.flowId);
		}
		void this.manager.dispose().catch(error => console.error('BoardSession shutdown failed', error));
	}
}
