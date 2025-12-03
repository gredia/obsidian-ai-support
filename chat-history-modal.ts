import { App, FuzzySuggestModal, TFile } from "obsidian";

type HistoryItem = { type: 'file', file: TFile } | { type: 'new' };

export class ChatHistoryModal extends FuzzySuggestModal<HistoryItem> {
    private onChoose: (item: HistoryItem) => void;
    private chatFiles: TFile[];

    constructor(
        app: App,
        chatFiles: TFile[],
        onChoose: (item: HistoryItem) => void
    ) {
        super(app);
        this.chatFiles = chatFiles;
        this.onChoose = onChoose;
    }

    getItems(): HistoryItem[] {
        const items: HistoryItem[] = [];
        
        // Add "New Chat" option at the top
        items.push({ type: 'new' });

        // Add files
        const sortedFiles = this.chatFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
        sortedFiles.forEach(file => items.push({ type: 'file', file }));

        return items;
    }

    getItemText(item: HistoryItem): string {
        if (item.type === 'new') {
            return '＋ Start New Chat';
        }
        const file = item.file;
        const date = new Date(file.stat.mtime).toLocaleString();
        return `${file.basename} (${date})`;
    }

    onChooseItem(item: HistoryItem, _evt: MouseEvent | KeyboardEvent) {
        this.onChoose(item);
    }
}