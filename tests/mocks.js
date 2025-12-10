"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Notice = exports.GEMINI_MODELS = exports.ButtonComponent = exports.TextAreaComponent = exports.DropdownComponent = exports.setIcon = exports.MockHTMLElement = exports.MockPlugin = exports.MockApp = void 0;
class MockApp {
    constructor() {
        this.vault = { getResourcePath: () => '' };
        this.workspace = { getActiveFile: () => null, on: () => { } };
    }
}
exports.MockApp = MockApp;
class MockPlugin {
    constructor() {
        this.app = new MockApp();
        this.settings = {
            enableThinking: false,
            modelName: 'gemini-2.5-pro',
            chatHistoryFolder: 'Gemini Chats',
            apiKey: 'test-key',
            mediaResolution: 'auto'
        };
    }
}
exports.MockPlugin = MockPlugin;
class MockHTMLElement {
    constructor() {
        this.classes = new Set();
        this.children = [];
        this.style = {};
        this.icon = '';
    }
    createDiv(options) {
        const el = new MockHTMLElement();
        if (options === null || options === void 0 ? void 0 : options.cls)
            options.cls.split(' ').forEach((c) => el.addClass(c));
        this.children.push(el);
        return el;
    }
    createEl(tag, options) {
        const el = new MockHTMLElement();
        if (options === null || options === void 0 ? void 0 : options.cls)
            options.cls.split(' ').forEach((c) => el.addClass(c));
        this.children.push(el);
        return el;
    }
    empty() { this.children = []; }
    addClass(c) { this.classes.add(c); }
    removeClass(c) { this.classes.delete(c); }
    toggleClass(c, b) { if (b)
        this.addClass(c);
    else
        this.removeClass(c); }
    hasClass(c) { return this.classes.has(c); }
    onClickEvent(cb) { }
    setAttribute(k, v) { }
}
exports.MockHTMLElement = MockHTMLElement;
function setIcon(el, icon) { el.icon = icon; }
exports.setIcon = setIcon;
class DropdownComponent {
    constructor(container) {
        this.selectEl = new MockHTMLElement();
    }
    addOption() { return this; }
    setValue() { return this; }
    onChange() { return this; }
}
exports.DropdownComponent = DropdownComponent;
class TextAreaComponent {
    constructor(container) {
        this.inputEl = { addEventListener: () => { }, rows: 0, classList: { add: () => { } } };
    }
    setValue() { }
    setPlaceholder() { }
}
exports.TextAreaComponent = TextAreaComponent;
class ButtonComponent {
    constructor(container) {
        this.buttonEl = { style: {} };
    }
    setIcon() { return this; }
    setClass() { return this; }
    onClick() { return this; }
    setButtonText() { return this; }
    setCta() { return this; }
}
exports.ButtonComponent = ButtonComponent;
exports.GEMINI_MODELS = [
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
];
class Notice {
    constructor(msg) { console.log('Notice:', msg); }
}
exports.Notice = Notice;
