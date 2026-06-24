import {
	App,
	Editor,
	ItemView,
	MarkdownFileInfo,
	MarkdownView,
	Modal,
	MarkdownRenderer,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const VIEW_TYPE_VAULTPILOT = 'vaultpilot-chat';
const BASE_COPILOT_ARGS = ['-p', '{prompt}', '--allow-all', '--no-color', '--output-format', 'json'];

interface VaultPilotSettings {
	commandMode: 'auto' | 'custom';
	command: string;
	args: string;
	model: string;
	passPromptViaStdin: boolean;
	useShell: boolean;
	useVaultAsCwd: boolean;
	includeActiveNoteByDefault: boolean;
	timeoutSeconds: number;
}

const COPILOT_MODELS = [
	'auto',
	'claude-sonnet-4.6',
	'claude-sonnet-4.5',
	'claude-haiku-4.5',
	'claude-fable-5',
	'claude-opus-4.8',
	'claude-opus-4.7',
	'claude-opus-4.6',
	'claude-opus-4.6-fast',
	'claude-opus-4.5',
	'gpt-5.5',
	'gpt-5.4',
	'gpt-5.3-codex',
	'gpt-5.4-mini',
	'gpt-5-mini',
	'gemini-3.1-pro-preview',
	'gemini-3.5-flash',
] as const;

const DEFAULT_SETTINGS: VaultPilotSettings = {
	commandMode: 'auto',
	command: 'copilot',
	args: BASE_COPILOT_ARGS.join('\n'),
	model: 'auto',
	passPromptViaStdin: false,
	useShell: false,
	useVaultAsCwd: true,
	includeActiveNoteByDefault: true,
	timeoutSeconds: 120,
};

interface CopilotCommandConfig {
	command: string;
	args: string[];
	passPromptViaStdin: boolean;
	useShell: boolean;
}

interface CopilotContext {
	activeFile: TFile | null;
	contextText: string;
	selection: string;
	selectedLineCount: number;
	includesFullNote: boolean;
}

interface CopilotRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	content: string;
	metadata: CopilotRunMetadata;
}

interface CopilotChatMessage {
	role: 'user' | 'assistant';
	text: string;
}

interface ChatMessageElements {
	containerEl: HTMLDivElement;
	contentEl: HTMLDivElement;
}

interface CopilotRunMetadata {
	model?: string;
	outputTokens?: number;
	aiCredits?: number;
	premiumRequests?: number;
	totalApiDurationMs?: number;
	sessionDurationMs?: number;
}

interface CopilotPromptResult {
	response: string;
	metadata: CopilotRunMetadata;
}

export default class VaultPilotPlugin extends Plugin {
	settings!: VaultPilotSettings;
	private lastMarkdownView: MarkdownView | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.captureMarkdownView(this.app.workspace.getActiveViewOfType(MarkdownView));

		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			const view = leaf?.view;
			if (view instanceof MarkdownView) {
				this.captureMarkdownView(view);
			}
		}));

		this.registerView(
			VIEW_TYPE_VAULTPILOT,
			(leaf) => new VaultPilotView(leaf, this),
		);

		this.addRibbonIcon('bot', 'Open VaultPilot', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-vaultpilot-chat',
			name: 'Open Copilot chat',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'ask-about-selection-or-note',
			name: 'Ask Copilot about selection or active note',
			editorCallback: (editor, ctx) => {
				void this.askFromEditor(editor, ctx);
			},
		});

		this.addCommand({
			id: 'insert-response-below-selection',
			name: 'Insert Copilot response below selection',
			editorCallback: (editor, ctx) => {
				new PromptModal(this.app, 'Ask Copilot', async (prompt) => {
					const response = await this.promptWithEditorContext(prompt, editor, ctx);
					editor.replaceSelection(`${editor.getSelection()}\n\n${response}`);
				}).open();
			},
		});

		this.addCommand({
			id: 'replace-selection-with-response',
			name: 'Replace selection with Copilot response',
			editorCallback: (editor, ctx) => {
				new PromptModal(this.app, 'Replace selection with Copilot response', async (prompt) => {
					const response = await this.promptWithEditorContext(prompt, editor, ctx);
					editor.replaceSelection(response);
				}).open();
			},
		});

		this.addSettingTab(new VaultPilotSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_VAULTPILOT);
	}

	async activateView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULTPILOT);
		let leaf: WorkspaceLeaf | undefined = leaves[0];

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
			if (!leaf) {
				new Notice('Unable to open VaultPilot view.');
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_VAULTPILOT, active: true });
		}

		this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<VaultPilotSettings> | null,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async askFromEditor(editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> {
		if (ctx instanceof MarkdownView) {
			this.captureMarkdownView(ctx);
		}
		const context = await this.getEditorContext(editor, ctx);
		const view = await this.getOrCreateView();
		const prompt = context.selection
			? 'Help me with this selected text.'
			: 'Help me with this note.';

		await view.submitPrompt(prompt, context);
	}

	async promptFromView(prompt: string, history: CopilotChatMessage[] = []): Promise<string> {
		const context = await this.getActiveContext();
		return this.promptWithContext(prompt, context, history);
	}

	async streamPromptFromView(
		prompt: string,
		history: CopilotChatMessage[],
		onChunk: (chunk: string) => void,
	): Promise<CopilotPromptResult> {
		const context = await this.getActiveContext();
		return this.streamPromptWithContext(prompt, context, history, onChunk);
	}

	async promptWithContext(
		prompt: string,
		context: CopilotContext,
		history: CopilotChatMessage[] = [],
	): Promise<string> {
		const composedPrompt = this.composePrompt(prompt, context, history);
		const result = await this.runCopilot(composedPrompt, context.activeFile);
		return this.formatResult(result);
	}

	async streamPromptWithContext(
		prompt: string,
		context: CopilotContext,
		history: CopilotChatMessage[],
		onChunk: (chunk: string) => void,
	): Promise<CopilotPromptResult> {
		const composedPrompt = this.composePrompt(prompt, context, history);
		const result = await this.runCopilot(composedPrompt, context.activeFile, onChunk);
		return {
			response: this.formatResult(result),
			metadata: result.metadata,
		};
	}

	async promptWithEditorContext(
		prompt: string,
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	): Promise<string> {
		if (ctx instanceof MarkdownView) {
			this.captureMarkdownView(ctx);
		}
		const context = await this.getEditorContext(editor, ctx);
		new Notice('VaultPilot is thinking...');
		return this.promptWithContext(prompt, context);
	}

	describeCurrentContext(): string {
		const markdownView = this.getCurrentMarkdownView();
		if (!markdownView?.file) {
			return 'Context: no active Markdown file';
		}

		const selection = markdownView.editor.getSelection();
		if (selection) {
			const selectedLineCount = countLines(selection);
			return `Context: ${markdownView.file.path} • ${selectedLineCount} selected ${pluralize('line', selectedLineCount)}`;
		}

		if (this.settings.includeActiveNoteByDefault) {
			return `Context: ${markdownView.file.path} • full note`;
		}

		return `Context: ${markdownView.file.path} • file path only`;
	}

	getContextSourcePath(): string {
		return this.getCurrentMarkdownView()?.file?.path ?? '';
	}

	private async getOrCreateView(): Promise<VaultPilotView> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULTPILOT)[0];
		const view = leaf?.view;

		if (view instanceof VaultPilotView) {
			return view;
		}

		throw new Error('Unable to create VaultPilot view.');
	}

	private async getActiveContext(): Promise<CopilotContext> {
		const markdownView = this.getCurrentMarkdownView();
		if (!markdownView) {
			return {
				activeFile: null,
				contextText: '',
				selection: '',
				selectedLineCount: 0,
				includesFullNote: false,
			};
		}

		return this.getEditorContext(markdownView.editor, markdownView);
	}

	private getCurrentMarkdownView(): MarkdownView | null {
		const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdownView) {
			this.captureMarkdownView(activeMarkdownView);
			return activeMarkdownView;
		}

		if (this.lastMarkdownView?.file) {
			return this.lastMarkdownView;
		}

		return null;
	}

	private captureMarkdownView(view: MarkdownView | null): void {
		if (view?.file) {
			this.lastMarkdownView = view;
		}
	}

	private async getEditorContext(
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	): Promise<CopilotContext> {
		const selection = editor.getSelection();
		const activeFile = ctx.file;
		const includesFullNote = !selection && this.settings.includeActiveNoteByDefault;
		const contextText = selection || (
			includesFullNote ? editor.getValue() : ''
		);

		return {
			activeFile,
			contextText,
			selection,
			selectedLineCount: selection ? countLines(selection) : 0,
			includesFullNote,
		};
	}

	private composePrompt(
		prompt: string,
		context: CopilotContext,
		history: CopilotChatMessage[] = [],
	): string {
		const filePath = context.activeFile?.path ?? 'No active Markdown file';
		const activeFileGuidance = context.activeFile
			? [
				`Active Obsidian file: ${filePath}`,
				context.selection
					? `The user selected ${context.selectedLineCount} ${pluralize('line', context.selectedLineCount)} in this file. Treat the selected text as the primary target unless the user says otherwise.`
					: 'No text is selected. Treat the active file as the target when the user says "this note", "this file", "the current note", or asks for an edit.',
				`If editing a file, prefer editing this exact vault-relative path: ${filePath}`,
			].join('\n')
			: 'There is no active Markdown file in context.';
		const contextBlock = context.contextText
			? `\n\n${context.selection ? 'Selected text' : 'Active note content'} from ${filePath}:\n\n${context.contextText}`
			: '';
		const historyBlock = history.length > 0
			? `Conversation so far:\n\n${history.map((message) => (
				`${message.role === 'user' ? 'User' : 'Copilot'}:\n${message.text}`
			)).join('\n\n')}`
			: '';

		return [
			'You are GitHub Copilot helping inside an Obsidian vault.',
			'Return useful Markdown. Do not include terminal control sequences.',
			activeFileGuidance,
			historyBlock,
			`User request:\n${prompt}`,
			contextBlock,
		].filter(Boolean).join('\n\n');
	}

	private async runCopilot(
		prompt: string,
		activeFile: TFile | null,
		onStdout?: (chunk: string) => void,
	): Promise<CopilotRunResult> {
		const commandConfig = this.resolveCommandConfig(prompt, activeFile);
		if (!commandConfig.command.trim()) {
			throw new Error('Copilot command is not configured.');
		}

		const args = [...commandConfig.args];
		if (this.settings.model && this.settings.model !== 'auto') {
			args.push('--model', this.settings.model);
		}

		const timeoutMs = Math.max(1, this.settings.timeoutSeconds) * 1000;
		const cwd = this.settings.useVaultAsCwd ? this.getVaultPath() : undefined;
		const parseJsonOutput = hasJsonOutputArg(args);

		return new Promise((resolve, reject) => {
			const child = spawn(commandConfig.command, args, {
				cwd,
				shell: commandConfig.useShell,
				windowsHide: true,
			});

			let stdout = '';
			let stderr = '';
			let content = '';
			let jsonLineBuffer = '';
			const metadata: CopilotRunMetadata = {};
			let settled = false;

			const processJsonLine = (line: string) => {
				if (!line.trim()) {
					return;
				}

				let event: CopilotJsonEvent;
				try {
					event = JSON.parse(line) as CopilotJsonEvent;
				} catch {
					return;
				}

				if (event.type === 'assistant.message_delta' && event.data?.deltaContent) {
					content += event.data.deltaContent;
					onStdout?.(event.data.deltaContent);
				}

				if (event.type === 'assistant.message') {
					if (typeof event.data?.content === 'string' && !content) {
						content = event.data.content;
						onStdout?.(event.data.content);
					}
					if (typeof event.data?.model === 'string') {
						metadata.model = event.data.model;
					}
					if (typeof event.data?.outputTokens === 'number') {
						metadata.outputTokens = event.data.outputTokens;
					}
				}

				if (event.type === 'result') {
					if (typeof event.usage?.aiCredits === 'number') {
						metadata.aiCredits = event.usage.aiCredits;
					}
					if (typeof event.usage?.premiumRequests === 'number') {
						metadata.premiumRequests = event.usage.premiumRequests;
					}
					if (typeof event.usage?.totalApiDurationMs === 'number') {
						metadata.totalApiDurationMs = event.usage.totalApiDurationMs;
					}
					if (typeof event.usage?.sessionDurationMs === 'number') {
						metadata.sessionDurationMs = event.usage.sessionDurationMs;
					}
				}
			};

			const timeout = window.setTimeout(() => {
				if (!settled) {
					child.kill();
					settled = true;
					reject(new Error(`Copilot command timed out after ${this.settings.timeoutSeconds} seconds.`));
				}
			}, timeoutMs);

			child.stdout?.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stdout += text;
				if (!parseJsonOutput) {
					content += text;
					onStdout?.(text);
					return;
				}

				jsonLineBuffer += text;
				const lines = jsonLineBuffer.split(/\r?\n/);
				jsonLineBuffer = lines.pop() ?? '';
				for (const line of lines) {
					processJsonLine(line);
				}
			});

			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			child.on('error', (error) => {
				if (settled) {
					return;
				}
				window.clearTimeout(timeout);
				settled = true;
				reject(error);
			});

			child.on('close', (exitCode) => {
				if (settled) {
					return;
				}
				window.clearTimeout(timeout);
				settled = true;
				if (parseJsonOutput && jsonLineBuffer.trim()) {
					processJsonLine(jsonLineBuffer);
				}
				resolve({ stdout, stderr, exitCode, content, metadata });
			});

			if (commandConfig.passPromptViaStdin) {
				child.stdin?.write(prompt);
				child.stdin?.end();
			}
		});
	}

	private resolveCommandConfig(prompt: string, activeFile: TFile | null): CopilotCommandConfig {
		if (this.settings.commandMode === 'custom') {
			return {
				command: this.settings.command,
				args: parseArgs(this.settings.args).map((arg) => (
					applyTemplate(arg, prompt, this.getVaultPath(), activeFile)
				)),
				passPromptViaStdin: this.settings.passPromptViaStdin,
				useShell: this.settings.useShell,
			};
		}

		const args = BASE_COPILOT_ARGS.map((arg) => (
			applyTemplate(arg, prompt, this.getVaultPath(), activeFile)
		));

		if (process.platform === 'win32') {
			const nodePath = getWindowsNodePath();
			const loaderPath = getWindowsCopilotLoaderPath();
			if (nodePath && loaderPath) {
				return {
					command: nodePath,
					args: [loaderPath, ...args],
					passPromptViaStdin: false,
					useShell: false,
				};
			}

			return {
				command: 'copilot.cmd',
				args,
				passPromptViaStdin: false,
				useShell: true,
			};
		}

		return {
			command: 'copilot',
			args,
			passPromptViaStdin: false,
			useShell: false,
		};
	}

	private formatResult(result: CopilotRunResult): string {
		const stdout = result.stdout.trim();
		const stderr = result.stderr.trim();
		const content = result.content.trim();

		if (result.exitCode === 0 && content) {
			return content;
		}

		if (result.exitCode === 0) {
			return stderr || 'Copilot command completed without output.';
		}

		throw new Error([
			`Copilot command failed with exit code ${result.exitCode ?? 'unknown'}.`,
			stderr,
			stdout,
		].filter(Boolean).join('\n\n'));
	}

	private getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		if ('basePath' in adapter && typeof adapter.basePath === 'string') {
			return adapter.basePath;
		}
		return '';
	}
}

interface CopilotJsonEvent {
	type?: string;
	data?: {
		content?: string;
		deltaContent?: string;
		model?: string;
		outputTokens?: number;
	};
	usage?: {
		aiCredits?: number;
		premiumRequests?: number;
		totalApiDurationMs?: number;
		sessionDurationMs?: number;
	};
}

class VaultPilotView extends ItemView {
	private readonly plugin: VaultPilotPlugin;
	private readonly history: CopilotChatMessage[] = [];
	private logEl!: HTMLDivElement;
	private contextEl!: HTMLDivElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButtonEl!: HTMLButtonElement;
	private modelSelectEl!: HTMLSelectElement;
	private contextIntervalId: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultPilotPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_VAULTPILOT;
	}

	getDisplayText(): string {
		return 'VaultPilot';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vaultpilot-view');

		const toolbarEl = contentEl.createDiv({ cls: 'vaultpilot-toolbar' });
		const titleEl = toolbarEl.createDiv({ cls: 'vaultpilot-title-block' });
		titleEl.createEl('strong', { text: 'VaultPilot' });
		titleEl.createDiv({ cls: 'vaultpilot-subtitle', text: 'GitHub Copilot in your vault' });

		this.contextEl = contentEl.createDiv({ cls: 'vaultpilot-context' });
		this.updateContextIndicator();
		this.contextIntervalId = window.setInterval(() => {
			this.updateContextIndicator();
		}, 1000);

		this.logEl = contentEl.createDiv({ cls: 'vaultpilot-log' });
		this.addMessage('assistant', 'Ask Copilot about your active note, selected text, or anything in your vault.', false);

		const inputRowEl = contentEl.createDiv({ cls: 'vaultpilot-input-row' });
		this.inputEl = inputRowEl.createEl('textarea', {
			cls: 'vaultpilot-input',
			attr: {
				placeholder: 'Ask Copilot...',
			},
		});

		const composerControlsEl = inputRowEl.createDiv({ cls: 'vaultpilot-composer-controls' });
		const modelControlEl = composerControlsEl.createDiv({ cls: 'vaultpilot-model-control' });
		modelControlEl.createSpan({ cls: 'vaultpilot-control-label', text: 'Model' });
		this.modelSelectEl = modelControlEl.createEl('select', {
			cls: 'vaultpilot-model-select',
			attr: {
				'aria-label': 'Copilot model',
			},
		});
		for (const model of COPILOT_MODELS) {
			this.modelSelectEl.createEl('option', {
				text: model === 'auto' ? 'Auto' : model,
				value: model,
			});
		}
		this.modelSelectEl.value = this.plugin.settings.model || 'auto';
		this.modelSelectEl.addEventListener('change', () => {
			this.plugin.settings.model = this.modelSelectEl.value;
			void this.plugin.saveSettings();
		});

		this.sendButtonEl = composerControlsEl.createEl('button', {
			cls: 'vaultpilot-send-button',
			text: 'Send',
		});
		this.sendButtonEl.addEventListener('click', () => {
			void this.submitCurrentInput();
		});

		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.submitCurrentInput();
			}
		});
	}

	async onClose(): Promise<void> {
		if (this.contextIntervalId !== null) {
			window.clearInterval(this.contextIntervalId);
			this.contextIntervalId = null;
		}
	}

	async submitPrompt(prompt: string, context?: CopilotContext): Promise<void> {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt) {
			new Notice('Enter a prompt for VaultPilot.');
			return;
		}

		const history = [...this.history];
		this.addMessage('user', trimmedPrompt);
		const assistantMessage = this.addStreamingMessage('assistant', 'Copilot is thinking...');
		let hasStreamedText = false;
		this.setBusy(true);

		try {
			const result = context
				? await this.plugin.streamPromptWithContext(trimmedPrompt, context, history, (chunk) => {
					if (!hasStreamedText) {
						assistantMessage.contentEl.setText('');
						hasStreamedText = true;
					}
					assistantMessage.contentEl.appendText(chunk);
					this.scrollToBottom();
				})
				: await this.plugin.streamPromptFromView(trimmedPrompt, history, (chunk) => {
					if (!hasStreamedText) {
						assistantMessage.contentEl.setText('');
						hasStreamedText = true;
					}
					assistantMessage.contentEl.appendText(chunk);
					this.scrollToBottom();
				});
			const response = result.response;
			await this.renderMarkdownMessage(assistantMessage, response);
			this.addMetadata(assistantMessage.contentEl, result.metadata);
			this.history.push({ role: 'assistant', text: response });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assistantMessage.containerEl.remove();
			this.addMessage('error', message);
			new Notice('VaultPilot failed. See chat for details.');
		} finally {
			this.setBusy(false);
		}
	}

	private async submitCurrentInput(): Promise<void> {
		const prompt = this.inputEl.value;
		this.inputEl.value = '';
		await this.submitPrompt(prompt);
	}

	private updateContextIndicator(): void {
		this.contextEl.setText(this.plugin.describeCurrentContext());
	}

	private addMessage(role: 'user' | 'assistant' | 'error', text: string, record = true): void {
		const cls = role === 'error'
			? 'vaultpilot-message-error'
			: `vaultpilot-message-${role}`;

		const messageEl = this.logEl.createDiv({ cls: `vaultpilot-message ${cls}` });
		const messageTextEl = messageEl.createDiv({ cls: 'vaultpilot-message-text' });
		if (role === 'assistant') {
			void this.renderMarkdownMessage({ containerEl: messageEl, contentEl: messageTextEl }, text);
		} else {
			messageTextEl.setText(text);
		}

		if (record && role !== 'error') {
			this.history.push({ role, text });
		}
		this.scrollToBottom();
	}

	private addStreamingMessage(role: 'assistant', text: string): ChatMessageElements {
		const messageEl = this.logEl.createDiv({
			cls: `vaultpilot-message vaultpilot-message-${role}`,
		});
		const messageTextEl = messageEl.createDiv({ cls: 'vaultpilot-message-text' });
		messageTextEl.setText(text);
		this.scrollToBottom();
		return { containerEl: messageEl, contentEl: messageTextEl };
	}

	private async renderMarkdownMessage(message: ChatMessageElements, markdown: string): Promise<void> {
		message.contentEl.empty();
		const sourcePath = this.plugin.getContextSourcePath();
		await MarkdownRenderer.render(this.app, markdown, message.contentEl, sourcePath, this);
		this.scrollToBottom();
	}

	private addMetadata(messageTextEl: HTMLDivElement, metadata: CopilotRunMetadata): void {
		const items = [
			metadata.model ? `Model: ${metadata.model}` : undefined,
			metadata.outputTokens !== undefined ? `Output tokens: ${metadata.outputTokens}` : undefined,
			metadata.aiCredits !== undefined ? `AI credits: ${metadata.aiCredits}` : undefined,
			metadata.premiumRequests !== undefined ? `Premium requests: ${metadata.premiumRequests}` : undefined,
			metadata.totalApiDurationMs !== undefined ? `API: ${formatMs(metadata.totalApiDurationMs)}` : undefined,
			metadata.sessionDurationMs !== undefined ? `Total: ${formatMs(metadata.sessionDurationMs)}` : undefined,
		].filter((item): item is string => item !== undefined);

		if (items.length === 0) {
			return;
		}

		messageTextEl.parentElement?.createDiv({
			cls: 'vaultpilot-metadata',
			text: items.join(' • '),
		});
	}

	private scrollToBottom(): void {
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	private setBusy(isBusy: boolean): void {
		this.inputEl.disabled = isBusy;
		this.sendButtonEl.disabled = isBusy;
		this.modelSelectEl.disabled = isBusy;
		this.sendButtonEl.setText(isBusy ? 'Thinking...' : 'Send');
	}
}

class PromptModal extends Modal {
	private readonly title: string;
	private readonly onSubmit: (prompt: string) => Promise<void>;
	private inputEl!: HTMLTextAreaElement;

	constructor(app: App, title: string, onSubmit: (prompt: string) => Promise<void>) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.contentEl.empty();
		this.titleEl.setText(this.title);

		this.inputEl = this.contentEl.createEl('textarea', {
			cls: 'vaultpilot-input',
			attr: {
				placeholder: 'What should Copilot do?',
			},
		});

		new Setting(this.contentEl)
			.addButton((button) => {
				button
					.setButtonText('Submit')
					.setCta()
					.onClick(() => {
						void this.submit();
					});
			});

		this.inputEl.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		const prompt = this.inputEl.value.trim();
		if (!prompt) {
			new Notice('Enter a prompt for VaultPilot.');
			return;
		}

		this.close();
		try {
			await this.onSubmit(prompt);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(message);
		}
	}
}

class VaultPilotSettingTab extends PluginSettingTab {
	private readonly plugin: VaultPilotPlugin;

	constructor(app: App, plugin: VaultPilotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'VaultPilot settings' });

		new Setting(containerEl)
			.setName('Command mode')
			.setDesc('Auto uses platform defaults: direct Copilot on macOS/Linux, and a Node loader on Windows when available. Custom uses the command fields below.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('auto', 'Auto platform default')
					.addOption('custom', 'Custom command')
					.setValue(this.plugin.settings.commandMode)
					.onChange(async (value) => {
						this.plugin.settings.commandMode = value === 'custom' ? 'custom' : 'auto';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Copilot command')
			.setDesc('Custom mode only. Executable to run. Use an absolute path if Obsidian cannot find it on PATH.')
			.addText((text) => {
				text
					.setPlaceholder('copilot')
					.setValue(this.plugin.settings.command)
					.onChange(async (value) => {
						this.plugin.settings.command = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Arguments')
			.setDesc('Custom mode only. One argument per line. Supports {prompt}, {vault}, and {file}. Use --output-format json to show model and usage metadata.')
			.addTextArea((text) => {
				text
					.setPlaceholder('ask\n{prompt}')
					.setValue(this.plugin.settings.args)
					.onChange(async (value) => {
						this.plugin.settings.args = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
			});

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model to pass with --model. Auto lets Copilot choose.')
			.addDropdown((dropdown) => {
				for (const model of COPILOT_MODELS) {
					dropdown.addOption(model, model === 'auto' ? 'Auto model' : model);
				}
				dropdown
					.setValue(this.plugin.settings.model || 'auto')
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Pass prompt through stdin')
			.setDesc('Custom mode only. Recommended when your Copilot CLI accepts stdin. Disable this if your CLI needs {prompt} in the arguments.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.passPromptViaStdin)
					.onChange(async (value) => {
						this.plugin.settings.passPromptViaStdin = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Use shell')
			.setDesc('Custom mode only. Useful for shell aliases and shims. Disable for stricter executable launching.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useShell)
					.onChange(async (value) => {
						this.plugin.settings.useShell = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Run from vault folder')
			.setDesc('Use the vault path as the command working directory.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useVaultAsCwd)
					.onChange(async (value) => {
						this.plugin.settings.useVaultAsCwd = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Include active note by default')
			.setDesc('When there is no selection, include the full active note as context.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeActiveNoteByDefault)
					.onChange(async (value) => {
						this.plugin.settings.includeActiveNoteByDefault = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Timeout')
			.setDesc('Maximum number of seconds to wait for the Copilot command.')
			.addText((text) => {
				text
					.setPlaceholder('120')
					.setValue(String(this.plugin.settings.timeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.timeoutSeconds = parsed;
							await this.plugin.saveSettings();
						}
					});
			});
	}
}

function parseArgs(args: string): string[] {
	return args
		.split('\n')
		.map((arg) => arg.trim())
		.filter(Boolean);
}

function applyTemplate(arg: string, prompt: string, vaultPath: string, activeFile: TFile | null): string {
	return arg
		.replaceAll('{prompt}', prompt)
		.replaceAll('{vault}', vaultPath)
		.replaceAll('{file}', activeFile?.path ?? '');
}

function hasJsonOutputArg(args: string[]): boolean {
	return args.some((arg, index) => (
		arg === '--output-format=json'
		|| (arg === '--output-format' && args[index + 1] === 'json')
	));
}

function formatMs(ms: number): string {
	if (ms < 1000) {
		return `${Math.round(ms)} ms`;
	}
	return `${(ms / 1000).toFixed(1)} s`;
}

function getWindowsNodePath(): string | null {
	const candidates = [
		`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\nodejs\\node.exe`,
		'node.exe',
	];

	return candidates.find((candidate) => candidate === 'node.exe' || existsSync(candidate)) ?? null;
}

function getWindowsCopilotLoaderPath(): string | null {
	const candidates = [
		process.env.VAULTPILOT_LOADER,
		process.env.APPDATA ? `${process.env.APPDATA}\\npm\\node_modules\\@github\\copilot\\npm-loader.js` : undefined,
		'C:\\ProgramData\\global-npm\\node_modules\\@github\\copilot\\npm-loader.js',
	];

	return candidates.find((candidate) => candidate !== undefined && existsSync(candidate)) ?? null;
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split(/\r\n|\r|\n/).length;
}

function pluralize(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}
