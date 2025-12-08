import { App, requestUrl } from "obsidian";

export interface CacheConfig {
    model: string;
    contents: any[]; // genai.Content objects
    ttl?: string; // e.g. "300s"
    expireTime?: string; // RFC 3339 timestamp
    systemInstruction?: any;
    displayName?: string;
}

export interface CachedContent {
    name: string;
    displayName?: string;
    model: string;
    createTime: string;
    updateTime: string;
    expireTime: string;
    ttl?: string; // Input only, but sometimes returned?
    usageMetadata?: {
        totalTokenCount: number;
    };
}

export class GeminiCacheManager {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    private getBaseUrl(apiVersion: string = 'v1beta'): string {
        return `https://generativelanguage.googleapis.com/${apiVersion}/cachedContents`;
    }

    async createCache(apiKey: string, config: CacheConfig): Promise<CachedContent> {
        // Determine API version based on model
        const isGemini3 = config.model.includes('gemini-3');
        const apiVersion = isGemini3 ? 'v1alpha' : 'v1beta';
        const url = this.getBaseUrl(apiVersion);
        
        try {
            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    'x-goog-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(config)
            });

            if (response.status >= 400) {
                throw new Error(`Failed to create cache: ${response.status} ${response.text}`);
            }

            return response.json;
        } catch (error) {
            console.error("Cache creation error:", error);
            throw error;
        }
    }

    async listCaches(apiKey: string): Promise<CachedContent[]> {
        const url = this.getBaseUrl();
        
        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'x-goog-api-key': apiKey
                }
            });

            if (response.status >= 400) {
                throw new Error(`Failed to list caches: ${response.status} ${response.text}`);
            }

            const data = response.json;
            return data.cachedContents || [];
        } catch (error) {
            console.error("Cache list error:", error);
            throw error;
        }
    }

    async getCache(apiKey: string, name: string): Promise<CachedContent> {
        // name should be in format "cachedContents/..."
        const url = `https://generativelanguage.googleapis.com/v1beta/${name}`;
        
        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'x-goog-api-key': apiKey
                }
            });

            if (response.status >= 400) {
                throw new Error(`Failed to get cache ${name}: ${response.status} ${response.text}`);
            }

            return response.json;
        } catch (error) {
            console.error(`Cache get error for ${name}:`, error);
            throw error;
        }
    }

    async updateCache(apiKey: string, name: string, ttl?: string, expireTime?: string): Promise<CachedContent> {
        const url = `https://generativelanguage.googleapis.com/v1beta/${name}`;
        
        const body: any = {};
        if (ttl) body.ttl = ttl;
        if (expireTime) body.expireTime = expireTime;

        if (Object.keys(body).length === 0) {
            throw new Error("Update cache requires either ttl or expireTime");
        }

        try {
            const response = await requestUrl({
                url: url,
                method: 'PATCH',
                headers: {
                    'x-goog-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.status >= 400) {
                throw new Error(`Failed to update cache ${name}: ${response.status} ${response.text}`);
            }

            return response.json;
        } catch (error) {
            console.error(`Cache update error for ${name}:`, error);
            throw error;
        }
    }

    async deleteCache(apiKey: string, name: string): Promise<void> {
         const url = `https://generativelanguage.googleapis.com/v1beta/${name}`;
        
        try {
            const response = await requestUrl({
                url: url,
                method: 'DELETE',
                headers: {
                    'x-goog-api-key': apiKey
                },
                throw: false
            });

            if (response.status >= 400 && response.status !== 404) {
                 console.warn(`Failed to delete cache ${name}: ${response.status}`);
            }
        } catch (error) {
            console.warn(`Failed to delete cache ${name}:`, error);
            // Best effort
        }
    }
}