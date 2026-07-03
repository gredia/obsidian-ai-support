import { App, TFile, requestUrl } from "obsidian";

interface CachedFile {
    uri: string;
    mtime: number;
    uploadTime: number;
}

interface ExplicitCacheEntry {
    name: string;
    expireTime: string;
    modelName: string;
    fileUri: string;
}

export class GeminiFileManager {
    app: App;
    private fileCache: Map<string, CachedFile> = new Map();
    // Key: filePath + "::" + modelName
    private explicitCache: Map<string, ExplicitCacheEntry> = new Map();

    constructor(app: App) {
        this.app = app;
    }

    private getFileCacheKey(file: TFile, apiKey: string): string {
        return `${apiKey.trim()}::${file.path}`;
    }

    private getHeader(headers: Record<string, string>, key: string): string | undefined {
        const lowerKey = key.toLowerCase();
        for (const k in headers) {
            if (k.toLowerCase() === lowerKey) {
                return headers[k];
            }
        }
        return undefined;
    }

    async uploadFile(file: TFile, apiKey: string): Promise<string> {
        // --- Cache Check ---
        const now = Date.now();
        const cleanApiKey = apiKey.trim();
        const fileCacheKey = this.getFileCacheKey(file, cleanApiKey);
        const cached = this.fileCache.get(fileCacheKey);

        if (cached) {
            // Check if file has been modified since upload
            if (cached.mtime === file.stat.mtime) {
                // Check if file URI is still valid (Gemini files last 48h)
                // We use 47h to be safe
                const ageHours = (now - cached.uploadTime) / (1000 * 60 * 60);
                if (ageHours < 47) {
                    console.log(`Gemini: Using cached URI for ${file.basename}`);
                    return cached.uri;
                }
            }
        }
        // -------------------

        const mimeType = this.getMimeType(file.extension);
        if (!mimeType) {
            throw new Error(`Unsupported file type: ${file.extension}`);
        }

        const content = await this.app.vault.readBinary(file);
        const numBytes = content.byteLength;
        
        if (numBytes === 0) {
            throw new Error(`File ${file.basename} is empty.`);
        }

        const displayName = file.basename;
        // 1. Initial Resumable Request
        // Use v1beta for upload as per standard Gemini Files API
        const initialUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files`;
        
        try {
            const initialResponse = await requestUrl({
                url: initialUrl,
                method: 'POST',
                headers: {
                    'x-goog-api-key': cleanApiKey,
                    'X-Goog-Upload-Protocol': 'resumable',
                    'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': numBytes.toString(),
                    'X-Goog-Upload-Header-Content-Type': mimeType,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ file: { display_name: displayName } })
            });

            if (initialResponse.status >= 400) {
                throw new Error(`Initial upload failed: ${initialResponse.status} ${initialResponse.text}`);
            }

            let uploadUrl = this.getHeader(initialResponse.headers, 'x-goog-upload-url');
            if (!uploadUrl) {
                throw new Error('Failed to get upload URL from response headers');
            }
            uploadUrl = uploadUrl.trim(); // Critical: remove potential newlines

            console.log(`Gemini: Uploading ${numBytes} bytes to ${uploadUrl}`);

            // 2. Upload Actual Bytes
            const uploadResponse = await requestUrl({
                url: uploadUrl,
                method: 'POST', 
                headers: {
                    // 'Content-Length' is set automatically by requestUrl
                    'X-Goog-Upload-Offset': '0',
                    'X-Goog-Upload-Command': 'upload, finalize'
                },
                body: content
            });

            if (uploadResponse.status >= 400) {
                 throw new Error(`Bytes upload failed: ${uploadResponse.status} ${uploadResponse.text}`);
            }

            const fileInfo = uploadResponse.json;
            const fileUri = fileInfo.file.uri;
            const fileName = fileInfo.file.name;

            // 3. Wait for Processing (Critical for Video/Audio)
            await this.waitForProcessing(fileName, cleanApiKey);

            // --- Update Cache ---
            this.fileCache.set(fileCacheKey, {
                uri: fileUri,
                mtime: file.stat.mtime,
                uploadTime: Date.now()
            });
            // --------------------

            return fileUri;

        } catch (error) {
            console.error("File upload error:", error);
            throw error;
        }
    }

    /**
     * Ensures an explicit cache exists for the given file and model.
     * Returns the cache name if successful, or null if caching failed/skipped (e.g. file too small).
     */
    async ensureExplicitCache(
        file: TFile, 
        fileUri: string, 
        mimeType: string, 
        modelName: string, 
        apiKey: string,
        settings: { enableGoogleSearch: boolean, enableUrlContext: boolean } // Add settings
    ): Promise<string | null> {
        // Cache key should now include tool usage as it changes the cache definition
        const toolKey = `${settings.enableGoogleSearch ? 'G' : ''}${settings.enableUrlContext ? 'U' : ''}`;
        const cacheKey = `${apiKey.trim()}::${file.path}::${modelName}::${toolKey}`;
        
        const cached = this.explicitCache.get(cacheKey);
        
        // 1. Check if we have a valid cache in memory
        if (cached && cached.fileUri === fileUri) { // Ensure URI matches (re-upload invalidates old cache logic)
            const expireDate = new Date(cached.expireTime);
            // Add a buffer (e.g., 5 mins) to avoid using expiring cache
            if (expireDate.getTime() > Date.now() + 5 * 60 * 1000) {
                console.log(`Gemini: Using existing explicit cache ${cached.name} for ${modelName}`);
                return cached.name;
            } else {
                console.log(`Gemini: Explicit cache ${cached.name} expired or expiring soon.`);
                this.explicitCache.delete(cacheKey);
            }
        }

        // 2. Create new cache
        console.log(`Gemini: Creating explicit cache for ${file.basename} on ${modelName}...`);
        
        // Use v1beta for cachedContents even for gemini-3 models as per API docs
        const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents`;
        
        // Standardize model name for cache creation (must be "models/gemini-...")
        const fullModelName = modelName.startsWith('models/') ? modelName : `models/${modelName}`;

        const tools: any[] = [];
        if (settings.enableGoogleSearch) {
            tools.push({ google_search: {} });
        }
        if (settings.enableUrlContext) {
            tools.push({ url_context: {} });
        }

        const body: any = {
            model: fullModelName,
            contents: [{
                parts: [{
                    file_data: {
                        mime_type: mimeType,
                        file_uri: fileUri
                    }
                }],
                role: 'user'
            }],
            ttl: '3600s' // Default 1 hour
        };

        if (tools.length > 0) {
            body.tools = tools;
        }

        try {
            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey.trim()
                },
                body: JSON.stringify(body),
                throw: false // Handle errors manually
            });

            if (response.status >= 400) {
                const errorText = response.text;
                // If error is related to token count (InvalidArgument), log and return null
                // We assume 400 with "InvalidArgument" usually means < min tokens
                if (response.status === 400 && errorText.includes("InvalidArgument")) {
                    console.warn(`Gemini: Failed to cache ${file.basename} (likely too small): ${errorText}`);
                    return null;
                }
                throw new Error(`Cache creation failed ${response.status}: ${errorText}`);
            }

            const data = response.json;
            const cacheName = data.name;
            const expireTime = data.expireTime;

            console.log(`Gemini: Created explicit cache ${cacheName}`);

            this.explicitCache.set(cacheKey, {
                name: cacheName,
                expireTime: expireTime,
                modelName: modelName,
                fileUri: fileUri
            });

            return cacheName;

        } catch (error) {
            console.error("Explicit caching error:", error);
            return null; // Fallback to standard file usage
        }
    }

    async waitForProcessing(fileName: string, apiKey: string): Promise<void> {
        const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}`;
        const cleanApiKey = apiKey.trim();
        let state = 'PROCESSING';
        
        // Poll for up to 60 seconds (video processing can take time)
        for (let i = 0; i < 12; i++) {
            let data: any;
            try {
                const response = await requestUrl({
                    url: url,
                    method: 'GET',
                    headers: { 'x-goog-api-key': cleanApiKey }
                });
                
                if (response.status >= 400) {
                    console.warn(`Failed to check file state (attempt ${i + 1}): ${response.status}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }

                data = response.json;
            } catch (e) {
                console.warn(`Error checking file state (attempt ${i+1}):`, e);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }

            state = data.state || 'PROCESSING'; // Default to processing if not set

            console.log(`File ${fileName} state: ${state}`);

            if (state === 'ACTIVE') {
                return; // Ready!
            } else if (state === 'FAILED') {
                throw new Error(`File processing failed: ${data.error?.message || 'Unknown error'}`);
            }

            // Wait 5 seconds before next check
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        throw new Error('File processing timed out. Please try again later.');
    }

    getMimeType(extension: string): string | null {
        const map: Record<string, string> = {
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'webp': 'image/webp',
            'heic': 'image/heic',
            'heif': 'image/heif',
            'pdf': 'application/pdf',
            'txt': 'text/plain',
            'md': 'text/markdown',
            'csv': 'text/csv',
            'js': 'text/javascript',
            'py': 'text/x-python',
            'html': 'text/html',
            'css': 'text/css',
            'xml': 'text/xml',
            'json': 'application/json',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'aac': 'audio/aac',
            'mp4': 'video/mp4',
            'mpeg': 'video/mpeg',
            'mov': 'video/quicktime',
            'avi': 'video/x-msvideo',
            'flv': 'video/x-flv',
            'mpg': 'video/mpeg',
            'webm': 'video/webm',
            'wmv': 'video/x-ms-wmv',
            '3gpp': 'video/3gpp'
        };
        return map[extension.toLowerCase()] || null;
    }

    isMediaFile(file: TFile): boolean {
        const mime = this.getMimeType(file.extension);
        // Treat markdown/text as non-media (read directly) to save tokens/complexity, 
        // EXCEPT when user explicitly wants to treat them as files? 
        // For now: Images, Audio, Video, PDF are "Media" (upload). 
        // Text-based files are read directly into prompt context.
        if (!mime) return false;
        return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf';
    }

    isImage(file: TFile): boolean {
        const mime = this.getMimeType(file.extension);
        return mime ? mime.startsWith('image/') : false;
    }

    async validateRemoteFiles(apiKey: string): Promise<Set<string> | null> {
        const cleanApiKey = apiKey.trim();
        const remoteUris = new Set<string>();
        let pageToken = "";

        try {
            for (let page = 0; page < 10; page += 1) {
                const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
                const response = await requestUrl({
                    url: `https://generativelanguage.googleapis.com/v1beta/files?pageSize=100${tokenParam}`,
                    method: 'GET',
                    headers: { 'x-goog-api-key': cleanApiKey },
                    throw: false
                });

                if (response.status >= 400) {
                    console.warn(`Gemini: Failed to list files for cache validation: ${response.status}`);
                    return null;
                }

                const data = response.json;
                for (const file of data.files || []) {
                    if (file.uri) {
                        remoteUris.add(file.uri);
                    }
                }

                pageToken = data.nextPageToken || "";
                if (!pageToken) {
                    break;
                }
            }

            const apiKeyPrefix = `${cleanApiKey}::`;
            for (const [cacheKey, cached] of this.fileCache.entries()) {
                if (cacheKey.startsWith(apiKeyPrefix) && !remoteUris.has(cached.uri)) {
                    console.log(`Gemini: Removing stale file cache entry ${cacheKey}`);
                    this.fileCache.delete(cacheKey);
                }
            }

            return remoteUris;
        } catch (error) {
            console.error("Gemini: Remote file validation failed:", error);
            return null;
        }
    }
}
