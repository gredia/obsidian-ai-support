import { requestUrl } from "obsidian";
import { GeminiChatMessage, GeminiPluginSettings } from "./types";

export class GeminiApiClient {
    private toThinkingLevel(value: GeminiPluginSettings["thinkingLevel"], modelName: string): string {
        const supportedLevels = this.getSupportedThinkingLevels(modelName);
        const normalizedValue = supportedLevels.includes(value) ? value : supportedLevels[supportedLevels.length - 1];

        const map: Record<GeminiPluginSettings["thinkingLevel"], string> = {
            minimal: "MINIMAL",
            low: "LOW",
            medium: "MEDIUM",
            high: "HIGH"
        };
        return map[normalizedValue] ?? "HIGH";
    }

    private getSupportedThinkingLevels(modelName: string): GeminiPluginSettings["thinkingLevel"][] {
        if (modelName === "gemini-3.1-pro-preview" || modelName.includes("gemini-2.5")) {
            return ["low", "medium", "high"];
        }
        return ["minimal", "low", "medium", "high"];
    }

    private toMediaResolution(value: GeminiPluginSettings["mediaResolution"]): string | null {
        if (value === "auto") {
            return null;
        }

        const map: Record<Exclude<GeminiPluginSettings["mediaResolution"], "auto">, string> = {
            low: "MEDIA_RESOLUTION_LOW",
            medium: "MEDIA_RESOLUTION_MEDIUM",
            high: "MEDIA_RESOLUTION_HIGH"
        };
        return map[value];
    }

    async generateContent(
        history: GeminiChatMessage[], 
        modelName: string, 
        settings: GeminiPluginSettings,
        signal?: AbortSignal,
        cachedContentName?: string,
        enableThinkingOverride?: boolean,
        validFileUris?: Set<string>
    ): Promise<GeminiChatMessage> {
        const { apiKey, thinkingLevel, enableGoogleSearch, enableUrlContext, mediaResolution } = settings;
        
        const isGemini3 = modelName.includes('gemini-3');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

        // Format history for API
        const contents = history.map(msg => {
            // Reconstruct parts, ensuring thoughtSignature is included if present
            let parts = msg.parts && msg.parts.length > 0 ? [...msg.parts] : [{ text: msg.content }];
            if (validFileUris) {
                parts = parts.filter((part: any) => !part.file_data || validFileUris.has(part.file_data.file_uri));
                if (parts.length === 0) {
                    parts = [{ text: "[Attached file expired]" }];
                }
            }
            return {
                role: msg.role,
                parts: parts
            };
        }).filter(content => content.parts.length > 0);

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

        if (cachedContentName) {
            body.cachedContent = cachedContentName;
        }

        const mediaResolutionValue = this.toMediaResolution(mediaResolution);
        if (mediaResolutionValue) {
            body.generationConfig.mediaResolution = mediaResolutionValue;
        }

        // Thinking Config
        if (isGemini3) {
            // Gemini 3: thinking_config with include_thoughts and thinking_level
            body.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: this.toThinkingLevel(thinkingLevel, modelName)
            };
        } else {
            // Gemini 2.5: Check override first, then settings
            const shouldUseThinking = enableThinkingOverride !== undefined ? enableThinkingOverride : settings.enableThinking;

            if (shouldUseThinking) {
                // Enable dynamic thinking (-1)
                body.generationConfig.thinkingConfig = {
                    includeThoughts: true,
                    thinkingBudget: -1
                };
            }
            // If false, do NOT include thinkingConfig
        }

        // Tools cannot be used in generateContent when cachedContent is present
        // They must be defined in the CachedContent resource itself
        if (tools.length > 0 && !cachedContentName) {
            body.tools = tools;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey.trim()
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
            
            const responseParts = Array.isArray(content.parts) ? content.parts : [];
            const contentParts = responseParts.filter((p: any) => !p.thought);
            const thoughtParts = responseParts.filter((p: any) => p.thought === true);
            
            // Extract Thought Text
            let thoughtText = "";
            if (thoughtParts.length > 0) {
                thoughtText = thoughtParts.map((p: any) => p.text).filter(Boolean).join('\n\n');
            }

            // Extract Response Text
            const responseTexts = contentParts.map((p: any) => p.text).filter(Boolean);
            let responseContent = "";
            if (responseTexts.length > 0) {
                responseContent = responseTexts.join('\n\n');
            } else if (thoughtParts.length > 0) {
                 responseContent = "(Thinking process only, no final response generated)";
            } else {
                responseContent = "(No response content generated)";
            }

            // Extract Thought Signature
            let thoughtSignature: string | undefined;
            for (const part of responseParts) {
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
                parts: responseParts,
                thought: thoughtText,
                thoughtSignature: thoughtSignature,
                usageMetadata: usageMetadata,
                groundingMetadata: groundingMetadata
            };
        } else {
            const blockReason = data.promptFeedback?.blockReason;
            const blockMessage = blockReason ? ` (blocked: ${blockReason})` : "";
            return {
                role: 'model',
                content: `(No response content generated${blockMessage})`,
                parts: [{ text: `(No response content generated${blockMessage})` }]
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
                'x-goog-api-key': apiKey.trim()
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
