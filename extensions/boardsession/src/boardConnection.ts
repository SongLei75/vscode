/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BoardSession, type OpenOptions } from '@carizon/board-session';

/** Owns mode selection and the single reusable session; protocol handling stays in the npm package. */
export class BoardConnection implements vscode.Disposable {
	private session: BoardSession | undefined;
	private selected = false;
	private connecting: Promise<void> | undefined;
	private generation = 0;
	private disposed = false;
	private readonly monitor: ReturnType<typeof setInterval>;

	constructor() {
		// The core's public API exposes isClosed, with no close event.
		this.monitor = setInterval(() => {
			if (this.session?.isClosed) {
				this.session = undefined;
				void this.publishState();
				if (this.selected) {
					void vscode.window.showWarningMessage(vscode.l10n.t("Board disconnected. Deactivate board mode with the connection button to use local tools, then activate it again to reconnect."));
				}
			}
		}, 250);
		this.monitor.unref();
	}

	get active(): boolean {
		return this.selected && !!this.session && !this.session.isClosed;
	}

	get current(): BoardSession {
		if (!this.active) {
			throw new Error(vscode.l10n.t("Board terminal is unavailable. Reconnect with the connection button; no command was sent locally."));
		}
		return this.session!;
	}

	async initialize(): Promise<void> {
		await this.publishState();
	}

	private async publishState(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'boardsession.active', this.selected);
		await vscode.commands.executeCommand('setContext', 'boardsession.connected', !!this.session && !this.session.isClosed);
		await vscode.commands.executeCommand('setContext', 'boardsession.connecting', !!this.connecting);
	}

	async toggle(sessionResource?: string): Promise<void> {
		if (this.disposed || this.connecting) {
			return;
		}
		if (this.selected) {
			await this.deactivate();
			return;
		}
		if (this.session && !this.session.isClosed) {
			this.selected = true;
			await this.publishState();
			return;
		}
		const generation = ++this.generation;
		this.connecting = this.connect(generation, sessionResource);
		await this.publishState();
		try {
			await this.connecting;
		} finally {
			this.connecting = undefined;
			await this.publishState();
		}
	}

	async deactivate(): Promise<void> {
		await this.cancel();
		this.selected = false;
		await this.publishState();
	}

	private async connect(generation: number, sessionResource?: string): Promise<void> {
		const cancelled = () => this.disposed || generation !== this.generation;
		try {
			const ask = async (title: string, placeholder: string, password = false): Promise<string> => {
				if (cancelled()) { throw new vscode.CancellationError(); }
				const value = await vscode.commands.executeCommand<string | undefined>('_workbench.chat.showInput', {
					id: 'boardsession', title, placeholder, password, sessionResource,
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
			const host = await ask(vscode.l10n.t("Board · IP / Host"), '192.168.2.62');
			const username = await ask(vscode.l10n.t("Board · User"), 'root');
			const port = await askPort(vscode.l10n.t("Board · Port"));
			const identityPath = await ask(vscode.l10n.t("Board · X.509 PEM File"), vscode.l10n.t("Bundled internal debug identity (default)"));
			const jumps: NonNullable<OpenOptions['jumps']> = [];
			for (let index = 1; ; index++) {
				const host = await ask(vscode.l10n.t("Jump {0} · IP / Host", index), vscode.l10n.t("Leave empty to finish and connect"));
				if (!host) { break; }
				const username = await ask(vscode.l10n.t("Jump {0} · User", index), 'root');
				const port = await askPort(vscode.l10n.t("Jump {0} · Port", index));
				const password = await ask(vscode.l10n.t("Jump {0} · Password", index), vscode.l10n.t("Leave empty to use the default password"), true);
				jumps.push({ host, username: username || 'root', port, password: password || '123456' });
			}
			const defaultIdentity = fileURLToPath(new URL('../prebuilds/client-identity.pem', import.meta.resolve('@carizon/board-session')));
			const identity = await readFile(identityPath || defaultIdentity);
			try {
				if (cancelled()) { throw new vscode.CancellationError(); }
				await BoardSession.setIdentity(identity);
			} finally {
				identity.fill(0);
			}
			if (cancelled()) { throw new vscode.CancellationError(); }
			const candidate = await BoardSession.open({ board: { host: host || '192.168.2.62', username: username || 'root', port }, jumps });
			if (cancelled() || candidate.isClosed) {
				await candidate.close();
				if (!cancelled()) { throw new Error(vscode.l10n.t("Board closed during connection.")); }
				return;
			}
			this.session = candidate;
			this.selected = true;
			await this.publishState();
		} catch (error) {
			if (!(error instanceof vscode.CancellationError) && !cancelled()) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Board connection failed: {0}", String(error)));
			}
		} finally {
			await vscode.commands.executeCommand('_workbench.chat.closeInput', 'boardsession');
		}
	}

	/** Cancellation closes the owned session, the cancellation operation supported by the core API. */
	async invoke<T>(operation: (session: BoardSession) => T | Promise<T>, token: vscode.CancellationToken): Promise<T> {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const session = this.current;
		const listener = token.onCancellationRequested(() => { void session.close(); });
		try {
			const result = await operation(session);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			return result;
		} finally {
			listener.dispose();
			if (session.isClosed) { await this.publishState(); }
		}
	}

	async cancel(): Promise<void> {
		++this.generation;
		// Cancellation may race with adoption of a connection that has just finished opening.
		if (this.connecting && this.session) {
			const session = this.session;
			this.session = undefined;
			this.selected = false;
			await session.close();
			await this.publishState();
		}
		await vscode.commands.executeCommand('_workbench.chat.closeInput', 'boardsession');
	}

	/** Explicit user disconnection restores local tools; tool-initiated close remains fail closed. */
	async disconnect(restoreLocal = true): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (restoreLocal) { this.selected = false; }
		try {
			await this.cancel();
			await this.publishState();
		} finally {
			// Closing the native session must not depend on the workbench command bridge during shutdown.
			await session?.close();
		}
	}

	dispose(): void {
		this.disposed = true;
		++this.generation;
		clearInterval(this.monitor);
		void this.disconnect().catch(error => console.error('BoardSession shutdown failed', error));
	}
}
