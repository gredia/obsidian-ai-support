"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const mocks_1 = require("./mocks");
// Mocking the View Logic
class TestGeminiChatView {
    constructor(plugin) {
        this.plugin = plugin;
        this.containerEl = new mocks_1.MockHTMLElement();
        // Mimic Obsidian structure: children[1] is content
        this.containerEl.children.push(new mocks_1.MockHTMLElement());
        this.containerEl.children.push(new mocks_1.MockHTMLElement());
        this.isThinkingEnabled = this.plugin.settings.enableThinking;
        this.currentModel = this.plugin.settings.modelName;
    }
    // Copied Logic from main.ts (simplified for test)
    startNewChat() {
        return __awaiter(this, void 0, void 0, function* () {
            const container = this.containerEl.children[1];
            this.currentModel = this.plugin.settings.modelName;
            // BUG VERIFICATION: Does this line exist/work?
            this.isThinkingEnabled = this.plugin.settings.enableThinking;
            this.initializeChatUI(container);
        });
    }
    initializeChatUI(container) {
        container.empty();
        container.addClass('gemini-chat-view');
        this.createHeader(container);
        this.createMessageList(container);
        this.createFooter(container);
    }
    createHeader(container) {
        this.headerContainer = container.createDiv({ cls: 'gemini-chat-header' });
        // ... simplified
        return this.headerContainer;
    }
    createMessageList(container) {
        this.messagesContainer = container.createDiv({ cls: 'gemini-chat-messages' });
    }
    createFooter(container) {
        const footer = container.createDiv({ cls: 'gemini-chat-footer' });
        this.createToolbar(footer);
        // ... simplified
    }
    createToolbar(container) {
        const toolbar = container.createDiv({ cls: 'gemini-chat-toolbar' });
        const controlsContainer = toolbar.createDiv({ cls: 'gemini-controls-container' });
        // Logic from main.ts
        this.thinkingToggleBtn = controlsContainer.createDiv({ cls: 'gemini-toolbar-btn gemini-thinking-toggle' });
        // Initial Icon state
        (0, mocks_1.setIcon)(this.thinkingToggleBtn, this.isThinkingEnabled ? 'brain-circuit' : 'brain');
        if (this.isThinkingEnabled)
            this.thinkingToggleBtn.addClass('is-active');
        // ... visibility logic
        const updateThinkingVisibility = (model) => {
            if (model.includes('gemini-3')) {
                this.thinkingToggleBtn.style.display = 'none';
            }
            else {
                this.thinkingToggleBtn.style.display = 'flex';
            }
        };
        updateThinkingVisibility(this.currentModel);
    }
}
// --- Run Tests ---
function runTests() {
    return __awaiter(this, void 0, void 0, function* () {
        const plugin = new mocks_1.MockPlugin();
        const view = new TestGeminiChatView(plugin);
        console.log('--- Test 1: Start New Chat with enableThinking = TRUE ---');
        plugin.settings.enableThinking = true;
        yield view.startNewChat();
        if (view.isThinkingEnabled !== true) {
            console.error('FAIL: isThinkingEnabled should be true');
        }
        else {
            console.log('PASS: isThinkingEnabled is true');
        }
        if (!view.thinkingToggleBtn.hasClass('is-active')) {
            console.error('FAIL: Button should have "is-active" class');
        }
        else {
            console.log('PASS: Button has "is-active" class');
        }
        if (view.thinkingToggleBtn.icon !== 'brain-circuit') {
            console.error(`FAIL: Icon should be "brain-circuit", got "${view.thinkingToggleBtn.icon}"`);
        }
        else {
            console.log('PASS: Icon is "brain-circuit"');
        }
        console.log('\n--- Test 2: Start New Chat with enableThinking = FALSE ---');
        plugin.settings.enableThinking = false;
        yield view.startNewChat();
        if (view.isThinkingEnabled !== false) {
            console.error('FAIL: isThinkingEnabled should be false');
        }
        else {
            console.log('PASS: isThinkingEnabled is false');
        }
        if (view.thinkingToggleBtn.hasClass('is-active')) {
            console.error('FAIL: Button should NOT have "is-active" class');
        }
        else {
            console.log('PASS: Button does not have "is-active" class');
        }
        if (view.thinkingToggleBtn.icon !== 'brain') {
            console.error(`FAIL: Icon should be "brain", got "${view.thinkingToggleBtn.icon}"`);
        }
        else {
            console.log('PASS: Icon is "brain"');
        }
    });
}
runTests().catch(e => console.error(e));
