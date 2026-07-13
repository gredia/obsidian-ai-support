export interface ChatHistoryTitleContext {
    fileNames: string[];
    title: string;
}

const MAX_FILE_LIST_BYTES = 100;
const MAX_TITLE_BYTES = 100;

function sanitizeTitlePart(value: string): string {
    return value
        .replace(/\s+/g, " ")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
        .trim()
        .replace(/[. ]+$/g, "");
}

function truncateUtf8(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).byteLength <= maxBytes) {
        return value;
    }

    const suffix = "...";
    const contentLimit = maxBytes - encoder.encode(suffix).byteLength;
    let result = "";
    for (const character of value) {
        if (encoder.encode(result + character).byteLength > contentLimit) {
            break;
        }
        result += character;
    }
    return result + suffix;
}

export function buildChatHistoryTitleContext(promptText: string, fileNames: string[]): ChatHistoryTitleContext {
    const uniqueFileNames = Array.from(new Set(
        fileNames
            .map(name => sanitizeTitlePart(name).replace(/[\[\]]/g, ""))
            .filter(Boolean)
    ));
    const title = sanitizeTitlePart(promptText) || "Chat";

    return { fileNames: uniqueFileNames, title };
}

export function formatChatHistoryDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function findNextChatHistorySequence(fileBaseNames: string[], date: string): number {
    const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sequencePattern = new RegExp(`\\[${escapedDate}-(\\d{3,})\\]`);
    const usedSequences = new Set<number>();

    for (const fileBaseName of fileBaseNames) {
        const match = fileBaseName.match(sequencePattern);
        if (match) {
            usedSequences.add(Number(match[1]));
        }
    }

    let sequence = 0;
    while (usedSequences.has(sequence)) {
        sequence++;
    }
    return sequence;
}

export function formatChatHistoryBaseName(
    context: ChatHistoryTitleContext,
    date: Date,
    sequence: number
): string {
    const fileList = truncateUtf8(context.fileNames.join(","), MAX_FILE_LIST_BYTES);
    const title = truncateUtf8(context.title || "Chat", MAX_TITLE_BYTES);
    const sequenceText = String(Math.max(0, Math.floor(sequence))).padStart(3, "0");
    return `[${fileList}][${formatChatHistoryDate(date)}-${sequenceText}]${title}`;
}
