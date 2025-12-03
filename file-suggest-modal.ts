import { App, FuzzySuggestModal, TFile } from "obsidian";

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    getItems(): TFile[] {
        const supportedExtensions = new Set([
            'md', 'txt', 'csv', 'js', 'py', 'html', 'css', 'xml', 'json', // Text
            'png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', // Images
            'pdf', // Documents
            'mp3', 'wav', 'aac', 'mp4', 'mpeg', 'mov', 'avi', 'flv', 'mpg', 'webm', 'wmv', '3gpp' // Audio/Video
        ]);
        return this.app.vault.getFiles().filter(f => supportedExtensions.has(f.extension.toLowerCase()));
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent) {
        this.onChoose(file);
    }
}
