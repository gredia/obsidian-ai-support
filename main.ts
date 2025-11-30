import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon, ButtonComponent, TextAreaComponent } from 'obsidian';

// ----------------------------------------------------------------
// Settings & Constants
// ----------------------------------------------------------------

interface GeminiPluginSettings {
	apiKey: string;
	modelName: string;
	thinkingLevel: 'low' | 'high';
}

const DEFAULT_SETTINGS: GeminiPluginSettings = {
	apiKey: '',
	modelName: 'gemini-3-pro-preview',
	thinkingLevel: 'high'
}

const VIEW_TYPE_GEMINI_CHAT = 'gemini-chat-view';

// ----------------------------------------------------------------
// Main Plugin Class
// ----------------------------------------------------------------

export default class GeminiPlugin extends Plugin {
	settings: GeminiPluginSettings;
	view: GeminiChatView;

	async onload() {
		await this.loadSettings();

		// Register the Chat View
		this.registerView(
			VIEW_TYPE_GEMINI_CHAT,
			(leaf) => (this.view = new GeminiChatView(leaf, this))
		);

		// Add Ribbon Icon to open Chat
		this.addRibbonIcon('bot', 'Open Gemini Chat', () => {
			this.activateView();
		});

		// Add Command
		this.addCommand({
			id: 'open-gemini-chat',
			name: 'Open Gemini Chat',
			callback: () => {
				this.activateView();
			}
		});

		// Add Settings Tab
		this.addSettingTab(new GeminiSettingTab(this.app, this));
	}

	onunload() {
		// View is automatically detached
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar
			const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
			    await leaf.setViewState({ type: VIEW_TYPE_GEMINI_CHAT, active: true });
            }
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ----------------------------------------------------------------
// Chat View
// ----------------------------------------------------------------

interface ChatMessage {
	role: 'user' | 'model';
	text: string;
	parts?: any[]; // Store raw parts for API history (includes thoughtSignature)
}

class GeminiChatView extends ItemView {
	plugin: GeminiPlugin;
	messagesContainer: HTMLElement;
	inputTextArea: TextAreaComponent;
	history: ChatMessage[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: GeminiPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_GEMINI_CHAT;
	}

	getDisplayText() {
		return 'Gemini Copilot';
	}

	getIcon() {
		return 'bot';
	}

	async onload() {
		super.onload();
		this.addAction('trash', 'Clear Chat', () => {
			this.history = [];
			this.messagesContainer.empty();
			this.addMessage({ role: 'model', text: 'Chat cleared.' });
		});
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gemini-chat-view');

		// 1. Messages Area
		this.messagesContainer = container.createDiv({ cls: 'gemini-chat-messages' });
		
		// Initial Welcome Message
		this.addMessage({ role: 'model', text: 'Hello! I am Gemini. How can I help you with your notes today?' });

		// 2. Input Area
		const inputContainer = container.createDiv({ cls: 'gemini-chat-input-container' });

		this.inputTextArea = new TextAreaComponent(inputContainer);
		this.inputTextArea.inputEl.addClass('gemini-chat-input');
		this.inputTextArea.setPlaceholder('Ask Gemini...');
		
		// Handle Enter key to send
		this.inputTextArea.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.handleSend();
			}
		});

		const sendBtn = new ButtonComponent(inputContainer);
		sendBtn.setIcon('send');
		sendBtn.setClass('gemini-chat-send-btn');
		sendBtn.onClick(() => this.handleSend());
	}

	async handleSend() {
		const text = this.inputTextArea.getValue().trim();
		if (!text) return;

		if (!this.plugin.settings.apiKey) {
			new Notice('Please set your Gemini API Key in settings.');
			return;
		}

		// Clear input
		this.inputTextArea.setValue('');

		// Add User Message
		const userMsg: ChatMessage = { 
			role: 'user', 
			text: text,
			parts: [{ text: text }] 
		};
		this.addMessage(userMsg);
        this.history.push(userMsg);

		// Show Loading
		const loadingEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-loading' });
		loadingEl.setText('Gemini is thinking...');
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		try {
			// Call API
			const responseMsg = await this.callGeminiAPI(this.history);
			
			// Remove Loading
			loadingEl.remove();

			// Add Model Message
			this.addMessage(responseMsg);
            this.history.push(responseMsg);

		} catch (error) {
			console.error('Gemini Error:', error);
			loadingEl.setText(`Error: ${error.message}`);
			new Notice(`Gemini Error: ${error.message}`);
		}
	}

	async addMessage(msg: ChatMessage) {
		const msgEl = this.messagesContainer.createDiv({ cls: `gemini-chat-message ${msg.role}` });
		
		// Render Main Message
		await MarkdownRenderer.render(
			this.app,
			msg.text,
			msgEl,
			'',
			this
		);

		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	async callGeminiAPI(history: ChatMessage[]): Promise<ChatMessage> {
		const { apiKey, modelName, thinkingLevel } = this.plugin.settings;
		// Use v1alpha for preview features like thinking_level
		const url = `https://generativelanguage.googleapis.com/v1alpha/models/${modelName}:generateContent`;

		// Format history for API
		// API expects: { role: "user"|"model", parts: [{ text: "..." }, { thoughtSignature: "..." }] }
		const contents = history.map(msg => ({
			role: msg.role,
			parts: msg.parts || [{ text: msg.text }]
		}));

		const body = {
			contents: contents,
			generationConfig: {
				thinkingConfig: {
					includeThoughts: true,
					thinkingLevel: thinkingLevel
				}
			}
		};

		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey
			},
			body: JSON.stringify(body),
			throw: false
		});

		if (response.status >= 400) {
			console.error('Gemini API Error Body:', response.text);
			throw new Error(`API Error ${response.status}: ${response.text}`);
		}

		const data = response.json;
		
		// Extract parts from response to preserve thoughtSignature
		if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
			const content = data.candidates[0].content;
			
            // Identify parts
            // Thought parts usually have "thought": true (boolean) in the part object in v1alpha
            // Response text is in a part with "text" and NO "thought": true
            
			// Find the main response text part (first part that has text and is NOT a thought)
            // If no such part found, fallback to any text part
			const textPart = content.parts.find((p: any) => p.text && p.thought !== true);
            const thoughtPart = content.parts.find((p: any) => p.thought === true);
            
            let text = "";
            if (textPart) {
                text = textPart.text;
            } else if (thoughtPart && !textPart) {
                 // Only thoughts returned?
                 text = "(Thinking process only, no final response generated)";
            } else {
                text = "(No response text generated)";
            }
			
			return {
				role: 'model',
				text: text,
				parts: content.parts // Store all parts including signatures and thoughts
			};
		} else {
            return {
				role: 'model',
				text: "(No response text generated)",
				parts: [{ text: "(No response text generated)" }]
			};
        }
	}

	async onClose() {
		// cleanup
	}
}

// ----------------------------------------------------------------
// Settings Tab
// ----------------------------------------------------------------

class GeminiSettingTab extends PluginSettingTab {
	plugin: GeminiPlugin;

	constructor(app: App, plugin: GeminiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Gemini Copilot Settings' });

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Enter your Google Gemini API Key')
			.addText(text => text
				.setPlaceholder('AIzaSy...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model Name')
			.setDesc('The Gemini model to use (e.g., gemini-3-pro-preview)')
			.addText(text => text
				.setPlaceholder('gemini-3-pro-preview')
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Thinking Level')
			.setDesc('Controls the depth of reasoning. "High" is default for Gemini 3 Pro.')
			.addDropdown(dropdown => dropdown
				.addOption('high', 'High')
				.addOption('low', 'Low')
				.setValue(this.plugin.settings.thinkingLevel)
				.onChange(async (value) => {
					this.plugin.settings.thinkingLevel = value as 'low' | 'high';
					await this.plugin.saveSettings();
				}));
	}
}
