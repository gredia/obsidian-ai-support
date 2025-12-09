import { GeminiPluginSettings } from "./types";

export const DEFAULT_SETTINGS: GeminiPluginSettings = {
    apiKey: '',
    modelName: 'gemini-3-pro-preview',
    thinkingLevel: 'high',
    enableThinking: false,
    chatHistoryFolder: 'Gemini Chats',
    enableGoogleSearch: false,
    enableUrlContext: false,
    mediaResolution: 'auto'
};

export const VIEW_TYPE_GEMINI_CHAT = 'gemini-chat-view';

export const GEMINI_MODELS = [
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' }
];
