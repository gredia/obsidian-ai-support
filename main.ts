import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon, ButtonComponent, TextAreaComponent, TFile, setTooltip, DropdownComponent } from 'obsidian';
import { NoteService } from './note-service';
import { ChatHistoryService, ChatMessage as HistoryChatMessage } from './chat-history-service';
import { ChatHistoryModal } from './chat-history-modal';
import { FileSuggestModal } from './file-suggest-modal';
import { GeminiFileManager } from './gemini-file-manager';
import { GeminiCacheManager } from './gemini-cache-manager';

// ----------------------------------------------------------------
// Settings & Constants
// ----------------------------------------------------------------

interface GeminiPluginSettings {
	apiKey: string;
	modelName: string;
	thinkingLevel: 'low' | 'high';
	chatHistoryFolder: string;
    enableGoogleSearch: boolean;
    enableUrlContext: boolean;
    enableAutoCache: boolean;
}

const DEFAULT_SETTINGS: GeminiPluginSettings = {
	apiKey: '',
	modelName: 'gemini-3-pro-preview',
	thinkingLevel: 'high',
	chatHistoryFolder: 'Gemini Chats',
    enableGoogleSearch: false,
    enableUrlContext: false,
    enableAutoCache: false
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
    groundingMetadata?: any;
    images?: string[]; // Resource paths for display
}

class GeminiChatView extends ItemView {
	plugin: GeminiPlugin;
	messagesContainer: HTMLElement;
	inputTextArea: TextAreaComponent;
    headerContainer: HTMLElement;
    contextChipsContainer: HTMLElement;
    activeContextBtn: HTMLElement;
    sendBtn: ButtonComponent;
    stopBtn: HTMLElement;
    abortController: AbortController | null = null;
    
	    history: GeminiChatMessage[] = [];
	    noteService: NoteService;
	    chatHistoryService: ChatHistoryService;
	    fileManager: GeminiFileManager;
	    cacheManager: GeminiCacheManager;
	    currentChatFile: string | null = null;
        currentModel: string;
	    
	    // Context State
	    contextFiles: TFile[] = [];
	    isActiveContextEnabled: boolean = true;
	    
	    // Cache State
	    activeCacheName: string | null = null;
	    activeCacheTTL: string = "600s"; // Default 10 minutes
	
		constructor(leaf: WorkspaceLeaf, plugin: GeminiPlugin) {
			super(leaf);
			this.plugin = plugin;
	        this.noteService = new NoteService(plugin.app);
	        this.chatHistoryService = new ChatHistoryService(plugin.app);
	        this.fileManager = new GeminiFileManager(plugin.app);
	        this.cacheManager = new GeminiCacheManager(plugin.app);
            this.currentModel = this.plugin.settings.modelName;
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

        // Update context chips when active file changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                // Only update if the view is initialized and active context is enabled
                if (this.contextChipsContainer && this.isActiveContextEnabled) {
                    this.renderContextChips();
                }
            })
        );
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

        // Toolbar (Row 1) - Buttons Above Input
        const toolbar = footer.createDiv({ cls: 'gemini-chat-toolbar' });

        // Add File Button
        const addFileBtn = toolbar.createDiv({ cls: 'gemini-toolbar-btn', attr: { title: 'Add note to context' } });
        setIcon(addFileBtn, 'file-plus');
        addFileBtn.createSpan({ text: 'Add File' });
        addFileBtn.onClickEvent(() => {
            new FileSuggestModal(this.app, (file) => {
                this.addContextFile(file);
            }).open();
        });

        // Active Context Toggle
        this.activeContextBtn = toolbar.createDiv({ cls: 'gemini-toolbar-btn', attr: { title: 'Toggle active file context' } });
        setIcon(this.activeContextBtn, 'eye');
        this.activeContextBtn.createSpan({ text: 'Active Note' });
        // Set initial state class
        if (this.isActiveContextEnabled) {
            this.activeContextBtn.addClass('is-active');
        }
        this.activeContextBtn.onClickEvent(() => {
            this.isActiveContextEnabled = !this.isActiveContextEnabled;
            this.renderContextChips();
        });

        // Model Selector
        const modelSelectorContainer = toolbar.createDiv({ cls: 'gemini-model-selector-container' });
        new DropdownComponent(modelSelectorContainer)
            .addOption('gemini-3-pro-preview', 'Gemini 3 Pro')
            .addOption('gemini-2.5-pro', 'Gemini 2.5 Pro')
            .addOption('gemini-2.5-flash', 'Gemini 2.5 Flash')
            .addOption('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite')
            .setValue(this.currentModel)
            .onChange(async (value) => {
                this.currentModel = value;
                new Notice(`Model switched to ${value}`);

                // Invalidate cache when model changes, as cache is model-specific
                if (this.activeCacheName) {
                    await this.cacheManager.deleteCache(this.plugin.settings.apiKey, this.activeCacheName);
                    this.activeCacheName = null;
                    this.renderContextChips();
                    new Notice("Context cache cleared due to model switch.");
                }
            });

        // Context Chips (Row 2)
        this.contextChipsContainer = footer.createDiv({ cls: 'gemini-context-chips' });
        this.renderContextChips(); // Initial render

        // Input Row (Row 3)
        const inputRow = footer.createDiv({ cls: 'gemini-chat-input-container' });

        this.inputTextArea = new TextAreaComponent(inputRow);
        this.inputTextArea.inputEl.addClass('gemini-chat-input');
        this.inputTextArea.setPlaceholder('Ask Gemini...');
        this.inputTextArea.inputEl.rows = 6; // Increased height
        
        // Handle Enter key to send
        this.inputTextArea.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        // Handle Paste for Images
        this.inputTextArea.inputEl.addEventListener('paste', async (e: ClipboardEvent) => {
            if (e.clipboardData && e.clipboardData.items) {
                for (let i = 0; i < e.clipboardData.items.length; i++) {
                    const item = e.clipboardData.items[i];
                    if (item.type.indexOf('image') !== -1) {
                        e.preventDefault();
                        const blob = item.getAsFile();
                        if (blob) {
                            const arrayBuffer = await blob.arrayBuffer();
                            await this.handleImagePaste(arrayBuffer, item.type);
                        }
                    }
                }
            }
        });

        // Send Button
        this.sendBtn = new ButtonComponent(inputRow);
        this.sendBtn.setIcon('send');
        this.sendBtn.setClass('gemini-chat-send-btn');
        this.sendBtn.onClick(() => this.handleSend());

        // Stop Button (Hidden by default)
        this.stopBtn = inputRow.createDiv({ cls: 'gemini-chat-stop-btn', attr: { style: 'display: none;', title: 'Stop Generating' } });
        setIcon(this.stopBtn, 'square'); // Use square icon for stop
        this.stopBtn.onClickEvent(() => {
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
                new Notice("Generation stopped.");
                this.setLoading(false);
            }
        });
        
        return titleEl; 
    }

    setLoading(loading: boolean) {
        if (loading) {
            this.sendBtn.buttonEl.style.display = 'none';
            this.stopBtn.style.display = 'flex';
        } else {
            this.sendBtn.buttonEl.style.display = 'flex';
            this.stopBtn.style.display = 'none';
        }
    }

    async handleImagePaste(buffer: ArrayBuffer, mimeType: string) {
        const extension = mimeType.split('/')[1] || 'png';
        const dateStr = new Date().toISOString().replace(/[:\.]/g, "-").slice(0, 19);
        const baseName = `Pasted Image ${dateStr}`;
        const folderPath = `${this.plugin.settings.chatHistoryFolder}/Attachments`;

        // Ensure folder exists
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch (e) {
                // Ignore if created concurrently or parent missing (createFolder isn't recursive by default, might need recursive check)
                // For simplicity assuming chatHistoryFolder exists or handled. 
                // Better: ensure parent exists first.
                if (!this.app.vault.getAbstractFileByPath(this.plugin.settings.chatHistoryFolder)) {
                     await this.app.vault.createFolder(this.plugin.settings.chatHistoryFolder);
                }
                await this.app.vault.createFolder(folderPath);
            }
        }
        
        // Find unique filename
        let fileName = `${baseName}.${extension}`;
        let filePath = `${folderPath}/${fileName}`;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(filePath)) {
            fileName = `${baseName} (${counter}).${extension}`;
            filePath = `${folderPath}/${fileName}`;
            counter++;
        }
        
        try {
            const file = await this.app.vault.createBinary(filePath, buffer);
            this.addContextFile(file);
            new Notice(`Image pasted: ${fileName}`);
        } catch (error) {
            console.error('Failed to save pasted image:', error);
            new Notice(`Failed to save pasted image: ${error.message}`);
        }
    }

    async createContextCache(silent: boolean = false): Promise<string | null> {
        if (this.contextFiles.length === 0 && !this.isActiveContextEnabled) {
            if (!silent) new Notice("No context selected to cache.");
            return null;
        }

        if (!this.plugin.settings.apiKey) {
            if (!silent) new Notice('Please set your Gemini API Key in settings.');
            return null;
        }

        if (!silent) new Notice("Creating context cache...");
        
        const cacheContents: any[] = [];

        // 1. Process Files for Cache
        for (const file of this.contextFiles) {
            // Skip images for cache to avoid 400 errors (often due to low token count or API limitations)
            if (this.fileManager.isImage(file)) {
                if (!silent) console.log(`Skipping image ${file.basename} for cache.`);
                continue;
            }

            if (this.fileManager.isMediaFile(file)) {
                try {
                    const fileUri = await this.fileManager.uploadFile(file, this.plugin.settings.apiKey);
                    const mimeType = this.fileManager.getMimeType(file.extension) || 'application/octet-stream';
                    cacheContents.push({
                        role: 'user',
                        parts: [{
                            file_data: {
                                mime_type: mimeType,
                                file_uri: fileUri
                            }
                        }]
                    });
                } catch (err) {
                    const msg = `Failed to cache ${file.basename}: ${err.message}`;
                    console.error(msg);
                    if (!silent) new Notice(msg);
                }
            } else {
                const content = await this.app.vault.read(file);
                cacheContents.push({
                    role: 'user',
                    parts: [{ text: `Content of ${file.basename}:\n${content}` }]
                });
            }
        }

        // 2. Active File
        if (this.isActiveContextEnabled) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                 const content = await this.app.vault.read(activeFile);
                 cacheContents.push({
                    role: 'user',
                    parts: [{ text: `Content of Active File (${activeFile.basename}):\n${content}` }]
                });
            }
        }

        // --- Validate Token Count ---
        try {
            const count = await this.countTokensAPI(cacheContents);
            console.log("Token count for cache:", count);
            
            // Check for minimum token requirements (approximate)
            if (count.totalTokens < 2048) {
                 if (!silent) {
                    new Notice(`Cannot create cache: Content size (${count.totalTokens} tokens) is below the minimum required (2048 tokens).`);
                 }
                 return null;
            }
        } catch (e) {
            console.warn("Failed to count tokens before caching:", e);
            if (!silent) new Notice("Failed to count tokens, aborting cache creation.");
            return null;
        }
        // -----------------------------

        try {
            const { enableGoogleSearch, enableUrlContext } = this.plugin.settings;
            const tools: any[] = [];
            if (enableGoogleSearch) tools.push({ google_search: {} });
            if (enableUrlContext) tools.push({ url_context: {} });

            const cacheConfig: any = {
                model: `models/${this.currentModel}`,
                contents: cacheContents,
                ttl: this.activeCacheTTL,
                systemInstruction: {
                    role: 'user',
                    parts: [{ text: "You are an expert assistant. Answer questions based on the provided cached context." }]
                }
            };

            if (tools.length > 0) {
                cacheConfig.tools = tools;
            }

            const cache = await this.cacheManager.createCache(this.plugin.settings.apiKey, cacheConfig);

            this.activeCacheName = cache.name;
            if (!silent) new Notice("Context cached successfully! subsequent messages will be faster/cheaper.");
            this.renderContextChips(); // Update UI
            return cache.name;
        } catch (error) {
            const msg = `Failed to create cache: ${error.message}`;
            console.error(msg);
            if (!silent) new Notice(msg);
            return null;
        }
    }
    
    // I will just replace the methods.

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

        if (this.activeCacheName) {
            const cacheChip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip', attr: { style: 'background-color: var(--color-green); color: white;' } });
            cacheChip.createSpan({ text: '⚡ Context Cached' });
            const removeBtn = cacheChip.createDiv({ cls: 'gemini-context-chip-remove' });
            setIcon(removeBtn, 'trash');
            removeBtn.onClickEvent(async () => {
                await this.cacheManager.deleteCache(this.plugin.settings.apiKey, this.activeCacheName!);
                this.activeCacheName = null;
                this.renderContextChips();
                new Notice("Cache cleared.");
            });
            // Do not return here, so we can render non-cached items (like images)
        }

        // Update active context button state
        if (this.activeContextBtn) {
            if (this.isActiveContextEnabled) {
                this.activeContextBtn.addClass('is-active');
            } else {
                this.activeContextBtn.removeClass('is-active');
            }
        }

        // Render Active File Chip if enabled
        // If cache is active, assume active file text is cached, so hide it to avoid clutter
        if (this.isActiveContextEnabled && !this.activeCacheName) {
            const activeChip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip is-active-file' });
            const activeFile = this.app.workspace.getActiveFile();
            const fileName = activeFile ? activeFile.basename : '(None)';
            activeChip.createSpan({ text: `Active Note: ${fileName}` });
            // No remove button for active context (toggled via eye button)
        }

        // Render Selected Files
        for (const file of this.contextFiles) {
            const isImage = this.fileManager.isImage(file);
            
            // If cache is active, hide non-image files (as they are likely cached)
            // Images are excluded from cache, so always show them
            if (this.activeCacheName && !isImage) {
                continue;
            }

            const chip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip' });
            
            if (isImage) {
                chip.addClass('is-image-chip');
                const resourcePath = this.app.vault.getResourcePath(file);
                const img = chip.createEl('img');
                img.src = resourcePath;
                img.addClass('gemini-thumbnail-img');
            }

            chip.createSpan({ text: file.basename, cls: 'gemini-context-chip-filename' });
            const removeBtn = chip.createDiv({ cls: 'gemini-context-chip-remove' });
            setIcon(removeBtn, 'x');
            removeBtn.onClickEvent((e) => {
                e.stopPropagation();
                this.removeContextFile(file);
            });
        }
    }

    async startNewChat() {
        const container = this.containerEl.children[1];
        
        // Reset model to default
        this.currentModel = this.plugin.settings.modelName;

        const titleEl = this.initializeChatUI(container);
        if (titleEl) titleEl.setText('New Chat');

        if (this.activeCacheName) {
            await this.cacheManager.deleteCache(this.plugin.settings.apiKey, this.activeCacheName);
            this.activeCacheName = null;
        }

        this.currentChatFile = null;
        this.history = [];
        this.contextFiles = [];
        this.isActiveContextEnabled = true;
        this.renderContextChips();
        this.addMessage({ role: 'model', content: 'Hello! I am Gemini. How can I help you with your notes today?' });
    }

    async loadChat(file: TFile) {
        const container = this.containerEl.children[1];
        
        // Reset model to default when loading (session scoped)
        this.currentModel = this.plugin.settings.modelName;

        const titleEl = this.initializeChatUI(container);
        if (titleEl) titleEl.setText(file.basename);

        // Clear active cache from previous session if any
        if (this.activeCacheName) {
            await this.cacheManager.deleteCache(this.plugin.settings.apiKey, this.activeCacheName);
            this.activeCacheName = null;
        }

        // Reset context when loading old chat (or maybe we should persist it? keeping simple for now)
        this.contextFiles = [];
        this.isActiveContextEnabled = true;
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

        // --- 1. Immediate UI Update (Optimistic) ---

        // Generate content display text
        let displayContent = text;
        const nonImageFiles = this.contextFiles.filter(f => !this.fileManager.isImage(f));
        const imageFiles = this.contextFiles.filter(f => this.fileManager.isImage(f));
        const imagePaths = imageFiles.map(f => this.app.vault.getResourcePath(f));

        if (nonImageFiles.length > 0) {
            const fileLinks = nonImageFiles.map(file => `[[${file.path}|${file.basename}]]`).join(', ');
            displayContent += displayContent ? `\n\n**Attachments:** ${fileLinks}` : `**Attachments:** ${fileLinks}`;
        }

        if (imageFiles.length > 0) {
            const imageEmbeds = imageFiles.map(file => `![[${file.path}]]`).join('\n');
            displayContent += displayContent ? `\n\n${imageEmbeds}` : `${imageEmbeds}`;
        }
        
        if (this.isActiveContextEnabled) {
             const activeFile = this.app.workspace.getActiveFile();
             if (activeFile) {
                 const activeLink = `[[${activeFile.path}|${activeFile.basename}]]`;
                 displayContent += displayContent ? `\n**Active Note:** ${activeLink}` : `**Active Note:** ${activeLink}`;
             }
        }

        if (!displayContent && imagePaths.length === 0) {
            displayContent = "[Empty message]";
        }

		// Add User Message to UI immediately
		const userMsg: GeminiChatMessage = {
			role: 'user',
			content: displayContent,
			parts: [], // Will be filled later
            images: imagePaths
		};
		this.addMessage(userMsg);
        this.history.push(userMsg);
        
        // Save chat history immediately
        this.chatHistoryService.saveChat(
            this.plugin.settings.chatHistoryFolder,
            this.history.map(m => ({ role: m.role, content: m.content })),
            this.currentChatFile || undefined,
            (this.currentChatFile === null && this.history.length === 1) ? text : undefined
        ).then(file => {
            this.currentChatFile = file;
            const titleEl = this.headerContainer.querySelector('.gemini-chat-title');
            if (titleEl && this.currentChatFile) {
                titleEl.setText(this.currentChatFile.replace(/\.md$/, ''));
            }
        }).catch(err => console.error("Failed to save chat:", err));

        // Clear context selection in UI (files are already captured in local vars)
        this.contextFiles = [];
        this.renderContextChips();

		// Show Loading
		const loadingEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-loading' });
		loadingEl.setText('Gemini is thinking...');
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        this.abortController = new AbortController();
        this.setLoading(true);

        // --- 2. Heavy Processing (Uploads & Context) ---
        
        try {
            // Auto-Cache Check
            if (this.plugin.settings.enableAutoCache && !this.activeCacheName) {
                const cachedName = await this.createContextCache(true);
                if (cachedName) {
                    new Notice("Context automatically cached for performance.");
                }
            }

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
                        if (!this.activeCacheName) new Notice(`Uploaded ${file.basename}`);
                    } catch (err) {
                        throw new Error(`Failed to upload ${file.basename}: ${err.message}`);
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
            // Active file is text-based, so assume it's cached if cache is active.
            if (this.isActiveContextEnabled && !this.activeCacheName) {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    await processFile(activeFile, "Active File");
                }
            }

            // 2. Process Manual Context Files
            // Images are NOT cached, so always process them.
            // Text/PDFs ARE cached, so skip them if cache is active.
            // Using the local `allFiles` (captured from imageFiles + nonImageFiles)
            const allFiles = [...nonImageFiles, ...imageFiles];
            for (const file of allFiles) {
                const isImg = this.fileManager.isImage(file);
                if (this.activeCacheName && !isImg) {
                    // Skip cached text/pdf files
                    continue;
                }
                await processFile(file, "Selected File");
            }

            // 3. Process Inline Links
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
            const finalUserText = (text + "\n" + contextText).trim();
            if (finalUserText) {
                messageParts.push({ text: finalUserText });
            }

            if (messageParts.length === 0) {
                throw new Error("No content to send (upload failed or empty).");
            }

            // Update the user message object with the actual parts
            userMsg.parts = messageParts;

            // --- 3. Call API ---
			const responseMsg = await this.callGeminiAPI(this.history, this.currentModel, this.activeCacheName, this.abortController.signal);

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
            loadingEl.remove();
            
            if (error.name === 'AbortError') {
                new Notice('Generation stopped.');
            } else {
                console.error('Gemini Error:', error);
                new Notice(`Gemini Error: ${error.message}`);
                // Add error message to chat
                this.addMessage({ 
                    role: 'model', 
                    content: `❌ **Error:** ${error.message}\n\ngeneration aborted.` 
                });
            }
		} finally {
            this.abortController = null;
            this.setLoading(false);
        }
	}

	async addMessage(msg: GeminiChatMessage) {
        // Wrapper for row layout
        const rowEl = this.messagesContainer.createDiv({ cls: `gemini-chat-row ${msg.role}` });

        // Images Container (if any)
        if (msg.images && msg.images.length > 0) {
            const imagesEl = rowEl.createDiv({ cls: 'gemini-chat-images' });
            for (const imgPath of msg.images) {
                imagesEl.createEl('img', { 
                    attr: { src: imgPath, class: 'gemini-chat-image-thumb' } 
                }).onClickEvent(() => {
                    // Optional: click to expand? For now just a thumb.
                });
            }
        }

		const msgEl = rowEl.createDiv({ cls: `gemini-chat-message ${msg.role}` });

        // Message Actions (Copy & Edit)
        const actionsEl = msgEl.createDiv({ cls: 'gemini-chat-message-actions' });
        
        // Edit Button (User only)
        if (msg.role === 'user') {
            const editBtn = actionsEl.createDiv({ cls: 'gemini-copy-btn', attr: { 'title': 'Edit & Resend' } });
            setIcon(editBtn, 'pencil');
            editBtn.onClickEvent((e) => {
                e.stopPropagation();
                
                // Remove auto-generated metadata (Attachments, Active Note links) from the display content
                let textToEdit = msg.content;
                
                // Regex to remove **Attachments:** line (at start or end)
                textToEdit = textToEdit.replace(/\n*\*\*Attachments:\*\*.*$/gm, '');
                textToEdit = textToEdit.replace(/^\*\*Attachments:\*\*.*\n*/gm, '');

                // Regex to remove **Active Note:** line (at start or end)
                textToEdit = textToEdit.replace(/\n*\*\*Active Note:\*\*.*$/gm, '');
                textToEdit = textToEdit.replace(/^\*\*Active Note:\*\*.*\n*/gm, '');

                this.inputTextArea.setValue(textToEdit.trim());
                this.inputTextArea.inputEl.focus();
            });
        }

        // Copy Button
        const copyBtn = actionsEl.createDiv({ cls: 'gemini-copy-btn', attr: { 'title': 'Copy message' } });
        setIcon(copyBtn, 'copy');
        copyBtn.onClickEvent((e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(msg.content).then(() => new Notice('Message copied'));
        });

		// Render Main Message
		await MarkdownRenderer.render(
			this.app,
			msg.content,
			msgEl,
			'',
			this
		);

        // Render Grounding Metadata (Sources & Search Queries)
        if (msg.groundingMetadata) {
            const groundingEl = msgEl.createDiv({ cls: 'gemini-chat-grounding', attr: { style: 'margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--background-modifier-border); font-size: 0.85em;' } });
            
            // Search Queries
            if (msg.groundingMetadata.webSearchQueries && msg.groundingMetadata.webSearchQueries.length > 0) {
                const queriesEl = groundingEl.createDiv({ cls: 'gemini-search-queries', attr: { style: 'margin-bottom: 5px; color: var(--text-muted);' } });
                queriesEl.createSpan({ text: '🔍 Searched for: ' });
                msg.groundingMetadata.webSearchQueries.forEach((q: string, i: number) => {
                    if (i > 0) queriesEl.createSpan({ text: ', ' });
                    queriesEl.createSpan({ text: q, cls: 'gemini-search-query', attr: { style: 'font-style: italic;' } });
                });
            }

            // Sources
            if (msg.groundingMetadata.groundingChunks && msg.groundingMetadata.groundingChunks.length > 0) {
                const sourcesEl = groundingEl.createDiv({ cls: 'gemini-search-sources' });
                sourcesEl.createDiv({ text: 'Sources:', cls: 'gemini-sources-header', attr: { style: 'font-weight: bold; margin-bottom: 4px;' } });
                const listEl = sourcesEl.createEl('ul', { attr: { style: 'margin: 0; padding-left: 20px;' } });
                
                msg.groundingMetadata.groundingChunks.forEach((chunk: any, i: number) => {
                    if (chunk.web?.uri && chunk.web?.title) {
                        const li = listEl.createEl('li');
                        li.createEl('a', { href: chunk.web.uri, text: `${chunk.web.title}` }); // Link only shows title
                        li.createSpan({ text: ` (${i+1})`, attr: { style: 'font-size: 0.8em; color: var(--text-muted);' } }); // Indicate index match
                    }
                });
            }
        }

        // Render Usage Metadata if available (only for model messages usually)
        if (msg.usageMetadata) {
            const metaEl = msgEl.createDiv({ cls: 'gemini-chat-meta', attr: { style: 'font-size: 0.75em; color: var(--text-muted); margin-top: 5px; text-align: right;' } });
            metaEl.setText(`Tokens: ${msg.usageMetadata.totalTokenCount} (In: ${msg.usageMetadata.promptTokenCount}, Out: ${msg.usageMetadata.candidatesTokenCount})`);
        }

		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	async callGeminiAPI(history: GeminiChatMessage[], modelName: string, cachedContentName?: string | null, signal?: AbortSignal): Promise<GeminiChatMessage> {
		const { apiKey, thinkingLevel, enableGoogleSearch, enableUrlContext } = this.plugin.settings;
        
        const isGemini3 = modelName.includes('gemini-3');
        const apiVersion = isGemini3 ? 'v1alpha' : 'v1beta';
		const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent`;

		// Format history for API
		const contents = history.map(msg => ({
			role: msg.role,
			parts: msg.parts || [{ text: msg.content }]
		}));

        const tools: any[] = [];
        if (enableGoogleSearch) {
            // v1beta uses snake_case usually, but let's stick to object key if possible.
            // Actually google_search is standard.
            tools.push({ google_search: {} });
        }
        if (enableUrlContext) {
            // url_context might be v1alpha specific? 
            // Documentation implies it's a tool. Let's include it if enabled.
            // If it causes error on v1beta, user should disable it.
            tools.push({ url_context: {} });
        }

		const body: any = {
			contents: contents,
            generationConfig: {}
		};

        // Add Thinking Config ONLY for Gemini 3
        if (isGemini3) {
            body.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: thinkingLevel
            };
        }

        // Tools cannot be used in generateContent when cachedContent is present
        // (They must be defined in the cache itself, which we don't do dynamically yet)
        if (tools.length > 0 && !cachedContentName) {
            body.tools = tools;
        }

        if (cachedContentName) {
            body.cachedContent = cachedContentName;
        }

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey
			},
			body: JSON.stringify(body),
            signal: signal
		});

		if (!response.ok) {
            const errorText = await response.text();
			console.error('Gemini API Error Body:', errorText);
			throw new Error(`API Error ${response.status}: ${errorText}`);
		}

		const data = await response.json();
		
		// Extract parts from response
		if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
			const candidate = data.candidates[0];
            const content = candidate.content;
			const usageMetadata = data.usageMetadata;
            const groundingMetadata = candidate.groundingMetadata;
			
            // Gemini 3: Handle thoughts
            // Gemini 2.5: Standard text
			const contentPart = content.parts.find((p: any) => p.text && p.thought !== true);
            const thoughtPart = content.parts.find((p: any) => p.thought === true);
            
            let responseContent = "";
            if (contentPart) {
                responseContent = contentPart.text;
                
                // Add citations if available
                if (groundingMetadata) {
                     responseContent = this.addCitations(responseContent, groundingMetadata);
                }

            } else if (thoughtPart && !contentPart) {
                 responseContent = "(Thinking process only, no final response generated)";
            } else if (content.parts.length > 0 && content.parts[0].text) {
                // Fallback for models without thoughts (Gemini 2.5) where parts is just [{text: "..."}]
                responseContent = content.parts[0].text;
                 if (groundingMetadata) {
                     responseContent = this.addCitations(responseContent, groundingMetadata);
                }
            } else {
                responseContent = "(No response content generated)";
            }
			
			return {
				role: 'model',
				content: responseContent,
				parts: content.parts, 
                usageMetadata: usageMetadata,
                groundingMetadata: groundingMetadata
			};
		} else {
            return {
				role: 'model',
				content: "(No response content generated)",
				parts: [{ text: "(No response content generated)" }]
			};
        }
	}

    addCitations(text: string, groundingMetadata: any): string {
        if (!groundingMetadata || !groundingMetadata.groundingSupports || !groundingMetadata.groundingChunks) {
            return text;
        }

        const supports = groundingMetadata.groundingSupports;
        const chunks = groundingMetadata.groundingChunks;
        
        // Sort supports by end_index in descending order to avoid shifting issues when inserting.
        const sortedSupports = [...supports].sort((a: any, b: any) => {
             const endA = a.segment?.endIndex || 0;
             const endB = b.segment?.endIndex || 0;
             return endB - endA;
        });

        let newText = text;

        for (const support of sortedSupports) {
            const endIndex = support.segment?.endIndex;
            const indices = support.groundingChunkIndices;

            if (endIndex === undefined || !indices || indices.length === 0) {
                continue;
            }

            // Verify indices are valid
            const validIndices = indices.filter((i: number) => i >= 0 && i < chunks.length);
            if (validIndices.length === 0) continue;

            const citationLinks = validIndices.map((i: number) => {
                const chunk = chunks[i];
                const uri = chunk.web?.uri;
                const title = chunk.web?.title || "Source";
                if (uri) {
                    return `[${i + 1}](${uri} "${title}")`;
                }
                return `[${i + 1}]`;
            });

            const citationString = " " + citationLinks.join(""); // Add space before citations
            
            // Insert at endIndex
            if (endIndex <= newText.length) {
                 newText = newText.slice(0, endIndex) + citationString + newText.slice(endIndex);
            }
        }
        
        return newText;
    }

    async countTokensAPI(contents: any[]): Promise<{ totalTokens: number }> {
        const { apiKey } = this.plugin.settings;
        // Use v1beta for countTokens as it's stable there, but v1alpha should also work.
        // Using the same model name as generateContent.
        const modelName = this.currentModel || this.plugin.settings.modelName;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:countTokens`;

        const response = await requestUrl({
            url: url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({ contents: contents }),
            throw: false
        });

        if (response.status >= 400) {
             throw new Error(`CountTokens API Error ${response.status}: ${response.text}`);
        }

        return response.json;
    }

	async onClose() {
		if (this.activeCacheName) {
            await this.cacheManager.deleteCache(this.plugin.settings.apiKey, this.activeCacheName);
            console.log("Cache deleted:", this.activeCacheName);
        }
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
			.setName('Default Model Name')
			.setDesc('The default Gemini model for new chats.')
			.addDropdown(dropdown => dropdown
                .addOption('gemini-3-pro-preview', 'Gemini 3 Pro Preview')
                .addOption('gemini-2.5-pro', 'Gemini 2.5 Pro')
                .addOption('gemini-2.5-flash', 'Gemini 2.5 Flash')
                .addOption('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite')
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

        new Setting(containerEl)
            .setName('Enable Google Search')
            .setDesc('Allow the model to use Google Search for grounding.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableGoogleSearch)
                .onChange(async (value) => {
                    this.plugin.settings.enableGoogleSearch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable URL Context')
            .setDesc('Allow the model to fetch and use content from URLs provided in the prompt.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableUrlContext)
                .onChange(async (value) => {
                    this.plugin.settings.enableUrlContext = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable Auto Cache')
            .setDesc('Automatically create a context cache when content exceeds 2048 tokens.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoCache)
                .onChange(async (value) => {
                    this.plugin.settings.enableAutoCache = value;
                    await this.plugin.saveSettings();
                }));
	}
}
