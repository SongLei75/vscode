/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface BoardInfo {
	id: string;
	name: string;
	providerId: string;
	available?: boolean;
	sessions?: number;
	error?: string;
	reservedManagedId?: string;
}

interface ProviderInfo {
	id: string;
	displayName: string;
	status: string;
	authenticated: boolean;
	error?: string;
	available: BoardInfo[];
}

export interface BoardPanelState {
	type: 'state';
	providers: ProviderInfo[];
	managed: BoardInfo[];
	busy: boolean;
	currentBoard?: string;
}

export type BoardPanelMessage = BoardPanelState | { type: 'error'; message: string };

type ProviderView = {
	boards: HTMLElement;
	snapshot?: string;
	submit?: HTMLButtonElement;
	refresh?: HTMLButtonElement;
	login?: HTMLElement;
	loginButton?: HTMLButtonElement;
	error?: HTMLElement;
};

/** Browser-side DOM only. All authentication, board management and SSH remain in the extension host. */
export class BoardPanelView {
	readonly element: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly providers: HTMLElement;
	private readonly manual: HTMLElement;
	private readonly cancel: HTMLButtonElement;
	private readonly sections = new Map<string, ProviderView>();
	private state: BoardPanelState = { type: 'state', providers: [], managed: [], busy: false };

	constructor(private readonly send: (message: Record<string, unknown>) => void) {
		this.element = this.el('div', 'carizon-board-panel');
		const content = this.el('div', 'content');
		const controls = this.el('div', 'controls');
		this.cancel = this.button('取消连接', () => this.send({ type: 'cancel' }), 'secondary');
		this.cancel.hidden = true;
		controls.append(this.cancel);
		this.notice = this.el('div', 'notice');
		this.notice.setAttribute('role', 'status');
		this.notice.setAttribute('aria-live', 'polite');
		this.providers = this.el('div');
		this.manual = this.el('div');
		content.append(controls, this.notice, this.providers, this.manual);
		this.element.append(content);
	}

	accept(message: BoardPanelMessage): void {
		if (message.type === 'error') {
			this.notice.textContent = message.message;
		} else if (message.type === 'state') {
			this.state = message;
			this.render();
		}
	}

	private el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
		const element = document.createElement(tag);
		if (className) { element.className = className; }
		if (text !== undefined) { element.textContent = text; }
		return element;
	}

	private button(text: string, action: (event: MouseEvent) => void, cls = 'secondary', disabled = false): HTMLButtonElement {
		const node = this.el('button', cls, text);
		node.type = 'button';
		node.disabled = disabled;
		node.addEventListener('click', action);
		return node;
	}

	private field(title: string, value: string | number, type = 'text') {
		const label = this.el('label');
		label.append(this.el('span', '', title));
		const input = this.el('input');
		input.type = type;
		input.value = String(value);
		label.append(input);
		return { label, input };
	}

	private renderStatic(section: HTMLElement): HTMLButtonElement {
		const details = this.el('details');
		details.append(this.el('summary', '', '添加开发板'));
		const form = this.el('form');
		form.autocomplete = 'off';
		const base = this.el('div', 'fields');
		const host = this.field('板端 Host', '192.168.2.62');
		const user = this.field('User', 'root');
		const port = this.field('Port', 22, 'number');
		base.append(host.label, user.label, port.label);
		form.append(base);
		const jumps = this.el('details');
		jumps.append(this.el('summary', '', 'JumpServer（可选）'));
		const rows = this.el('div');
		jumps.append(rows);
		const jumpFields: { wrap: HTMLElement; host: HTMLInputElement; user: HTMLInputElement; port: HTMLInputElement; password: HTMLInputElement }[] = [];
		const addJump = () => {
			const wrap = this.el('div', 'jump');
			const fields = this.el('div', 'fields');
			const jumpHost = this.field('跳板 Host', '');
			const jumpUser = this.field('User', 'root');
			const jumpPort = this.field('Port', 22, 'number');
			const password = this.field('Password', '123456', 'password');
			fields.append(jumpHost.label, jumpUser.label, jumpPort.label);
			wrap.append(fields, password.label);
			wrap.append(this.button('移除', () => {
				wrap.remove();
				const index = jumpFields.findIndex(row => row.wrap === wrap);
				if (index !== -1) { jumpFields.splice(index, 1); }
			}));
			jumpFields.push({ wrap, host: jumpHost.input, user: jumpUser.input, port: jumpPort.input, password: password.input });
			rows.append(wrap);
		};
		jumps.append(this.button('添加', addJump));
		form.append(jumps);
		const submit = this.button('添加并连接', () => this.send({
			type: 'addStatic',
			board: {
				host: host.input.value, username: user.input.value, port: port.input.value,
				jumps: jumpFields.map(row => ({ host: row.host.value, username: row.user.value, port: row.port.value, password: row.password.value })),
			},
		}), '', this.state.busy);
		form.append(submit);
		form.addEventListener('submit', event => event.preventDefault());
		details.append(form);
		section.append(details);
		return submit;
	}

	private renderLogin(section: HTMLElement, provider: ProviderInfo): HTMLButtonElement {
		const form = this.el('form');
		form.autocomplete = 'off';
		const user = this.field('Username', '');
		const password = this.field('Password', '', 'password');
		user.input.maxLength = 256;
		password.input.maxLength = 4096;
		form.append(user.label, password.label);
		const controls = this.el('div', 'controls');
		const submit = this.button('登录并继续', () => {
			if (!user.input.value.trim() || !password.input.value) {
				this.notice.textContent = '用户名和密码不能为空';
				return;
			}
			this.send({ type: 'credentials', providerId: provider.id, username: user.input.value, password: password.input.value });
			password.input.value = '';
			submit.disabled = true;
		}, '');
		controls.append(submit);
		form.append(controls);
		form.addEventListener('submit', event => event.preventDefault());
		section.append(form);
		return submit;
	}

	private renderBoard(parent: HTMLElement, board: BoardInfo, managed: boolean): void {
		const row = this.el('div', 'board' + (board.id === this.state.currentBoard ? ' active' : ''));
		const info = this.el('div', 'info');
		info.append(this.button(board.name, () => managed
			? this.send({ type: 'connect', boardId: board.id })
			: this.send({ type: 'reserve', providerId: board.providerId, boardId: board.id }),
		'board-name', this.state.busy || (managed && !board.available)));
		const hint = managed
			? (board.id === this.state.currentBoard ? '✓ 当前 Chat 已连接 · ' : board.available ? '已添加 · ' : '不可连接 · ') + (board.sessions + ' 个 SSH 会话')
			: '可预约';
		info.append(this.el('small', '', hint));
		if (board.error) { info.append(this.el('span', 'error', board.error)); }
		row.append(info);
		const actions = this.el('div', 'board-actions');
		if (managed) {
			if (board.available && board.id !== this.state.currentBoard) {
				actions.append(this.button('连接', () => this.send({ type: 'connect', boardId: board.id }), 'secondary', this.state.busy));
			}
			actions.append(this.button(board.providerId === 'static' ? '删除' : '释放', () => this.send({ type: 'release', boardId: board.id }), 'secondary', this.state.busy));
		} else {
			actions.append(this.button('预约并连接', () => this.send({ type: 'reserve', providerId: board.providerId, boardId: board.id }), '', this.state.busy));
		}
		row.append(actions);
		parent.append(row);
	}

	private renderBoards(view: ProviderView, provider: ProviderInfo): void {
		const managed = this.state.managed.filter(board => board.providerId === provider.id);
		const snapshot = JSON.stringify([provider.authenticated, provider.status, this.state.busy, this.state.currentBoard, managed, provider.available]);
		if (view.snapshot === snapshot) { return; }
		view.snapshot = snapshot;
		const section = view.boards;
		section.replaceChildren();
		if (!provider.authenticated) { return; }
		if (managed.length) {
			section.append(this.el('h3', '', provider.id === 'static' ? '已添加开发板' : '已预约'));
			for (const board of managed) { this.renderBoard(section, board, true); }
		}
		if (provider.available.length) {
			section.append(this.el('h3', '', '可预约开发板'));
			for (const board of provider.available) {
				if (board.reservedManagedId && managed.some(item => item.id === board.reservedManagedId)) { continue; }
				this.renderBoard(section, { ...board, providerId: provider.id }, false);
			}
		}
		if (provider.id !== 'static' && provider.status === 'ready' && !provider.available.length && !managed.length) {
			section.append(this.el('p', 'muted', '暂无可预约板卡'));
		}
	}

	private render(): void {
		this.cancel.hidden = !this.state.busy;
		for (const provider of this.state.providers) {
			let view = this.sections.get(provider.id);
			if (!view) {
				const boards = this.el('div');
				if (provider.id === 'static') {
					this.manual.append(boards);
					view = { boards, submit: this.renderStatic(this.manual) };
				} else {
					const section = this.el('section');
					const heading = this.el('div', 'heading');
					const refresh = this.button('↻', () => this.send({ type: 'refreshAvailable', providerId: provider.id }), 'secondary refresh');
					refresh.title = '刷新可预约开发板';
					refresh.setAttribute('aria-label', refresh.title);
					const login = this.el('div');
					const error = this.el('p', 'error');
					heading.append(this.el('h2', '', provider.displayName), refresh);
					section.append(heading, login, error, boards);
					this.providers.append(section);
					view = { boards, refresh, login, error };
				}
				this.sections.set(provider.id, view);
			}
			if (provider.id === 'static') {
					if (view.submit) { view.submit.disabled = this.state.busy; }
			} else if (view.refresh && view.login && view.error) {
				view.refresh.disabled = !provider.authenticated;
				if (!provider.authenticated && provider.status !== 'pending') {
					if (!view.login.firstChild) { view.loginButton = this.renderLogin(view.login, provider); }
					if (view.loginButton) { view.loginButton.disabled = provider.status === 'loading'; }
				} else {
					view.login.replaceChildren();
				}
				view.error.textContent = provider.error || '';
				view.error.hidden = !provider.error;
			}
			this.renderBoards(view, provider);
		}
	}
}
