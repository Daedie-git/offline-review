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
export declare class WorkspaceCommentRefresher {
    private readonly pathResolver;
    private readonly controller;
    private readonly provider;
    constructor(pathResolver: WorkspacePathResolver, controller: WorkspaceCommentRefreshTarget, provider: WorkspaceCommentProviderRefreshTarget);
    refresh(): void;
    refreshAuthorizedSave(document: vscode.TextDocument): boolean;
}
/** Debounces workspace-comment file events across own-write suppression. */
export declare class WorkspaceCommentsWatcherCoordinator {
    private readonly storage;
    private readonly refresh;
    private readonly debounceMs;
    private readonly suppressionPaddingMs;
    private timer;
    constructor(storage: WorkspaceCommentStorage, refresh: () => void, debounceMs?: number, suppressionPaddingMs?: number);
    notify(fsPath: string): void;
    dispose(): void;
    private schedule;
}
/** Revalidates the effective anchor after the asynchronous document open. */
export declare class WorkspaceCommentOpener {
    private readonly storage;
    private readonly pathResolver;
    constructor(storage: WorkspaceCommentStorage, pathResolver: WorkspacePathResolver);
    open(threadId: string, expectedFilePath: string): Promise<OpenWorkspaceCommentResult>;
    private requireOpenableReport;
}
export {};
