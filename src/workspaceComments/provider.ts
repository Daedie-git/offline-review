import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceThreadReport } from './types';

export type CodeCommentTreeItem = CodeCommentFileItem | CodeCommentThreadItem;

export class WorkspaceCommentsProvider implements vscode.TreeDataProvider<CodeCommentTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CodeCommentTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver
    ) {}

    getTreeItem(element: CodeCommentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CodeCommentTreeItem): CodeCommentTreeItem[] {
        const reports = this.storage.getReports();
        if (element instanceof CodeCommentFileItem) {
            return reports
                .filter(report => report.filePath === element.filePath)
                .sort(compareReports)
                .map(report => new CodeCommentThreadItem(report, this.pathResolver));
        }
        if (element) {
            return [];
        }
        const grouped = new Map<string, WorkspaceThreadReport[]>();
        for (const report of reports) {
            const existing = grouped.get(report.filePath) ?? [];
            existing.push(report);
            grouped.set(report.filePath, existing);
        }
        return [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([filePath, fileReports]) => new CodeCommentFileItem(filePath, fileReports));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

export class CodeCommentFileItem extends vscode.TreeItem {
    constructor(
        readonly filePath: string,
        reports: readonly WorkspaceThreadReport[]
    ) {
        super(filePath, vscode.TreeItemCollapsibleState.Expanded);
        const unresolved = reports.filter(report => report.state === 'unresolved').length;
        const unavailable = reports.filter(report => report.pathStatus !== 'current').length;
        const outOfRange = reports.filter(report => report.rangeStatus === 'outOfRange').length;
        const health = [
            unavailable ? `${unavailable} missing/unsafe` : '',
            outOfRange ? `${outOfRange} out of range` : '',
        ].filter(Boolean).join(' · ');
        this.description = `${unresolved} unresolved${health ? ` · ${health}` : ''}`;
        this.tooltip = filePath;
        this.iconPath = new vscode.ThemeIcon(unavailable || outOfRange ? 'warning' : 'file');
        this.contextValue = 'codeCommentFile';
    }
}

export class CodeCommentThreadItem extends vscode.TreeItem {
    constructor(
        readonly report: WorkspaceThreadReport,
        pathResolver: WorkspacePathResolver
    ) {
        super(summary(report), vscode.TreeItemCollapsibleState.None);
        const range = report.startLine === report.endLine
            ? `line ${report.startLine + 1}`
            : `lines ${report.startLine + 1}-${report.endLine + 1}`;
        const health = report.pathStatus !== 'current'
            ? report.pathStatus
            : report.rangeStatus === 'outOfRange'
                ? 'out of range'
                : report.stale ? 'stale' : undefined;
        this.description = [report.state, range, health].filter(Boolean).join(' · ');
        this.tooltip = `${report.filePath}:${report.startLine + 1}`;
        this.iconPath = new vscode.ThemeIcon(
            report.pathStatus !== 'current' || report.rangeStatus !== 'current'
                ? 'warning'
                : report.state === 'resolved' ? 'pass' : 'comment-discussion'
        );
        this.contextValue = 'codeCommentThread';
        const uri = pathResolver.uriForStoredPath(report.filePath);
        if (uri && report.rangeStatus !== 'outOfRange') {
            this.command = {
                command: 'localPrReview.openCodeComment',
                title: 'Open Code Comment',
                arguments: [this],
            };
        }
    }
}

function summary(report: WorkspaceThreadReport): string {
    const body = report.comments[0]?.body.trim().replace(/\s+/g, ' ') ?? 'Code comment';
    return body.length > 80 ? `${body.slice(0, 77)}...` : body;
}

function compareReports(left: WorkspaceThreadReport, right: WorkspaceThreadReport): number {
    return left.startLine - right.startLine || left.createdAt.localeCompare(right.createdAt);
}
