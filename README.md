# Gemini Copilot for Obsidian

Gemini Copilot is an Obsidian plugin that sends selected notes, PDFs, images, audio, video, and prompt text to Google's Gemini API and displays the response in a chat view.

## Features

- Chat with Gemini from an Obsidian side view.
- Include the active note as context.
- Attach vault files such as Markdown, text, PDFs, images, audio, and video.
- Paste images into the chat context.
- Save chat history as Markdown files in the vault.
- Optional Google Search grounding and URL context tools.

## Privacy and external services

This plugin uses Google's Gemini API. When you send a message, the plugin may transmit the following to Google:

- Your prompt text.
- The active note content when active-note context is enabled.
- Attached text note contents.
- Uploaded media files such as PDFs, images, audio, and video.
- Linked note contents for `[[note]]` links typed in the prompt.
- URLs in your prompt when URL context is enabled.

Google Search grounding and URL context are disabled by default. Enable them only if you want Gemini to use those tools.

No hidden telemetry is collected by this plugin. Your API key is stored using Obsidian plugin data storage.

## Development

Install dependencies:

```bash
npm install
```

Run a production build:

```bash
npm run build
```

Run the watch build during development:

```bash
npm run dev
```

Release artifacts are `main.js`, `manifest.json`, and `styles.css`.
