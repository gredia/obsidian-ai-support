import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import {
    ChatHistoryTitleContext,
    buildChatHistoryTitleContext,
    findNextChatHistorySequence,
    formatChatHistoryBaseName,
    formatChatHistoryDate
} from "./chat-history-title";

export interface ChatMessage {
    role: "user" | "model";
    content: string;
    parts?: any[]; // For storing API parts including thoughtSignature
    thought?: string; // For storing thinking process text
    thoughtSignature?: string; // Explicitly store signature if extracted
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

    async saveChat(
        folderPath: string,
        messages: ChatMessage[],
        fileName?: string,
        titleContext?: ChatHistoryTitleContext
    ): Promise<string> {
        const normalizedFolder = normalizePath(folderPath);
        await this.ensureFolder(normalizedFolder);

        const chatContent = this.formatChatContent(messages);
        
        let targetFile: TFile | null = null;
        let targetPath = "";

        if (fileName) {
            targetPath = normalizePath(`${normalizedFolder}/${fileName}`);
            targetFile = this.app.vault.getAbstractFileByPath(targetPath) as TFile;
        } else {
            const now = new Date();
            const sequence = this.getNextDailySequence(normalizedFolder, formatChatHistoryDate(now));
            const context = titleContext ?? buildChatHistoryTitleContext("", []);
            const baseName = formatChatHistoryBaseName(context, now, sequence);
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

    async appendMessage(
        folderPath: string,
        fileName: string | null,
        message: ChatMessage,
        titleContext?: ChatHistoryTitleContext
    ): Promise<string> {
        const normalizedFolder = normalizePath(folderPath);
        await this.ensureFolder(normalizedFolder);

        let targetFile: TFile | null = null;
        if (fileName) {
            const targetPath = normalizePath(`${normalizedFolder}/${fileName}`);
            targetFile = this.app.vault.getAbstractFileByPath(targetPath) as TFile;
        }

        if (targetFile) {
            // Append
            const contentToAppend = "\n\n" + this.formatMessage(message);
            await this.app.vault.append(targetFile, contentToAppend);
            return targetFile.name;
        } else {
            // Create New
            return this.saveChat(folderPath, [message], undefined, titleContext);
        }
    }

    private getNextDailySequence(folderPath: string, date: string): number {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder)) {
            return 0;
        }

        const chatFileNames = folder.children
            .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
            .map(child => child.basename);
        return findNextChatHistorySequence(chatFileNames, date);
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const normalizedFolder = normalizePath(folderPath);
        const existing = this.app.vault.getAbstractFileByPath(normalizedFolder);
        if (existing instanceof TFolder) {
            return;
        }
        if (existing) {
            throw new Error(`Path exists and is not a folder: ${normalizedFolder}`);
        }

        const segments = normalizedFolder.split("/").filter(Boolean);
        let currentPath = "";
        for (const segment of segments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            const current = this.app.vault.getAbstractFileByPath(currentPath);
            if (current instanceof TFolder) {
                continue;
            }
            if (current) {
                throw new Error(`Path exists and is not a folder: ${currentPath}`);
            }
            await this.app.vault.createFolder(currentPath);
        }
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

    private formatMessage(msg: ChatMessage): string {
        const role = msg.role === 'user' ? 'user' : 'ai'; // Map model to ai for compatibility
        const timestamp = new Date().toLocaleString(); 
        
        // Serialize metadata (parts, thought, signature)
        const metadata: any = {};
        if (msg.parts) metadata.parts = msg.parts;
        if (msg.thought) metadata.thought = msg.thought;
        if (msg.thoughtSignature) metadata.thoughtSignature = msg.thoughtSignature;

        let textContent = `**${role}**: ${msg.content}\n[Timestamp: ${timestamp}]`;
        
        // Append metadata as hidden HTML comment if not empty
        if (Object.keys(metadata).length > 0) {
                // Base64 encode to avoid conflict with markdown syntax or comment terminators
                const json = JSON.stringify(metadata);
                const b64 = this.encodeBase64Utf8(json);
                textContent += `\n<!-- gemini-metadata: ${b64} -->`;
        }
        
        return textContent;
    }

    private formatChatContent(messages: ChatMessage[]): string {
        return messages.map(msg => this.formatMessage(msg)).join('\n\n');
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
            
            let parts: any[] | undefined;
            let thought: string | undefined;
            let thoughtSignature: string | undefined;

            // Extract Metadata Comment
            const metadataRegex = /\n<!-- gemini-metadata: (.*?) -->$/;
            const metadataMatch = text.match(metadataRegex);
            
            if (metadataMatch) {
                try {
                    const b64 = metadataMatch[1];
                    const json = this.decodeBase64Utf8(b64);
                    const metadata = JSON.parse(json);
                    
                    if (metadata.parts) parts = metadata.parts;
                    if (metadata.thought) thought = metadata.thought;
                    if (metadata.thoughtSignature) thoughtSignature = metadata.thoughtSignature;

                    // Remove metadata from display text
                    text = text.replace(metadataRegex, '').trim();
                } catch (e) {
                    console.error("Failed to parse gemini metadata:", e);
                }
            }

            // Remove Timestamp line if present at the end (after metadata removal)
            const timestampRegex = /\n\[Timestamp: .*?\]$/;
            text = text.replace(timestampRegex, '').trim();

            messages.push({ 
                role: role as 'user' | 'model', 
                content: text,
                parts: parts,
                thought: thought,
                thoughtSignature: thoughtSignature
            });
        }

        return messages;
    }

    private encodeBase64Utf8(value: string): string {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }

    private decodeBase64Utf8(value: string): string {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
    }
}
