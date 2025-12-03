import { App, TFile } from "obsidian";

type ResolveNoteSuccess = {
    type: "resolved";
    file: TFile;
};

type ResolveNoteAmbiguous = {
    type: "not_unique";
    matches: TFile[];
};

type ResolveNoteFailure = {
    type: "not_found";
};

type ResolveNoteOutcome = ResolveNoteSuccess | ResolveNoteAmbiguous | ResolveNoteFailure;

export class NoteService {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Normalizes a path fragment to support case-insensitive comparisons with forward slashes.
     */
    normalizePathFragment(value: string): string {
        return value.replace(/\\/g, "/").toLowerCase();
    }

    stripExtension(value: string): string {
        return value.replace(/\.[^/.]+$/, "");
    }

    pathSegmentsMatchTail(filePath: string, targetSegments: string[]): boolean {
        if (targetSegments.length === 0) {
            return false;
        }

        const normalizedFilePath = this.normalizePathFragment(filePath);
        const fileSegments = normalizedFilePath.split("/").filter(Boolean);
        if (fileSegments.length < targetSegments.length) {
            return false;
        }

        const comparisonSegments = fileSegments.slice(-targetSegments.length);
        for (let index = 0; index < targetSegments.length; index += 1) {
            const targetSegment = targetSegments[index];
            if (!targetSegment) {
                return false;
            }

            const fileSegment = comparisonSegments[index];
            if (index === comparisonSegments.length - 1) {
                const fileSegmentSansExt = this.stripExtension(fileSegment);
                if (!fileSegment.includes(targetSegment) && !fileSegmentSansExt.includes(targetSegment)) {
                    return false;
                }
            } else if (!fileSegment.includes(targetSegment)) {
                return false;
            }
        }

        return true;
    }

    pathHasExtension(value: string): boolean {
        return /\.[^/]+$/.test(value);
    }

    async resolveNoteFile(notePath: string): Promise<ResolveNoteOutcome> {
        const tryResolve = (path: string) => {
            const maybeFile = this.app.vault.getAbstractFileByPath(path);
            return maybeFile instanceof TFile ? maybeFile : null;
        };

        const trimmedInput = notePath.trim();
        const wikiMatch = trimmedInput.match(/^\s*\[\[([\s\S]+?)\]\]\s*$/);
        const innerTargetRaw = wikiMatch ? wikiMatch[1] : trimmedInput;
        const innerTarget = innerTargetRaw.trim();
        const [targetPart] = innerTarget.split("|");
        const [targetWithoutSection] = targetPart.split("#");
        const canonicalTarget = targetWithoutSection.trim();

        const attemptedPaths = Array.from(
            new Set<string>(
                [trimmedInput, innerTarget, canonicalTarget].map((value) => value.trim()).filter(Boolean)
            )
        );

        for (const candidate of attemptedPaths) {
            const direct = tryResolve(candidate);
            if (direct) {
                return { type: "resolved", file: direct };
            }

            if (!this.pathHasExtension(candidate)) {
                for (const ext of [".md", ".canvas"]) {
                    const resolved = tryResolve(`${candidate}${ext}`);
                    if (resolved) {
                        return { type: "resolved", file: resolved };
                    }
                }
            }
        }

        const metadataCache = this.app.metadataCache;
        const resolutionTarget = canonicalTarget.trim();

        if (metadataCache && resolutionTarget) {
            const linkTargets = new Set<string>([resolutionTarget]);

            if (!this.pathHasExtension(resolutionTarget)) {
                for (const ext of [".md", ".canvas"]) {
                    linkTargets.add(`${resolutionTarget}${ext}`);
                }
            }

            for (const target of linkTargets) {
                const resolved = metadataCache.getFirstLinkpathDest?.(target, "");
                if (resolved instanceof TFile) {
                    return { type: "resolved", file: resolved };
                }
            }
        }

        if (!resolutionTarget) {
            return { type: "not_found" };
        }

        const markdownFiles = this.app.vault.getMarkdownFiles?.() ?? [];
        if (markdownFiles.length === 0) {
            return { type: "not_found" };
        }

        const normalizedTarget = this.normalizePathFragment(resolutionTarget);
        const candidatePathForms = new Set<string>([normalizedTarget]);

        if (!this.pathHasExtension(resolutionTarget)) {
            for (const ext of [".md", ".canvas"]) {
                candidatePathForms.add(this.normalizePathFragment(`${resolutionTarget}${ext}`));
            }
        }

        for (const file of markdownFiles) {
            const normalizedFilePath = this.normalizePathFragment(file.path);
            if (candidatePathForms.has(normalizedFilePath)) {
                return { type: "resolved", file };
            }
        }

        const basename = resolutionTarget.split("/").pop();
        if (basename) {
            const normalizedBasename = basename.toLowerCase();
            const basenameMatches = markdownFiles.filter(
                (file) => file.basename.toLowerCase() === normalizedBasename
            );

            if (basenameMatches.length === 1) {
                return { type: "resolved", file: basenameMatches[0] };
            }

            if (basenameMatches.length > 1) {
                return { type: "not_unique", matches: basenameMatches };
            }
        }

        const targetSegments = normalizedTarget.split("/").filter(Boolean);
        if (targetSegments.length === 0) {
            return { type: "not_found" };
        }

        const partialMatches = markdownFiles.filter((file) =>
            this.pathSegmentsMatchTail(file.path, targetSegments)
        );

        if (partialMatches.length === 1) {
            return { type: "resolved", file: partialMatches[0] };
        }

        if (partialMatches.length > 1) {
            return { type: "not_unique", matches: partialMatches };
        }

        return { type: "not_found" };
    }

    async readNoteText(file: TFile): Promise<string> {
        try {
            return await this.app.vault.cachedRead(file);
        } catch (error) {
            console.warn(`readNote: failed to read ${file.path}`, error);
            return "";
        }
    }
}
