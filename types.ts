export interface GeminiPluginSettings {
    apiKey: string;
    modelName: string;
    thinkingLevel: 'low' | 'high';
    enableThinking: boolean; // For Gemini 2.5 models
    chatHistoryFolder: string;
    enableGoogleSearch: boolean;
    enableUrlContext: boolean;
    mediaResolution: 'auto' | 'low' | 'medium' | 'high';
}

export interface GeminiChatMessage {
    role: 'user' | 'model';
    content: string;
    parts?: any[];
    thought?: string; // The text content of the thinking process
    thoughtSignature?: string; // The encrypted signature for context
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    groundingMetadata?: any;
    images?: string[]; // Resource paths for display
    timestamp?: number;
}
