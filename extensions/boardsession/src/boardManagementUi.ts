/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AvailableBoard, ProviderInfo, StaticBoardInput } from '@carizon/board-session';
import type { BoardConnection } from './boardConnection.js';

interface ProviderStatus extends ProviderInfo {
	status: 'pending' | 'loading' | 'ready' | 'error' | 'login';
	authenticated: boolean;
	error?: string;
	available: AvailableBoard[];
}

interface PanelState {
	resource: string;
	visible: boolean;
	providers: ProviderStatus[];
	started: boolean;
}

function needsLogin(error: unknown): boolean {
	return error instanceof Error && (
		('code' in error && (error.code === 401 || error.code === 403)) ||
		/authentication require[sd]|username and password|unauthori[sz]ed|invalid token|401/i.test(error.message)
	);
}

function requiredString(value: unknown, label: string, fallback: string): string {
	if (value === undefined || value === null || value === '') { if (!fallback) { throw new TypeError('Missing ' + label); } return fallback; }
	if (typeof value !== 'string' || !value.trim() || value.length > 512) { throw new TypeError('Invalid ' + label); }
	return value.trim();
}

function port(value: unknown): number {
	const result = value === undefined || value === '' ? 22 : Number(value);
	if (!Number.isInteger(result) || result < 1 || result > 65535) { throw new RangeError('Port must be 1 to 65535'); }
	return result;
}

function staticInput(raw: unknown): StaticBoardInput {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new TypeError('Invalid static board'); }
	const value = raw as Record<string, unknown>;
	if (!Array.isArray(value.jumps) || value.jumps.length > 12) { throw new TypeError('Invalid jump servers'); }
	const board = {
		host: requiredString(value.host, 'board host', '192.168.2.62'),
		username: requiredString(value.username, 'board username', 'root'),
		port: port(value.port),
	};
	const jumps = value.jumps.map((rawJump: unknown) => {
		if (!rawJump || typeof rawJump !== 'object' || Array.isArray(rawJump)) { throw new TypeError('Invalid jump'); }
		const jump = rawJump as Record<string, unknown>;
		const password = jump.password === undefined || jump.password === '' ? '123456' : jump.password;
		if (typeof password !== 'string' || password.length > 4096) { throw new TypeError('Invalid jump password'); }
		return {
			host: requiredString(jump.host, 'jump host', ''),
			username: requiredString(jump.username, 'jump user', 'root'),
			port: port(jump.port),
			password,
		};
	});
	return { board, jumps };
}

/** A separate editor surface: no authentication or board parameters enter Chat history. */
export class BoardManagementUi implements vscode.Disposable {
	private readonly panels = new Map<string, PanelState>();
	private readonly managedCandidates = new Map<string, string>();
	private pollTimer?: ReturnType<typeof setInterval>;
	private polling = false;
	private manualRefreshPending = false;

	constructor(private readonly connection: BoardConnection) {
		this.connection.setPanelOpener(resource => this.open(resource), () => this.refreshAll());
	}

	open(resource: string): void {
		if (!this.panels.has(resource)) {
			this.panels.set(resource, {
				resource, visible: false, started: false,
				providers: this.connection.getProviders().map(provider => ({ ...provider, status: 'pending', authenticated: false, available: [] })),
			});
		}
		void vscode.commands.executeCommand('_workbench.boardPanel.open', resource);
	}

	setVisible(resource: string, visible: boolean): void {
		const state = this.panels.get(resource);
		if (state) { state.visible = visible; this.updatePolling(); }
	}

	close(resource: string): void {
		this.panels.delete(resource);
		this.updatePolling();
	}

	private send(resource: string, message: unknown): void {
		void vscode.commands.executeCommand('_workbench.boardPanel.receive', resource, message);
	}

	private update(state: PanelState): void {
		if (this.panels.get(state.resource) !== state) { return; }
		const known = this.connection.listManagedBoards();
		for (const [key, id] of this.managedCandidates) {
			if (!known.some(board => board.id === id)) { this.managedCandidates.delete(key); }
		}
		const managed = known.map(board => ({
			id: board.id, name: board.name, providerId: board.providerId,
			available: board.available, sessions: board.sessions,
			error: board.error?.message,
		}));
		this.send(state.resource, {
			type: 'state',
			providers: state.providers.map(provider => ({
				...provider,
				available: provider.available.map(board => ({
					...board, reservedManagedId: this.managedCandidates.get(JSON.stringify([provider.id, board.id])),
				})),
			})),
			managed,
			currentBoard: this.connection.getCurrentBoard(state.resource),
			busy: this.connection.isBusy(state.resource),
		});
	}

	refreshAll(): void { for (const state of this.panels.values()) { this.update(state); } }

	private updatePolling(): void {
		if ([...this.panels.values()].some(state => state.started && state.visible)) {
			this.pollTimer ??= setInterval(() => void this.refreshAvailable(), 1000);
			void this.refreshAvailable();
		} else {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private async login(state: PanelState, provider: ProviderStatus, credentials?: { username: string; password: string }): Promise<void> {
		if (provider.status === 'loading') { return; }
		provider.status = 'loading';
		provider.error = undefined;
		this.update(state);
		try {
			await this.connection.login(provider.id, credentials);
			provider.authenticated = true;
			provider.status = 'ready';
		} catch (error) {
			provider.authenticated = false;
			provider.status = 'login';
			provider.available = [];
			provider.error = !credentials && needsLogin(error) ? undefined : String(error);
		}
		this.update(state);
		void this.refreshAvailable();
	}

	private async refreshAvailable(manual = false): Promise<void> {
		if (this.polling) { if (manual) { this.manualRefreshPending = true; } return; }
		const providerIds = new Set([...this.panels.values()]
			.filter(state => state.started && state.visible)
			.flatMap(state => state.providers.filter(provider => provider.authenticated).map(provider => provider.id)));
		if (!providerIds.size) { return; }
		this.polling = true;
		try {
			// One query per provider, shared by all panels; slow requests never overlap.
			await Promise.all([...providerIds].map(async providerId => {
				let available: AvailableBoard[] = [];
				let failure: unknown;
				try { available = await this.connection.listAvailableBoards(providerId); }
				catch (error) { failure = error; }
				for (const state of this.panels.values()) {
					const provider = state.providers.find(provider => provider.id === providerId);
					if (!provider?.authenticated) { continue; }
					provider.available = available;
					provider.error = failure === undefined ? undefined : String(failure);
					if (needsLogin(failure)) {
						provider.authenticated = false;
						provider.status = 'login';
					} else {
						provider.status = failure === undefined ? 'ready' : 'error';
					}
				}
			}));
		} finally {
			this.polling = false;
			this.refreshAll();
			if (this.manualRefreshPending) {
				this.manualRefreshPending = false;
				void this.refreshAvailable();
			}
		}
	}

	async onMessage(resource: string, message: unknown): Promise<void> {
		const state = this.panels.get(resource);
		if (!state || !message || typeof message !== 'object') { return; }
		const input = message as Record<string, unknown>;
		if (input.type === 'ready') {
			this.update(state);
			if (!state.started) {
				state.started = true;
				for (const provider of state.providers) { void this.login(state, provider); }
				this.updatePolling();
			}
			return;
		}
		if (input.type === 'credentials') {
			const provider = state.providers.find(provider => provider.id === input.providerId && !provider.authenticated);
			const { username, password } = input;
			if (provider && typeof username === 'string' && username.trim() && username.length <= 256 && typeof password === 'string' && password.length <= 4096 && password) {
				await this.login(state, provider, { username: username.trim(), password });
			}
			return;
		}
		if (input.type === 'refreshAvailable') {
			if (state.providers.some(provider => provider.id === input.providerId && provider.authenticated)) {
				await this.refreshAvailable(true);
			}
			return;
		}
		try {
			if (this.connection.isBusy(state.resource) && input.type !== 'cancel') { return; }
			switch (input.type) {
				case 'reserve': {
					const provider = state.providers.find(p => p.id === input.providerId && p.status === 'ready');
					if (!provider || typeof input.boardId !== 'string' || !provider.available.some(board => board.id === input.boardId)) { throw new Error('Unknown available board'); }
					const managedId = await this.connection.addProviderBoard(provider.id, { boardId: input.boardId }, state.resource);
					if (managedId) { this.managedCandidates.set(JSON.stringify([provider.id, input.boardId]), managedId); }
					break;
				}
				case 'addStatic': {
					if (!state.providers.some(provider => provider.id === 'static')) { throw new Error('Static provider unavailable'); }
					await this.connection.addProviderBoard('static', staticInput(input.board), state.resource);
					break;
				}
				case 'release': {
					const boardId = input.boardId;
					if (typeof boardId !== 'string' || !this.connection.listManagedBoards().some(board => board.id === boardId)) { throw new Error('Unknown managed board'); }
					await this.connection.removeBoard(boardId, state.resource);
					break;
				}
				case 'connect': {
					const boardId = input.boardId;
					if (typeof boardId !== 'string' || !this.connection.listManagedBoards().some(board => board.id === boardId && board.available)) { throw new Error('Unknown managed board'); }
					await this.connection.selectBoard(boardId, state.resource);
					break;
				}
				case 'cancel': await this.connection.cancel(state.resource); break;
				default: return;
			}
			this.update(state);
		} catch (error) {
			this.send(state.resource, { type: 'error', message: String(error) });
		}
	}

	dispose(): void {
		this.panels.clear();
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}
}
