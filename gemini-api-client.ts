import { requestUrl } from "obsidian";
import { GeminiChatMessage, GeminiPluginSettings } from "./types";

export class GeminiApiClient {
    
    async generateContent(
        history: GeminiChatMessage[], 
        modelName: string, 
        settings: GeminiPluginSettings,
        signal?: AbortSignal
    ): Promise<GeminiChatMessage> {
        const { apiKey, thinkingLevel, enableGoogleSearch, enableUrlContext } = settings;
        
        const isGemini3 = modelName.includes('gemini-3');
        const apiVersion = isGemini3 ? 'v1alpha' : 'v1beta';
        const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent`;

        // Format history for API
        const contents = history.map(msg => {
            // Reconstruct parts, ensuring thoughtSignature is included if present
            const parts = msg.parts ? [...msg.parts] : [{ text: msg.content }];
            return {
                role: msg.role,
                parts: parts
            };
        });

        const tools: any[] = [];
        if (enableGoogleSearch) {
            tools.push({ google_search: {} });
        }
        if (enableUrlContext) {
            tools.push({ url_context: {} });
        }

        const body: any = {
            contents: contents,
            generationConfig: {}
        };

        // Thinking Config
        if (isGemini3) {
            // Gemini 3: thinking_config with include_thoughts and thinking_level
            body.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: thinkingLevel
            };
        } else {
            // Gemini 2.5: Always enable dynamic thinking (-1) for models that support it
            body.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: -1 
            };
        }

        // Tools cannot be used in generateContent when cachedContent is present
        if (tools.length > 0) {
            body.tools = tools;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body),
            signal: signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API Error Body:', errorText);
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        
        // Extract parts from response
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
            const candidate = data.candidates[0];
            const content = candidate.content;
            const usageMetadata = data.usageMetadata;
            const groundingMetadata = candidate.groundingMetadata;
            
            const contentParts = content.parts.filter((p: any) => !p.thought);
            const thoughtParts = content.parts.filter((p: any) => p.thought === true);
            
            // Extract Thought Text
            let thoughtText = "";
            if (thoughtParts.length > 0) {
                thoughtText = thoughtParts.map((p: any) => p.text).join('\n\n');
            }

            // Extract Response Text
            let responseContent = "";
            if (contentParts.length > 0) {
                responseContent = contentParts.map((p: any) => p.text).join('\n\n');
            } else if (thoughtParts.length > 0) {
                 responseContent = "(Thinking process only, no final response generated)";
            } else {
                responseContent = "(No response content generated)";
            }

            // Extract Thought Signature
            let thoughtSignature: string | undefined;
            for (const part of content.parts) {
                if (part.thoughtSignature) {
                    thoughtSignature = part.thoughtSignature;
                    break; 
                }
            }

            // Add citations if grounding metadata exists
            if (groundingMetadata) {
                 responseContent = this.addCitations(responseContent, groundingMetadata);
            }
            
            return {
                role: 'model',
                content: responseContent,
                parts: content.parts, 
                thought: thoughtText,
                thoughtSignature: thoughtSignature,
                usageMetadata: usageMetadata,
                groundingMetadata: groundingMetadata
            };
        } else {
            return {
                role: 'model',
                content: "(No response content generated)",
                parts: [{ text: "(No response content generated)" }]
            };
        }
    }

    async countTokens(contents: any[], modelName: string, apiKey: string): Promise<{ totalTokens: number }> {
        // Use v1beta for countTokens as it's stable there
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:countTokens`;

        const response = await requestUrl({
            url: url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({ contents: contents }),
            throw: false
        });

        if (response.status >= 400) {
             throw new Error(`CountTokens API Error ${response.status}: ${response.text}`);
        }

        return response.json;
    }

    private addCitations(text: string, groundingMetadata: any): string {
        if (!groundingMetadata || !groundingMetadata.groundingSupports || !groundingMetadata.groundingChunks) {
            return text;
        }

        const supports = groundingMetadata.groundingSupports;
        const chunks = groundingMetadata.groundingChunks;
        
        // Sort supports by end_index in descending order
        const sortedSupports = [...supports].sort((a: any, b: any) => {
             const endA = a.segment?.endIndex || 0;
             const endB = b.segment?.endIndex || 0;
             return endB - endA;
        });

        let newText = text;

        for (const support of sortedSupports) {
            const endIndex = support.segment?.endIndex;
            const indices = support.groundingChunkIndices;

            if (endIndex === undefined || !indices || indices.length === 0) {
                continue;
            }

            const validIndices = indices.filter((i: number) => i >= 0 && i < chunks.length);
            if (validIndices.length === 0) continue;

            const citationLinks = validIndices.map((i: number) => {
                const chunk = chunks[i];
                const uri = chunk.web?.uri;
                const title = chunk.web?.title || "Source";
                if (uri) {
                    return `[${i + 1}](${uri} "${title}")`;
                }
                return `[${i + 1}]`;
            });

            const citationString = " " + citationLinks.join(""); 
            
            if (endIndex <= newText.length) {
                 newText = newText.slice(0, endIndex) + citationString + newText.slice(endIndex);
            }
        }
        
        return newText;
    }
}
