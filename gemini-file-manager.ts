import { App, TFile, requestUrl } from "obsidian";

export class GeminiFileManager {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    async uploadFile(file: TFile, apiKey: string): Promise<string> {
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
        const cleanApiKey = apiKey.trim();

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

            let uploadUrl = initialResponse.headers['x-goog-upload-url'];
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

            return fileUri;

        } catch (error) {
            console.error("File upload error:", error);
            throw error;
        }
    }

    async waitForProcessing(fileName: string, apiKey: string): Promise<void> {
        const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}`;
        let state = 'PROCESSING';
        
        // Poll for up to 60 seconds (video processing can take time)
        for (let i = 0; i < 12; i++) {
            try {
                const response = await requestUrl({
                    url: url,
                    method: 'GET',
                    headers: { 'x-goog-api-key': apiKey }
                });
                
                if (response.status >= 400) {
                    throw new Error(`Failed to check file state: ${response.status}`);
                }

                const data = response.json;
                state = data.state || 'PROCESSING'; // Default to processing if not set

                console.log(`File ${fileName} state: ${state}`);

                if (state === 'ACTIVE') {
                    return; // Ready!
                } else if (state === 'FAILED') {
                    throw new Error(`File processing failed: ${data.error?.message || 'Unknown error'}`);
                }

                // Wait 5 seconds before next check
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (e) {
                console.warn(`Error checking file state (attempt ${i+1}):`, e);
                // Continue retrying unless it's a fatal error? 
                // If 404 maybe wait? If 403? 
                // For now, just wait and retry.
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
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
            'aac': 'audio/wav', // mime type varies
            'mp4': 'video/mp4',
            'mpeg': 'video/mpeg',
            'mov': 'video/quicktime',
            'avi': 'video/x-msvideo',
            'flv': 'video/x-msvideo',
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
}
