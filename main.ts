import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon, ButtonComponent, TextAreaComponent, TFile, setTooltip } from 'obsidian';
import { NoteService } from './note-service';
import { ChatHistoryService, ChatMessage as HistoryChatMessage } from './chat-history-service';
import { ChatHistoryModal } from './chat-history-modal';
import { FileSuggestModal } from './file-suggest-modal';
import { GeminiFileManager } from './gemini-file-manager';

// ----------------------------------------------------------------
// Settings & Constants
// ----------------------------------------------------------------

interface GeminiPluginSettings {
	apiKey: string;
	modelName: string;
	thinkingLevel: 'low' | 'high';
	chatHistoryFolder: string;
}

const DEFAULT_SETTINGS: GeminiPluginSettings = {
	apiKey: '',
	modelName: 'gemini-3-pro-preview',
	thinkingLevel: 'high',
	chatHistoryFolder: 'Gemini Chats'
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

        // Add History Command
        this.addCommand({
            id: 'open-gemini-chat-history',
            name: 'View Chat History',
            callback: async () => {
                const historyService = new ChatHistoryService(this.app);
                const files = await historyService.getChatFiles(this.settings.chatHistoryFolder);
                new ChatHistoryModal(this.app, files, async (item) => {
                    await this.activateView();
                    if (this.view) {
                        if (item.type === 'new') {
                            await this.view.startNewChat();
                        } else {
                            await this.view.loadChat(item.file);
                        }
                    }
                }).open();
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

interface GeminiChatMessage {
	role: 'user' | 'model';
	content: string; // Renamed from 'text' to 'content' to match HistoryChatMessage
	parts?: any[];
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
}

class GeminiChatView extends ItemView {
	plugin: GeminiPlugin;
	messagesContainer: HTMLElement;
	inputTextArea: TextAreaComponent;
    headerContainer: HTMLElement;
    contextChipsContainer: HTMLElement;
    activeContextBtn: HTMLElement;
    
	history: GeminiChatMessage[] = [];
    noteService: NoteService;
    chatHistoryService: ChatHistoryService;
    fileManager: GeminiFileManager;
    currentChatFile: string | null = null;
    
    // Context State
    contextFiles: TFile[] = [];
    isActiveContextEnabled: boolean = false;

	constructor(leaf: WorkspaceLeaf, plugin: GeminiPlugin) {
		super(leaf);
		this.plugin = plugin;
        this.noteService = new NoteService(plugin.app);
        this.chatHistoryService = new ChatHistoryService(plugin.app);
        this.fileManager = new GeminiFileManager(plugin.app);
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
		this.addAction('plus-circle', 'Start New Chat', () => {
            this.startNewChat();
		});
        
        this.addAction('history', 'Chat History', async () => {
             this.showHistoryModal();
        });
        
        this.addAction('home', 'Home', () => {
            this.renderWelcomeScreen();
        });
	}

	async onOpen() {
        await this.renderWelcomeScreen();
	}

    async showHistoryModal() {
        const files = await this.chatHistoryService.getChatFiles(this.plugin.settings.chatHistoryFolder);
        new ChatHistoryModal(this.app, files, (item) => {
            if (item.type === 'new') {
                this.startNewChat();
            } else {
                this.loadChat(item.file);
            }
        }).open();
    }

    async renderWelcomeScreen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('gemini-chat-view');

        const contentContainer = container.createDiv({ cls: 'gemini-chat-welcome' });
        contentContainer.createEl('h2', { text: 'Gemini Copilot' });

        new ButtonComponent(contentContainer)
            .setButtonText('Start New Chat')
            .setCta()
            .onClick(() => {
                this.startNewChat();
            });

        contentContainer.createEl('h3', { text: 'Recent Chats' });
        const historyList = contentContainer.createDiv({ cls: 'gemini-chat-history-list' });

        const files = await this.chatHistoryService.getChatFiles(this.plugin.settings.chatHistoryFolder);
        
        if (files.length === 0) {
            historyList.createEl('div', { text: 'No recent chats found.', cls: 'gemini-history-empty' });
        } else {
            const limit = 10;
            for (const file of files.slice(0, limit)) {
                const item = historyList.createDiv({ cls: 'gemini-history-item' });
                item.createDiv({ text: file.basename, cls: 'gemini-history-item-title' });
                const date = new Date(file.stat.mtime).toLocaleDateString();
                item.createDiv({ text: date, cls: 'gemini-history-item-date' });
                
                item.onClickEvent(() => {
                    this.loadChat(file);
                });
            }
        }
    }

    initializeChatUI(container: Element) {
        container.empty();
        container.addClass('gemini-chat-view');

        // 0. Header Bar
        this.headerContainer = container.createDiv({ cls: 'gemini-chat-header' });
        
        // Back/Home Button
        const backBtn = this.headerContainer.createDiv({ cls: 'gemini-header-btn', attr: { title: 'Back to Home' } });
        setIcon(backBtn, 'home');
        backBtn.onClickEvent(() => this.renderWelcomeScreen());

        // Title (Clickable for History)
        const titleEl = this.headerContainer.createDiv({ cls: 'gemini-chat-title', text: 'New Chat' });
        titleEl.setAttribute('title', 'Click to switch chat');
        titleEl.onClickEvent(() => this.showHistoryModal());

        // New Chat Button
        const newBtn = this.headerContainer.createDiv({ cls: 'gemini-header-btn', attr: { title: 'New Chat' } });
        setIcon(newBtn, 'plus-circle');
        newBtn.onClickEvent(() => this.startNewChat());

        // 1. Messages Area
        this.messagesContainer = container.createDiv({ cls: 'gemini-chat-messages' });

        // 2. Footer Area (Context + Input)
        const footer = container.createDiv({ cls: 'gemini-chat-footer' });

        // Context Chips
        this.contextChipsContainer = footer.createDiv({ cls: 'gemini-context-chips' });
        this.renderContextChips(); // Initial render

        // Input Row
        const inputRow = footer.createDiv({ cls: 'gemini-chat-input-container' });

        // Input Toolbar (Left of input)
        const toolbar = inputRow.createDiv({ cls: 'gemini-input-toolbar' });
        
        // Add File Button
        const addFileBtn = toolbar.createDiv({ cls: 'gemini-toolbar-btn', attr: { title: 'Add note to context' } });
        setIcon(addFileBtn, 'file-plus');
        addFileBtn.onClickEvent(() => {
            new FileSuggestModal(this.app, (file) => {
                this.addContextFile(file);
            }).open();
        });

        // Active Context Toggle
        this.activeContextBtn = toolbar.createDiv({ cls: 'gemini-toolbar-btn', attr: { title: 'Toggle active file context' } });
        setIcon(this.activeContextBtn, 'eye');
        this.activeContextBtn.onClickEvent(() => {
            this.isActiveContextEnabled = !this.isActiveContextEnabled;
            this.renderContextChips();
        });

        this.inputTextArea = new TextAreaComponent(inputRow);
        this.inputTextArea.inputEl.addClass('gemini-chat-input');
        this.inputTextArea.setPlaceholder('Ask Gemini...');
        
        // Handle Enter key to send
        this.inputTextArea.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        const sendBtn = new ButtonComponent(inputRow);
        sendBtn.setIcon('send');
        sendBtn.setClass('gemini-chat-send-btn');
        sendBtn.onClick(() => this.handleSend());
        
        return titleEl; 
    }

    addContextFile(file: TFile) {
        if (!this.contextFiles.includes(file)) {
            this.contextFiles.push(file);
            this.renderContextChips();
        }
    }

    removeContextFile(file: TFile) {
        this.contextFiles = this.contextFiles.filter(f => f !== file);
        this.renderContextChips();
    }

    renderContextChips() {
        if (!this.contextChipsContainer) return;
        this.contextChipsContainer.empty();

        // Update active context button state
        if (this.activeContextBtn) {
            if (this.isActiveContextEnabled) {
                this.activeContextBtn.addClass('is-active');
            } else {
                this.activeContextBtn.removeClass('is-active');
            }
        }

        // Render Active File Chip if enabled
        if (this.isActiveContextEnabled) {
            const activeChip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip is-active-file' });
            activeChip.createSpan({ text: 'Active Note' });
            // No remove button for active context (toggled via eye button)
        }

        // Render Selected Files
        for (const file of this.contextFiles) {
            const chip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip' });
            chip.createSpan({ text: file.basename });
            const removeBtn = chip.createDiv({ cls: 'gemini-context-chip-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.onClickEvent(() => this.removeContextFile(file));
        }
    }

    async startNewChat() {
        const container = this.containerEl.children[1];
        const titleEl = this.initializeChatUI(container);
        if (titleEl) titleEl.setText('New Chat');

        this.currentChatFile = null;
        this.history = [];
        this.contextFiles = [];
        this.isActiveContextEnabled = false;
        this.renderContextChips();
        this.addMessage({ role: 'model', content: 'Hello! I am Gemini. How can I help you with your notes today?' });
    }

    async loadChat(file: TFile) {
        const container = this.containerEl.children[1];
        const titleEl = this.initializeChatUI(container);
        if (titleEl) titleEl.setText(file.basename);

        // Reset context when loading old chat (or maybe we should persist it? keeping simple for now)
        this.contextFiles = [];
        this.isActiveContextEnabled = false;
        this.renderContextChips();

        const loadedHistory = await this.chatHistoryService.loadChat(file);
        if (loadedHistory.length > 0) {
            this.currentChatFile = file.name;
            this.history = loadedHistory.map(msg => ({
                role: msg.role,
                content: msg.content,
                parts: [{ text: msg.content }]
            }));
            
            this.messagesContainer.empty();
            for (const msg of this.history) {
                this.addMessage(msg);
            }
            new Notice(`Loaded chat: ${file.basename}`);
        } else {
             this.startNewChat();
        }
    }

	async handleSend() {
		const text = this.inputTextArea.getValue().trim();
        // Allow sending if there are files attached even if text is empty (e.g. "describe this image")
		if (!text && this.contextFiles.length === 0 && !this.isActiveContextEnabled) return;

		if (!this.plugin.settings.apiKey) {
			new Notice('Please set your Gemini API Key in settings.');
			return;
		}

		// Clear input
		this.inputTextArea.setValue('');

        // Prepare User Message Parts
        const messageParts: any[] = [];
        let contextText = "";

        // Helper to process file
        const processFile = async (file: TFile, label: string) => {
            if (this.fileManager.isMediaFile(file)) {
                // Upload Media
                try {
                    const fileUri = await this.fileManager.uploadFile(file, this.plugin.settings.apiKey);
                    const mimeType = this.fileManager.getMimeType(file.extension) || 'application/octet-stream';
                    messageParts.push({
                        file_data: {
                            mime_type: mimeType,
                            file_uri: fileUri
                        }
                    });
                    new Notice(`Uploaded ${file.basename}`);
                } catch (err) {
                    console.error(`Failed to upload ${file.path}:`, err);
                    new Notice(`Failed to upload ${file.basename}: ${err.message}`);
                }
            } else {
                // Read Text
                try {
                    const content = await this.app.vault.read(file);
                    contextText += `\n\n--- Content of ${label} [[${file.path}]] ---\n${content}\n--- End of ${label} ---\n`;
                } catch (err) {
                    console.error(`Failed to read ${file.path}:`, err);
                }
            }
        };

        // 1. Process Active File
        if (this.isActiveContextEnabled) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                await processFile(activeFile, "Active File");
            }
        }

        // 2. Process Manual Context Files
        for (const file of this.contextFiles) {
             await processFile(file, "Selected File");
        }

        // 3. Process Inline Links (Text only for now, unless we want to recurse upload?)
        // Keeping existing link logic for text notes
        if (text) {
            const linkRegex = /\[\[([^\]]+)\]\]/g;
            const matches = Array.from(text.matchAll(linkRegex));
            if (matches.length > 0) {
                new Notice(`Reading ${matches.length} linked text note(s)...`);
                for (const match of matches) {
                    const linkContent = match[1];
                    const cleanLink = linkContent.split('|')[0];
                    const resolution = await this.noteService.resolveNoteFile(cleanLink);
                    if (resolution.type === 'resolved') {
                        const content = await this.noteService.readNoteText(resolution.file);
                        contextText += `\n\n--- Content of Linked Note [[${cleanLink}]] ---\n${content}\n--- End of Linked Note ---\n`;
                    }
                }
            }
        }

        // Final Assembly
        // Combine user text + context text into one text part
        const finalUserText = (text + "\n" + contextText).trim();
        
        if (finalUserText) {
            messageParts.push({ text: finalUserText });
        }

        if (messageParts.length === 0) {
            new Notice("No content to send.");
            return;
        }

		// Add User Message
		const userMsg: GeminiChatMessage = {
			role: 'user',
			content: text || (this.contextFiles.length > 0 ? `[Sent ${this.contextFiles.length} file(s)]` : "[Empty message]"),
			parts: messageParts
		};
		this.addMessage(userMsg);

        this.history.push(userMsg);
        
        // Save after user message
        try {
            const savedFile = await this.chatHistoryService.saveChat(
                this.plugin.settings.chatHistoryFolder,
                this.history.map(m => ({ role: m.role, content: m.content })),
                this.currentChatFile || undefined
            );
            this.currentChatFile = savedFile;
            
            // Update title if it was "New Chat"
            const titleEl = this.headerContainer.querySelector('.gemini-chat-title');
            if (titleEl && this.currentChatFile) {
                titleEl.setText(this.currentChatFile.replace(/\.md$/, ''));
            }
            
        } catch (e) {
            console.error("Failed to save chat:", e);
        }

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

            // Save after model message
            const savedFile = await this.chatHistoryService.saveChat(
                this.plugin.settings.chatHistoryFolder,
                this.history.map(m => ({ role: m.role, content: m.content })),
                this.currentChatFile || undefined
            );
            this.currentChatFile = savedFile;

		} catch (error) {
			console.error('Gemini Error:', error);
			loadingEl.setText(`Error: ${error.message}`);
			new Notice(`Gemini Error: ${error.message}`);
		}
	}

	async addMessage(msg: GeminiChatMessage) {
		const msgEl = this.messagesContainer.createDiv({ cls: `gemini-chat-message ${msg.role}` });

		// Render Main Message
		await MarkdownRenderer.render(
			this.app,
			msg.content,
			msgEl,
			'',
			this
		);

        // Render Usage Metadata if available (only for model messages usually)
        if (msg.usageMetadata) {
            const metaEl = msgEl.createDiv({ cls: 'gemini-chat-meta', attr: { style: 'font-size: 0.75em; color: var(--text-muted); margin-top: 5px; text-align: right;' } });
            metaEl.setText(`Tokens: ${msg.usageMetadata.totalTokenCount} (In: ${msg.usageMetadata.promptTokenCount}, Out: ${msg.usageMetadata.candidatesTokenCount})`);
        }

		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	async callGeminiAPI(history: GeminiChatMessage[]): Promise<GeminiChatMessage> {
		const { apiKey, modelName, thinkingLevel } = this.plugin.settings;
		// Use v1alpha for preview features like thinking_level
		const url = `https://generativelanguage.googleapis.com/v1alpha/models/${modelName}:generateContent`;

		// Format history for API
		// API expects: { role: "user"|"model", parts: [{ text: "..." }, { thoughtSignature: "..." }] }
		const contents = history.map(msg => ({
			role: msg.role,
			parts: msg.parts || [{ text: msg.content }]
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
			const usageMetadata = data.usageMetadata;
			
            // Identify parts
            // Thought parts usually have "thought": true (boolean) in the part object in v1alpha
            // Response content is in a part with "text" and NO "thought": true
            
			// Find the main response content part (first part that has text and is NOT a thought)
            // If no such part found, fallback to any text part
			const contentPart = content.parts.find((p: any) => p.text && p.thought !== true);
            const thoughtPart = content.parts.find((p: any) => p.thought === true);
            
            let responseContent = "";
            if (contentPart) {
                responseContent = contentPart.text;
            } else if (thoughtPart && !contentPart) {
                 // Only thoughts returned?
                 responseContent = "(Thinking process only, no final response generated)";
            } else {
                responseContent = "(No response content generated)";
            }
			
			return {
				role: 'model',
				content: responseContent,
				parts: content.parts, // Store all parts including signatures and thoughts
                usageMetadata: usageMetadata
			};
		} else {
            return {
				role: 'model',
				content: "(No response content generated)",
				parts: [{ text: "(No response content generated)" }]
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
			.setDesc('The Gemini model to use (e.g., gemini-3-pro-preview, gemini-3-pro-image-preview)')
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

		new Setting(containerEl)
			.setName('Chat History Folder')
			.setDesc('The folder to save your chat history files. e.g., "Gemini Chats"')
			.addText(text => text
				.setPlaceholder('Gemini Chats')
				.setValue(this.plugin.settings.chatHistoryFolder)
				.onChange(async (value) => {
					this.plugin.settings.chatHistoryFolder = value;
					await this.plugin.saveSettings();
				}));
	}
}
