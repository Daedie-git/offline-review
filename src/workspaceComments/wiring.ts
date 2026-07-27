import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceThreadReport } from './types';

interface WorkspaceCommentRefreshTarget {
    loadAllThreads(): void;
    refreshCommentingRanges(): void;
}

interface WorkspaceCommentProviderRefreshTarget {
    refresh(): void;
}

export interface OpenWorkspaceCommentResult {
    readonly report: WorkspaceThreadReport;
    readonly document: vscode.TextDocument;
    readonly range: vscode.Range;
}

/** Shared production wiring for source-save and explicit workspace refreshes. */
export class WorkspaceCommentRefresher {
    constructor(
        private readonly pathResolver: WorkspacePathResolver,
        private readonly controller: WorkspaceCommentRefreshTarget,
        private readonly provider: WorkspaceCommentProviderRefreshTarget
    ) {}

    refresh(): void {
        this.controller.loadAllThreads();
        this.controller.refreshCommentingRanges();
        this.provider.refresh();
    }

    refreshAuthorizedSave(document: vscode.TextDocument): boolean {
        if (!this.pathResolver.resolveUri(document.uri)) {
            return false;
        }
        this.refresh();
        return true;
    }
}

/** Debounces workspace-comment file events across own-write suppression. */
export class WorkspaceCommentsWatcherCoordinator {
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly refresh: () => void,
        private readonly debounceMs: number = 400,
        private readonly suppressionPaddingMs: number = 50
    ) {}

    notify(fsPath: string): void {
        const classification = this.storage.classifyWatch(fsPath);
        if (classification === 'exactOwnWrite') {
            return;
        }
        const delay = classification === 'suppressed'
            ? Math.max(
                this.suppressionPaddingMs,
                this.storage.msUntilWatchAllowed() + this.suppressionPaddingMs
            )
            : this.debounceMs;
        this.schedule(fsPath, delay);
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private schedule(fsPath: string, delay: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const classification = this.storage.classifyWatch(fsPath);
            if (classification === 'external') {
                this.refresh();
                return;
            }
            if (classification === 'suppressed') {
                const remaining = this.storage.msUntilWatchAllowed();
                this.schedule(
                    fsPath,
                    Math.max(
                        this.suppressionPaddingMs,
                        remaining + this.suppressionPaddingMs
                    )
                );
            }
        }, delay);
    }
}

/** Revalidates the effective anchor after the asynchronous document open. */
export class WorkspaceCommentOpener {
    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver
    ) {}

    async open(threadId: string, expectedFilePath: string): Promise<OpenWorkspaceCommentResult> {
        const initial = this.requireOpenableReport(threadId, expectedFilePath);
        const initialUri = this.pathResolver.uriForStoredPath(initial.filePath);
        if (!initialUri) {
            throw new Error('That workspace code comment file is unavailable');
        }
        const document = await vscode.workspace.openTextDocument(initialUri);

        const latest = this.requireOpenableReport(threadId, expectedFilePath);
        const latestUri = this.pathResolver.uriForStoredPath(latest.filePath);
        if (!latestUri || document.uri.toString() !== latestUri.toString()) {
            throw new Error('That workspace code comment changed while its file was opening');
        }
        const startLine = latest.effectiveStartLine;
        const endLine = latest.effectiveEndLine;
        if (startLine === undefined || endLine === undefined
            || startLine >= document.lineCount || endLine >= document.lineCount) {
            throw new Error('That workspace code comment range is outside the document');
        }
        const documentAnchor: string[] = [];
        for (let line = startLine; line <= endLine; line++) {
            documentAnchor.push(document.lineAt(line).text);
        }
        if (documentAnchor.join('\n') !== latest.sourceAnchor) {
            throw new Error('That workspace code comment changed while its file was opening');
        }
        return {
            report: latest,
            document,
            range: new vscode.Range(
                startLine,
                0,
                endLine,
                document.lineAt(endLine).range.end.character
            ),
        };
    }

    private requireOpenableReport(
        threadId: string,
        expectedFilePath: string
    ): WorkspaceThreadReport {
        const report = this.storage.getReports().find(candidate => candidate.id === threadId);
        if (!report || report.filePath !== expectedFilePath) {
            throw new Error('That workspace code comment is stale or has moved');
        }
        if (report.pathStatus !== 'current') {
            throw new Error('That workspace code comment file is unavailable');
        }
        if (report.anchorStatus === 'ambiguous') {
            throw new Error('That workspace code comment anchor is ambiguous');
        }
        if (report.anchorStatus === 'notFound') {
            throw new Error('That workspace code comment anchor is stale');
        }
        if (report.anchorStatus === 'unavailable'
            || report.effectiveStartLine === undefined
            || report.effectiveEndLine === undefined) {
            throw new Error('That workspace code comment range is unavailable');
        }
        return report;
    }
}
