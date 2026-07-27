import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceThreadReport } from './types';
export type CodeCommentTreeItem = CodeCommentFileItem | CodeCommentThreadItem;
export declare class WorkspaceCommentsProvider implements vscode.TreeDataProvider<CodeCommentTreeItem> {
    private readonly storage;
    private readonly pathResolver;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<CodeCommentTreeItem | undefined>;
    private reports;
    constructor(storage: WorkspaceCommentStorage, pathResolver: WorkspacePathResolver);
    getTreeItem(element: CodeCommentTreeItem): vscode.TreeItem;
    getChildren(element?: CodeCommentTreeItem): CodeCommentTreeItem[];
    refresh(): void;
    dispose(): void;
}
export declare class CodeCommentFileItem extends vscode.TreeItem {
    readonly filePath: string;
    constructor(filePath: string, reports: readonly WorkspaceThreadReport[]);
}
export declare class CodeCommentThreadItem extends vscode.TreeItem {
    readonly report: WorkspaceThreadReport;
    constructor(report: WorkspaceThreadReport, pathResolver: WorkspacePathResolver);
}
