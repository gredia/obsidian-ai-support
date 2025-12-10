export class MockApp {
    vault = { getResourcePath: () => '' };
    workspace = { getActiveFile: () => null, on: () => {} };
}

export class MockPlugin {
    app = new MockApp();
    settings = { 
        enableThinking: false, 
        modelName: 'gemini-2.5-pro',
        chatHistoryFolder: 'Gemini Chats',
        apiKey: 'test-key',
        mediaResolution: 'auto'
    };
}

export class MockHTMLElement {
    classes = new Set<string>();
    children: any[] = [];
    style: any = {};
    icon: string = '';
    
    constructor() {}

    createDiv(options?: any) { 
        const el = new MockHTMLElement();
        if (options?.cls) options.cls.split(' ').forEach((c:string) => el.addClass(c));
        this.children.push(el);
        return el; 
    }
    
    createEl(tag: string, options?: any) { 
        const el = new MockHTMLElement();
        if (options?.cls) options.cls.split(' ').forEach((c:string) => el.addClass(c));
        this.children.push(el);
        return el; 
    }

    empty() { this.children = []; }
    addClass(c: string) { this.classes.add(c); }
    removeClass(c: string) { this.classes.delete(c); }
    toggleClass(c: string, b: boolean) { if (b) this.addClass(c); else this.removeClass(c); }
    hasClass(c: string) { return this.classes.has(c); }
    onClickEvent(cb: any) { }
    setAttribute(k: string, v: string) {}
}

export function setIcon(el: any, icon: string) { el.icon = icon; }

export class DropdownComponent {
    selectEl = new MockHTMLElement();
    constructor(container: any) {}
    addOption() { return this; }
    setValue() { return this; }
    onChange() { return this; }
}

export class TextAreaComponent {
    inputEl = { addEventListener: () => {}, rows: 0, classList: { add: () => {} } };
    constructor(container: any) {}
    setValue() {}
    setPlaceholder() {}
}

export class ButtonComponent {
    buttonEl = { style: {} };
    constructor(container: any) {}
    setIcon() { return this; }
    setClass() { return this; }
    onClick() { return this; }
    setButtonText() { return this; }
    setCta() { return this; }
}

export const GEMINI_MODELS = [
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
];

export class Notice {
    constructor(msg: string) { console.log('Notice:', msg); }
}
