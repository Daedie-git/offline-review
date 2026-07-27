import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceThreadReport } from './types';

export type CodeCommentTreeItem = CodeCommentFileItem | CodeCommentThreadItem;

export class WorkspaceCommentsProvider implements vscode.TreeDataProvider<CodeCommentTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CodeCommentTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private reports: readonly WorkspaceThreadReport[] | undefined;

    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver
    ) {}

    getTreeItem(element: CodeCommentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CodeCommentTreeItem): CodeCommentTreeItem[] {
        const reports = this.reports ??= this.storage.getReports();
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
        this.reports = undefined;
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
        const stale = reports.filter(report => report.rangeStatus === 'stale').length;
        const ambiguous = reports.filter(report => report.rangeStatus === 'ambiguous').length;
        const reanchored = reports.filter(report => report.rangeStatus === 'reanchored').length;
        const health = [
            unavailable ? `${unavailable} missing/unsafe` : '',
            stale ? `${stale} stale` : '',
            ambiguous ? `${ambiguous} ambiguous` : '',
            reanchored ? `${reanchored} reanchored` : '',
        ].filter(Boolean).join(' · ');
        this.description = `${unresolved} unresolved${health ? ` · ${health}` : ''}`;
        this.tooltip = filePath;
        this.iconPath = new vscode.ThemeIcon(
            unavailable || stale || ambiguous ? 'warning' : 'file'
        );
        this.contextValue = 'codeCommentFile';
    }
}

export class CodeCommentThreadItem extends vscode.TreeItem {
    constructor(
        readonly report: WorkspaceThreadReport,
        pathResolver: WorkspacePathResolver
    ) {
        super(summary(report), vscode.TreeItemCollapsibleState.None);
        const displayStart = report.effectiveStartLine ?? report.startLine;
        const displayEnd = report.effectiveEndLine ?? report.endLine;
        const range = displayStart === displayEnd
            ? `line ${displayStart + 1}`
            : `lines ${displayStart + 1}-${displayEnd + 1}`;
        const health = report.pathStatus !== 'current'
            ? report.pathStatus
            : report.rangeStatus === 'current' ? undefined : report.rangeStatus;
        this.description = [report.state, range, health].filter(Boolean).join(' · ');
        this.tooltip = `${report.filePath}:${displayStart + 1}`;
        this.iconPath = new vscode.ThemeIcon(
            report.pathStatus !== 'current' || report.rangeStatus !== 'current'
                ? 'warning'
                : report.state === 'resolved' ? 'pass' : 'comment-discussion'
        );
        this.contextValue = 'codeCommentThread';
        const uri = pathResolver.uriForStoredPath(report.filePath);
        if (uri && (report.anchorStatus === 'current' || report.anchorStatus === 'reanchored')) {
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
