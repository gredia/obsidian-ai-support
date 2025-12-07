import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon, ButtonComponent, TextAreaComponent, TFile, setTooltip } from 'obsidian';
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
}

const DEFAULT_SETTINGS: GeminiPluginSettings = {
	apiKey: '',
	modelName: 'gemini-3-pro-preview',
	thinkingLevel: 'high',
	chatHistoryFolder: 'Gemini Chats',
    enableGoogleSearch: false,
    enableUrlContext: false
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

        // Create Cache Button (Adding it back as requested in previous turn, but user asked to remove auto-cache logic. 
        // Wait, current prompt says "buttons like Add File, Active Note, Cache ... above the chat box".
        // So I MUST include the Cache button in the toolbar.)
        const cacheBtn = toolbar.createDiv({ cls: 'gemini-toolbar-btn', attr: { title: 'Create cache from current context' } });
        setIcon(cacheBtn, 'zap');
        cacheBtn.createSpan({ text: 'Cache' });
        cacheBtn.onClickEvent(() => {
            this.createContextCache();
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
            if (e.key === 'Enter' && !e.shiftKey) {
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
        const folderPath = this.plugin.settings.chatHistoryFolder;

        // Ensure folder exists
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch (e) {
                // Ignore if created concurrently
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

    async createContextCache() {
        if (this.contextFiles.length === 0 && !this.isActiveContextEnabled) {
            new Notice("No context selected to cache.");
            return;
        }

        if (!this.plugin.settings.apiKey) {
            new Notice('Please set your Gemini API Key in settings.');
            return;
        }

        new Notice("Creating context cache...");
        
        const cacheContents: any[] = [];

        // Process Files for Cache
        for (const file of this.contextFiles) {
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
                    new Notice(`Failed to cache ${file.basename}: ${err.message}`);
                }
            } else {
                const content = await this.app.vault.read(file);
                cacheContents.push({
                    role: 'user',
                    parts: [{ text: `Content of ${file.basename}:\n${content}` }]
                });
            }
        }

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
            // Flash: 1024, Pro: 4096, 3-Pro: 2048
            // We'll use a conservative warning threshold of 1000
            if (count.totalTokens < 1000) {
                 new Notice(`Warning: Content size (${count.totalTokens} tokens) may be too small to cache. Minimum is usually ~1024.`);
                 // We don't block it, just warn, as model limits vary.
            }
        } catch (e) {
            console.warn("Failed to count tokens before caching:", e);
        }
        // -----------------------------

        try {
            const cache = await this.cacheManager.createCache(this.plugin.settings.apiKey, {
                model: `models/${this.plugin.settings.modelName}`,
                contents: cacheContents,
                ttl: this.activeCacheTTL,
                systemInstruction: {
                    role: 'user',
                    parts: [{ text: "You are an expert assistant. Answer questions based on the provided cached context." }]
                }
            });

            this.activeCacheName = cache.name;
            new Notice("Context cached successfully! subsequent messages will be faster/cheaper.");
            this.renderContextChips(); // Update UI
        } catch (error) {
            new Notice(`Failed to create cache: ${error.message}`);
        }
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
            return; // Hide individual files when cached
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
        if (this.isActiveContextEnabled) {
            const activeChip = this.contextChipsContainer.createDiv({ cls: 'gemini-context-chip is-active-file' });
            activeChip.createSpan({ text: 'Active Note' });
            // No remove button for active context (toggled via eye button)
        }

        // Render Selected Files
        for (const file of this.contextFiles) {
            const isImage = this.fileManager.isImage(file);
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
        if (this.isActiveContextEnabled && !this.activeCacheName) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                await processFile(activeFile, "Active File");
            }
        }

        // 2. Process Manual Context Files
        if (!this.activeCacheName) {
            for (const file of this.contextFiles) {
                 await processFile(file, "Selected File");
            }
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

        // Generate content display text (what the user sees in the chat)
        // If there are context files, list them as links (excluding images which are shown separately)
        let displayContent = text;
        const nonImageFiles = this.contextFiles.filter(f => !this.fileManager.isImage(f));
        const imageFiles = this.contextFiles.filter(f => this.fileManager.isImage(f));
        const imagePaths = imageFiles.map(f => this.app.vault.getResourcePath(f));

        if (nonImageFiles.length > 0) {
            const fileLinks = nonImageFiles.map(file => `[[${file.path}|${file.basename}]]`).join(', ');
            if (displayContent) {
                displayContent += `\n\n**Attachments:** ${fileLinks}`;
            } else {
                displayContent = `**Attachments:** ${fileLinks}`;
            }
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

		// Add User Message
		const userMsg: GeminiChatMessage = {
			role: 'user',
			content: displayContent,
			parts: messageParts,
            images: imagePaths
		};
		this.addMessage(userMsg);

        this.history.push(userMsg);
        
        // Clear context after constructing the message
        this.contextFiles = [];
        this.renderContextChips();
        
        // Save after user message
        try {
            const isNewChatAndFirstUserMessage = this.currentChatFile === null && this.history.length === 1; // Check after pushing userMsg
            const savedFile = await this.chatHistoryService.saveChat(
                this.plugin.settings.chatHistoryFolder,
                this.history.map(m => ({ role: m.role, content: m.content })),
                this.currentChatFile || undefined,
                isNewChatAndFirstUserMessage ? text : undefined
            );
            this.currentChatFile = savedFile;
            
            // Update title if it was "New Chat" or first user message of a new chat
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
			const responseMsg = await this.callGeminiAPI(this.history, this.activeCacheName);

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

	async callGeminiAPI(history: GeminiChatMessage[], cachedContentName?: string | null): Promise<GeminiChatMessage> {
		const { apiKey, modelName, thinkingLevel, enableGoogleSearch, enableUrlContext } = this.plugin.settings;
		// Use v1alpha for preview features like thinking_level
		const url = `https://generativelanguage.googleapis.com/v1alpha/models/${modelName}:generateContent`;

		// Format history for API
		// API expects: { role: "user"|"model", parts: [{ text: "..." }, { thoughtSignature: "..." }] }
		const contents = history.map(msg => ({
			role: msg.role,
			parts: msg.parts || [{ text: msg.content }]
		}));

        const tools: any[] = [];
        if (enableGoogleSearch) {
            tools.push({ google_search: {} });
        }
        if (enableUrlContext) {
            tools.push({ url_context: {} });
        }

		const body: any = {
			contents: contents,
			generationConfig: {
				thinkingConfig: {
					includeThoughts: true,
					thinkingLevel: thinkingLevel
				}
			}
		};

        if (tools.length > 0) {
            body.tools = tools;
        }

        if (cachedContentName) {
            body.cachedContent = cachedContentName;
        }

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
			const candidate = data.candidates[0];
            const content = candidate.content;
			const usageMetadata = data.usageMetadata;
            const groundingMetadata = candidate.groundingMetadata;
			
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
                
                // Add citations if available
                if (groundingMetadata) {
                     responseContent = this.addCitations(responseContent, groundingMetadata);
                }

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
        const { apiKey, modelName } = this.plugin.settings;
        // Use v1beta for countTokens as it's stable there, but v1alpha should also work.
        // Using the same model name as generateContent.
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
	}
}
