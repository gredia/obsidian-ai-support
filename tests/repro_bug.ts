import { MockPlugin, MockHTMLElement, setIcon, DropdownComponent, TextAreaComponent, ButtonComponent, GEMINI_MODELS, Notice } from './mocks';

// Mocking the View Logic
class TestGeminiChatView {
    plugin: MockPlugin;
    containerEl: MockHTMLElement;
    thinkingToggleBtn: MockHTMLElement;
    isThinkingEnabled: boolean;
    currentModel: string;
    
    // UI Elements
    headerContainer: MockHTMLElement;
    messagesContainer: MockHTMLElement;
    contextChipsContainer: MockHTMLElement;

    constructor(plugin: MockPlugin) {
        this.plugin = plugin;
        this.containerEl = new MockHTMLElement();
        // Mimic Obsidian structure: children[1] is content
        this.containerEl.children.push(new MockHTMLElement()); 
        this.containerEl.children.push(new MockHTMLElement()); 
        
        this.isThinkingEnabled = this.plugin.settings.enableThinking;
        this.currentModel = this.plugin.settings.modelName;
    }

    // Copied Logic from main.ts (simplified for test)
    async startNewChat() {
        const container = this.containerEl.children[1];
        this.currentModel = this.plugin.settings.modelName;
        // BUG VERIFICATION: Does this line exist/work?
        this.isThinkingEnabled = this.plugin.settings.enableThinking; 

        this.initializeChatUI(container);
    }

    initializeChatUI(container: any) {
        container.empty();
        container.addClass('gemini-chat-view');

        this.createHeader(container);
        this.createMessageList(container);
        this.createFooter(container);
    }

    createHeader(container: any) {
        this.headerContainer = container.createDiv({ cls: 'gemini-chat-header' });
        // ... simplified
        return this.headerContainer;
    }

    createMessageList(container: any) {
        this.messagesContainer = container.createDiv({ cls: 'gemini-chat-messages' });
    }

    createFooter(container: any) {
        const footer = container.createDiv({ cls: 'gemini-chat-footer' });
        this.createToolbar(footer);
        // ... simplified
    }

    createToolbar(container: any) {
        const toolbar = container.createDiv({ cls: 'gemini-chat-toolbar' });
        
        const controlsContainer = toolbar.createDiv({ cls: 'gemini-controls-container' });

        // Logic from main.ts
        this.thinkingToggleBtn = controlsContainer.createDiv({ cls: 'gemini-toolbar-btn gemini-thinking-toggle' });
        
        // Initial Icon state
        setIcon(this.thinkingToggleBtn, this.isThinkingEnabled ? 'brain-circuit' : 'brain'); 
        if (this.isThinkingEnabled) this.thinkingToggleBtn.addClass('is-active');

        // ... visibility logic
        const updateThinkingVisibility = (model: string) => {
            if (model.includes('gemini-3')) {
                this.thinkingToggleBtn.style.display = 'none';
            } else {
                this.thinkingToggleBtn.style.display = 'flex';
            }
        };
        updateThinkingVisibility(this.currentModel);
    }
}

// --- Run Tests ---

async function runTests() {
    const plugin = new MockPlugin();
    const view = new TestGeminiChatView(plugin);

    console.log('--- Test 1: Start New Chat with enableThinking = TRUE ---');
    plugin.settings.enableThinking = true;
    await view.startNewChat();

    if (view.isThinkingEnabled !== true) {
        console.error('FAIL: isThinkingEnabled should be true');
    } else {
        console.log('PASS: isThinkingEnabled is true');
    }

    if (!view.thinkingToggleBtn.hasClass('is-active')) {
        console.error('FAIL: Button should have "is-active" class');
    } else {
        console.log('PASS: Button has "is-active" class');
    }
    
    if (view.thinkingToggleBtn.icon !== 'brain-circuit') {
         console.error(`FAIL: Icon should be "brain-circuit", got "${view.thinkingToggleBtn.icon}"`);
    } else {
         console.log('PASS: Icon is "brain-circuit"');
    }


    console.log('\n--- Test 2: Start New Chat with enableThinking = FALSE ---');
    plugin.settings.enableThinking = false;
    await view.startNewChat();

    if (view.isThinkingEnabled !== false) {
        console.error('FAIL: isThinkingEnabled should be false');
    } else {
        console.log('PASS: isThinkingEnabled is false');
    }

    if (view.thinkingToggleBtn.hasClass('is-active')) {
        console.error('FAIL: Button should NOT have "is-active" class');
    } else {
        console.log('PASS: Button does not have "is-active" class');
    }

    if (view.thinkingToggleBtn.icon !== 'brain') {
         console.error(`FAIL: Icon should be "brain", got "${view.thinkingToggleBtn.icon}"`);
    } else {
         console.log('PASS: Icon is "brain"');
    }
}

runTests().catch(e => console.error(e));
