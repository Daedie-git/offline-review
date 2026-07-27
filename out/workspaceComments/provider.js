"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeCommentThreadItem = exports.CodeCommentFileItem = exports.WorkspaceCommentsProvider = void 0;
const vscode = __importStar(require("vscode"));
class WorkspaceCommentsProvider {
    constructor(storage, pathResolver) {
        this.storage = storage;
        this.pathResolver = pathResolver;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
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
        const grouped = new Map();
        for (const report of reports) {
            const existing = grouped.get(report.filePath) ?? [];
            existing.push(report);
            grouped.set(report.filePath, existing);
        }
        return [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([filePath, fileReports]) => new CodeCommentFileItem(filePath, fileReports));
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
exports.WorkspaceCommentsProvider = WorkspaceCommentsProvider;
class CodeCommentFileItem extends vscode.TreeItem {
    constructor(filePath, reports) {
        super(filePath, vscode.TreeItemCollapsibleState.Expanded);
        this.filePath = filePath;
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
exports.CodeCommentFileItem = CodeCommentFileItem;
class CodeCommentThreadItem extends vscode.TreeItem {
    constructor(report, pathResolver) {
        super(summary(report), vscode.TreeItemCollapsibleState.None);
        this.report = report;
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
        this.iconPath = new vscode.ThemeIcon(report.pathStatus !== 'current' || report.rangeStatus !== 'current'
            ? 'warning'
            : report.state === 'resolved' ? 'pass' : 'comment-discussion');
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
exports.CodeCommentThreadItem = CodeCommentThreadItem;
function summary(report) {
    const body = report.comments[0]?.body.trim().replace(/\s+/g, ' ') ?? 'Code comment';
    return body.length > 80 ? `${body.slice(0, 77)}...` : body;
}
function compareReports(left, right) {
    return left.startLine - right.startLine || left.createdAt.localeCompare(right.createdAt);
}
//# sourceMappingURL=provider.js.map