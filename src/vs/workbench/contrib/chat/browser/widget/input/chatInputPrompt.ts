/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatWidget, IChatWidgetService } from '../../chat.js';
import './media/chatInputPrompt.css';

interface IChatInputPromptOptions {
	id: string;
	title: string;
	placeholder?: string;
	password?: boolean;
	choices?: readonly { id: string; label: string }[];
	sessionResource?: string;
}

interface IInputFlow {
	widget: IChatWidget;
	store: DisposableStore;
	prompt: DisposableStore;
}

// Internal command bridge for extension-owned workflows. Values never enter the chat model or history.
const flows = new Map<string, IInputFlow>();
function closeInput(id: string): void {
	const flow = flows.get(id);
	flows.delete(id);
	flow?.store.dispose();
	if (flow?.widget.visible) { flow.widget.focusInput(); }
}

CommandsRegistry.registerCommand('_workbench.chat.closeInput', (_accessor, id: string) => closeInput(id));
CommandsRegistry.registerCommand('_workbench.chat.showInput', (accessor, options: IChatInputPromptOptions) => showPrompt(accessor, { ...options, choices: undefined }));
CommandsRegistry.registerCommand('_workbench.chat.showPick', (accessor, options: IChatInputPromptOptions) => {
	if (!Array.isArray(options?.choices) || !options.choices.length || options.choices.some(choice =>
		typeof choice?.id !== 'string' || typeof choice?.label !== 'string') ||
		new Set(options.choices.map(choice => choice.id)).size !== options.choices.length) {
		throw new Error('Invalid chat choices');
	}
	return showPrompt(accessor, options);
});

function showPrompt(accessor: ServicesAccessor, options: IChatInputPromptOptions): Promise<string | undefined> {
	if (!options || typeof options.id !== 'string' || typeof options.title !== 'string') {
		throw new Error('Invalid chat input prompt options');
	}
	const widgetService = accessor.get(IChatWidgetService);
	const contextViewService = accessor.get(IContextViewService);
	let flow = flows.get(options.id);
	if (!flow) {
		const widget = options.sessionResource ? widgetService.getWidgetBySessionResource(URI.parse(options.sessionResource)) : widgetService.lastFocusedWidget;
		if (!widget?.visible) {
			throw new Error(localize('chatInputPrompt.noWidget', "Open Chat before starting this action."));
		}
		const store = new DisposableStore();
		const prompt = store.add(new DisposableStore());
		flow = { widget, store, prompt };
		flows.set(options.id, flow);
		store.add(widget.onDidHide(() => closeInput(options.id)));
		store.add(widget.onDidChangeViewModel(() => closeInput(options.id)));
	}
	const { widget, prompt } = flow;
	prompt.clear();
	return new Promise<string | undefined>(resolve => {
		const form = dom.$('form.chat-input-prompt');
		form.setAttribute('aria-label', options.title);
		const label = dom.append(form, dom.$('label.chat-input-prompt-title'));
		label.textContent = options.title;
		const submit = (value: string) => {
			resolve(value);
			prompt.clear();
		};
		let input: InputBox | undefined;
		let firstChoice: Button | undefined;
		if (options.choices) {
			const choices = dom.append(form, dom.$('.chat-input-prompt-choices'));
			for (const choice of options.choices) {
				const button = prompt.add(new Button(choices, { ...defaultButtonStyles, secondary: true }));
				button.label = choice.label;
				prompt.add(button.onDidClick(() => submit(choice.id)));
				firstChoice ??= button;
			}
		} else {
			input = prompt.add(new InputBox(form, contextViewService, {
				ariaLabel: options.title,
				placeholder: options.placeholder,
				type: options.password ? 'password' : 'text',
				inputBoxStyles: defaultInputBoxStyles,
			}));
			input.inputElement.id = `chat-input-prompt-${options.id}`;
			label.setAttribute('for', input.inputElement.id);
			input.inputElement.autocomplete = 'off';
			const hint = dom.append(form, dom.$('.chat-input-prompt-hint'));
			hint.textContent = localize('chatInputPrompt.private', "These fields are used by the extension and are not sent to the chat model. Leave empty to use the displayed default.");
		}
		const buttons = dom.append(form, dom.$('.chat-input-prompt-buttons'));
		if (input) {
			const next = prompt.add(new Button(buttons, defaultButtonStyles));
			next.label = localize('chatInputPrompt.next', "Next");
			prompt.add(next.onDidClick(() => submit(input!.value)));
		}
		const cancel = prompt.add(new Button(buttons, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('chatInputPrompt.cancel', "Cancel");
		prompt.add(cancel.onDidClick(() => closeInput(options.id)));
		prompt.add(dom.addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			if (input) { submit(input.value); }
		}));
		prompt.add(dom.addDisposableListener(form, 'keydown', event => {
			event.stopPropagation();
			if (event.key === 'Escape') {
				event.preventDefault();
				closeInput(options.id);
			}
		}));
		prompt.add(toDisposable(() => {
			if (input) { input.value = ''; }
			form.remove();
			resolve(undefined);
		}));
		// ChatInputPart observes its intrinsic height and relayouts the transcript automatically.
		widget.inputPart.element.prepend(form);
		if (input) { input.focus(); } else { firstChoice?.focus(); }
	});
}
