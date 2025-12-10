// Mocking the basics required for the test
class MockApp {
    constructor() {
        this.vault = {
            readBinary: async () => new ArrayBuffer(10)
        };
    }
}
class MockTFile {
    constructor() {
        this.basename = "test.png";
        this.extension = "png";
        this.stat = { mtime: 12345 };
        this.path = "test.png";
    }
}
// Mock requestUrl
let mockResponseHeaders = {};
async function mockRequestUrl(options) {
    if (options.url.includes('upload/v1beta/files')) {
        return {
            status: 200,
            text: 'OK',
            headers: mockResponseHeaders,
            json: {}
        };
    }
    // upload bytes
    if (options.url === 'http://upload-url') {
        return {
            status: 200,
            json: { file: { uri: 'file-uri', name: 'files/123' } }
        };
    }
    // wait processing
    if (options.url.includes('files/123')) {
        return {
            status: 200,
            json: { state: 'ACTIVE' }
        };
    }
    return { status: 404 };
}
// Partial implementation of GeminiFileManager to test the fix
class TestGeminiFileManager {
    constructor(app) {
        this.fileCache = new Map();
        this.explicitCache = new Map();
        this.app = app;
    }
    // COPY OF THE METHOD TO BE FIXED (plus the fix)
    getHeader(headers, key) {
        const lowerKey = key.toLowerCase();
        for (const k in headers) {
            if (k.toLowerCase() === lowerKey) {
                return headers[k];
            }
        }
        return undefined;
    }
    getMimeType(ext) { return 'image/png'; }
    async waitForProcessing() { return; }
    async uploadFile(file, apiKey) {
        // ... simplified logic from original file ...
        const content = await this.app.vault.readBinary(file);
        const numBytes = content.byteLength;
        const mimeType = 'image/png';
        // 1. Initial Resumable Request
        // We mock requestUrl globally for this test context
        const initialResponse = await mockRequestUrl({
            url: `https://generativelanguage.googleapis.com/upload/v1beta/files`
        });
        // --- THE FIX ---
        // Original: let uploadUrl = initialResponse.headers['x-goog-upload-url'];
        let uploadUrl = this.getHeader(initialResponse.headers, 'x-goog-upload-url');
        // ----------------
        if (!uploadUrl) {
            throw new Error('Failed to get upload URL from response headers');
        }
        return uploadUrl;
    }
}
async function runTest() {
    const app = new MockApp();
    const manager = new TestGeminiFileManager(app);
    const file = new MockTFile();
    console.log("Test 1: Header is lowercase 'x-goog-upload-url'");
    mockResponseHeaders = { 'x-goog-upload-url': 'http://upload-url' };
    try {
        const url = await manager.uploadFile(file, 'api-key');
        console.log(`PASS: Found url: ${url}`);
    }
    catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
    console.log("\nTest 2: Header is Mixed-Case 'X-Goog-Upload-URL' (Android scenario)");
    mockResponseHeaders = { 'X-Goog-Upload-URL': 'http://upload-url' };
    try {
        const url = await manager.uploadFile(file, 'api-key');
        console.log(`PASS: Found url: ${url}`);
    }
    catch (e) {
        console.error(`FAIL: ${e.message}`);
    }
}
runTest();
