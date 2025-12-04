import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";

export interface ChatMessage {
    role: "user" | "model";
    content: string;
}

export class ChatHistoryService {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    async getLatestChatFile(folderPath: string): Promise<TFile | null> {
        const files = await this.getChatFiles(folderPath);
        return files.length > 0 ? files[0] : null;
    }

    async getChatFiles(folderPath: string): Promise<TFile[]> {
        const normalizedFolder = normalizePath(folderPath);
        const folder = this.app.vault.getAbstractFileByPath(normalizedFolder);

        if (!(folder instanceof TFolder)) {
            return [];
        }

        return folder.children
            .filter((f): f is TFile => f instanceof TFile && f.extension === "md")
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    async loadChat(file: TFile): Promise<ChatMessage[]> {
        try {
            const content = await this.app.vault.read(file);
            return this.parseChatContent(content);
        } catch (error) {
            console.error(`Failed to read chat history from ${file.path}:`, error);
            return [];
        }
    }

    async saveChat(folderPath: string, messages: ChatMessage[], fileName?: string, firstUserMessageContent?: string): Promise<string> {
        const normalizedFolder = normalizePath(folderPath);
        
        // Ensure folder exists
        if (!this.app.vault.getAbstractFileByPath(normalizedFolder)) {
            await this.app.vault.createFolder(normalizedFolder);
        }

        const chatContent = this.formatChatContent(messages);
        
        let targetFile: TFile | null = null;
        let targetPath = "";

        if (fileName) {
            targetPath = normalizePath(`${normalizedFolder}/${fileName}`);
            targetFile = this.app.vault.getAbstractFileByPath(targetPath) as TFile;
        } else {
            // Generate new filename based on first user message content or timestamp
            let baseName = "";
            if (firstUserMessageContent) {
                baseName = this.sanitizeFilename(firstUserMessageContent);
                if (baseName.length > 50) {
                    baseName = baseName.substring(0, 50) + "...";
                }
                // Ensure uniqueness if a file with this name already exists
                let counter = 0;
                let uniqueBaseName = baseName;
                while (this.app.vault.getAbstractFileByPath(normalizePath(`${normalizedFolder}/${uniqueBaseName}.md`))) {
                    counter++;
                    uniqueBaseName = `${baseName}-${counter}`;
                }
                baseName = uniqueBaseName;

            } else {
                const dateStr = new Date().toISOString().replace(/[:\.]/g, "-").slice(0, 19);
                baseName = `Chat ${dateStr}`;
            }
            targetPath = normalizePath(`${normalizedFolder}/${baseName}.md`);
        }

        const fileContent = this.generateNoteContent(chatContent);

        try {
            if (targetFile) {
                await this.app.vault.modify(targetFile, fileContent);
            } else {
                targetFile = await this.app.vault.create(targetPath, fileContent);
            }
            return targetFile.name;
        } catch (error) {
            console.error(`Failed to save chat to ${targetPath}:`, error);
            new Notice(`Failed to save chat: ${error.message}`);
            throw error;
        }
    }

    private sanitizeFilename(name: string): string {
        // Remove invalid characters for filenames and replace spaces with dashes
        return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s/g, ' ').trim();
    }

    private generateNoteContent(chatContent: string): string {
        const epoch = Date.now();
        return `--- 
epoch: ${epoch}
modelKey: "gemini"
tags:
  - gemini-chat
---

${chatContent}`;
    }

    private formatChatContent(messages: ChatMessage[]): string {
        return messages.map(msg => {
            const role = msg.role === 'user' ? 'user' : 'ai'; // Map model to ai for compatibility
            const timestamp = new Date().toLocaleString(); // We might want to store actual timestamp in message if available
            return `**${role}**: ${msg.content}\n[Timestamp: ${timestamp}]`;
        }).join('\n\n');
    }

    private parseChatContent(content: string): ChatMessage[] {
        const messages: ChatMessage[] = [];
        
        // Strip frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let chatContent = content;
        if (frontmatterMatch) {
            chatContent = content.slice(frontmatterMatch[0].length).trim();
        }

        // Regex to match **role**: content
        // Matches **user**: or **ai**: followed by content until the next **role**: or end of string
        const messagePattern = /\*\*(user|ai)\*\*: ([\s\S]*?)(?=(?:\n\n\*\*(?:user|ai)\*\*: )|$)/g;

        let match;
        while ((match = messagePattern.exec(chatContent)) !== null) {
            const role = match[1] === 'ai' ? 'model' : 'user';
            let text = match[2].trim();
            
            // Remove Timestamp line if present at the end
            const timestampRegex = /\n\[Timestamp: .*?\]$/;
            text = text.replace(timestampRegex, '').trim();

            messages.push({ role: role as 'user' | 'model', content: text });
        }

        return messages;
    }
}