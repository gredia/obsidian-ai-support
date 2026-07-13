import {
    buildChatHistoryTitleContext,
    findNextChatHistorySequence,
    formatChatHistoryBaseName
} from "../chat-history-title";

function assertEqual(actual: string | undefined, expected: string | undefined): void {
    if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertNumberEqual(actual: number, expected: number): void {
    if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
    }
}

const date = new Date(2026, 6, 13);

assertEqual(
    formatChatHistoryBaseName(buildChatHistoryTitleContext("Summarize this", []), date, 0),
    "[][2026-07-13-000]Summarize this"
);
assertEqual(
    formatChatHistoryBaseName(buildChatHistoryTitleContext("Summarize this", ["report.pdf"]), date, 1),
    "[report.pdf][2026-07-13-001]Summarize this"
);
assertEqual(
    formatChatHistoryBaseName(
        buildChatHistoryTitleContext("Compare them", ["report.pdf", "appendix.png", "report.pdf"]),
        date,
        12
    ),
    "[report.pdf,appendix.png][2026-07-13-012]Compare them"
);
assertEqual(
    formatChatHistoryBaseName(buildChatHistoryTitleContext("", ["report.pdf"]), date, 999),
    "[report.pdf][2026-07-13-999]Chat"
);
assertEqual(
    formatChatHistoryBaseName(buildChatHistoryTitleContext("  line one\nline two  ", []), date, 1000),
    "[][2026-07-13-1000]line one line two"
);

assertNumberEqual(findNextChatHistorySequence([], "2026-07-13"), 0);
assertNumberEqual(
    findNextChatHistorySequence([
        "[report.pdf][2026-07-13-000]Summary",
        "[scan.png][2026-07-13-002]OCR",
        "[other.pdf][2026-07-12-001]Older"
    ], "2026-07-13"),
    1
);
