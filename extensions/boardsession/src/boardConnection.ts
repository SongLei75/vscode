/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BoardManager, BoardSession, type BoardEvent, type BoardState, type ProviderInfo, type AvailableBoard } from '@carizon/board-session';

interface ChatBinding {
	boardId: string;
	session: BoardSession;
}

interface ChatOperation {
	cancelled: boolean;
}

const boardTools = ['board_terminal_run', 'board_terminal_send', 'board_terminal_output', 'board_terminal_kill'];
const localTerminalTools = ['run_in_terminal', 'send_to_terminal', 'get_terminal_output', 'kill_terminal', 'terminal_selection', 'terminal_last_command', 'vscode_get_terminal_confirmation'];

/** Owns chat bindings and host interactions. The npm Manager owns resources and their lifecycle. */
export class BoardConnection implements vscode.Disposable {
	private readonly manager = new BoardManager();
	private openPanel?: (key: string) => void;
	private onChange?: () => void;
	private readonly bindings = new Map<string, ChatBinding>();
	// Retain mode after SSH loss or resource release, until the user explicitly returns to local tools.
	private readonly boardModes = new Set<string>();
	private readonly operations = new Map<string, ChatOperation>();
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor() {
		this.unsubscribe = this.manager.onDidChange(event => this.onBoardEvent(event));
	}

	setPanelOpener(opener: (key: string) => void, onChange: () => void): void {
		this.openPanel = opener;
		this.onChange = onChange;
	}

	getProviders(): ProviderInfo[] { return this.manager.getProviders(); }
	login(providerId: string, credentials?: { username: string; password: string }): Promise<void> { return this.manager.login(providerId, credentials); }
	listAvailableBoards(providerId: string): Promise<AvailableBoard[]> { return this.manager.listAvailableBoards(providerId); }
	listManagedBoards(): BoardState[] { return this.manager.listManagedBoards(); }
	getCurrentBoard(resource: string): string | undefined { const binding = this.bindings.get(this.chatKey(resource)); return binding && !binding.session.isClosed ? binding.boardId : undefined; }
	isBusy(resource: string): boolean { return this.operations.has(this.chatKey(resource)); }

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
			await binding.session.close();
		}
		const active = this.boardModes.has(key);
		const busy = this.operations.has(key);
		const connected = this.bindings.has(key);
		const label = busy ? vscode.l10n.t("Board · Cancel Connection") : connected ? vscode.l10n.t("Board · Connected") : active ? vscode.l10n.t("Board · Disconnected / Released") : vscode.l10n.t("Connect to Board");
		const tools = active ? Object.fromEntries([...boardTools.map(id => [id, true]), ...localTerminalTools.map(id => [id, false])]) : undefined;
		await vscode.commands.executeCommand('_workbench.chat.setSessionActionState', key, 'boardsession.toggle', { active, busy, connected, label }, tools);
		this.onChange?.();
	}


	private onBoardEvent(event: BoardEvent): void {
		if (this.disposed) { return; }
		if (event.type === 'released' || event.type === 'releaseFailed') {
			for (const [key, binding] of this.bindings) {
				if (binding.boardId === event.id) {
					this.bindings.delete(key);
					void this.publishState(key).catch(error => console.error('Board UI refresh failed', error));
				}
			}
		}
		if (event.error) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Board {0}: {1}. Open board management to inspect or remove the resource.", event.name, event.error.message));
		} else if (event.type === 'released') {
			void vscode.window.showInformationMessage(vscode.l10n.t("Board {0} is no longer available. Its chats remain in board mode; reconnect or explicitly return to local tools.", event.name));
		}
		this.onChange?.();
	}

	private async runUi(key: string, action: (cancelled: () => boolean) => Promise<void>): Promise<void> {
		if (this.disposed || this.operations.has(key)) { return; }
		const state: ChatOperation = { cancelled: false };
		this.operations.set(key, state);
		const cancelled = () => this.disposed || state.cancelled;
		try {
			await this.publishState(key);
			this.onChange?.();
			await action(cancelled);
		} catch (error) {
			if (!(error instanceof vscode.CancellationError) && !cancelled()) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Board operation failed: {0}", String(error)));
			}
		} finally {
			if (this.operations.get(key) === state) { this.operations.delete(key); }
			await this.publishState(key);
			this.onChange?.();
		}
	}

	private async connect(key: string, id: string, cancelled: () => boolean): Promise<void> {
		if (cancelled()) { throw new vscode.CancellationError(); }
		const previous = this.bindings.get(key);
		const wasInBoardMode = this.boardModes.has(key);
		if (previous?.boardId === id && !previous.session.isClosed) {
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
			if (previous) { await previous.session.close(); }
		} catch (error) {
			// A failed first connection must not strand a local chat in board mode.
			if (!bound && !wasInBoardMode) { this.boardModes.delete(key); }
			throw error;
		} finally {
			if (!bound) {
				try { await session.close(); }
				catch (error) { console.error('Board session cleanup failed', error); }
			}
		}
	}

	/** Clicking Chat's toolbar opens a single editor panel instead of nested Chat prompts. */
	async toggle(resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		if (this.operations.has(key)) { await this.cancel(key); return; }
		await this.publishState(key);
		this.openPanel?.(key);
	}

	async addProviderBoard(providerId: string, input: unknown, resource: string): Promise<string | undefined> {
		const key = this.chatKey(resource);
		let acquiredId: string | undefined;
		await this.runUi(key, async cancelled => {
			if (cancelled()) { return; }
			const board = await this.manager.addBoard(providerId, input);
			acquiredId = board.id;
			await this.connect(key, board.id, cancelled);
		});
		// An SSH failure does not roll back a successfully managed reservation.
		return acquiredId;
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
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Remove {0}? This closes all its SSH sessions and removes the board.", board.name), { modal: true }, confirm) !== confirm || cancelled()) { return; }
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
			throw new Error(vscode.l10n.t("Board disconnected or released. Reconnect from this chat; no command was sent locally."));
		}
		const listener = token.onCancellationRequested(() => {
			void binding.session.close().finally(async () => {
				await this.publishState(key);
			}).catch(error => console.error('Board cancellation failed', error));
		});
		try {
			const result = await operation(binding.session);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			return result;
		} finally {
			listener.dispose();
			await this.publishState(key);
		}
	}

	async cancel(resource?: string): Promise<void> {
		const key = this.chatKey(resource);
		const operation = this.operations.get(key);
		if (operation) { operation.cancelled = true; }
	}

	private async closeChatBinding(key: string, restoreLocal: boolean): Promise<void> {
		const binding = this.bindings.get(key);
		this.bindings.delete(key);
		try {
			if (binding) { await binding.session.close(); }
		} finally {
			if (restoreLocal) { this.boardModes.delete(key); }
			await this.publishState(key);
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
		for (const operation of this.operations.values()) { operation.cancelled = true; }
		// BoardManager no longer has dispose(). Best-effort release of all owned resources.
		for (const board of this.manager.listManagedBoards()) {
			void this.manager.removeBoard(board.id).catch(error => console.error('BoardSession shutdown failed', board.name, error));
		}
	}
}
