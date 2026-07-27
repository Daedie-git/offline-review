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
exports.WorkspaceCommentOpener = exports.WorkspaceCommentsWatcherCoordinator = exports.WorkspaceCommentRefresher = void 0;
const vscode = __importStar(require("vscode"));
/** Shared production wiring for source-save and explicit workspace refreshes. */
class WorkspaceCommentRefresher {
    constructor(pathResolver, controller, provider) {
        this.pathResolver = pathResolver;
        this.controller = controller;
        this.provider = provider;
    }
    refresh() {
        this.controller.loadAllThreads();
        this.controller.refreshCommentingRanges();
        this.provider.refresh();
    }
    refreshAuthorizedSave(document) {
        if (!this.pathResolver.resolveUri(document.uri)) {
            return false;
        }
        this.refresh();
        return true;
    }
}
exports.WorkspaceCommentRefresher = WorkspaceCommentRefresher;
/** Debounces workspace-comment file events across own-write suppression. */
class WorkspaceCommentsWatcherCoordinator {
    constructor(storage, refresh, debounceMs = 400, suppressionPaddingMs = 50) {
        this.storage = storage;
        this.refresh = refresh;
        this.debounceMs = debounceMs;
        this.suppressionPaddingMs = suppressionPaddingMs;
    }
    notify(fsPath) {
        const classification = this.storage.classifyWatch(fsPath);
        if (classification === 'exactOwnWrite') {
            return;
        }
        const delay = classification === 'suppressed'
            ? Math.max(this.suppressionPaddingMs, this.storage.msUntilWatchAllowed() + this.suppressionPaddingMs)
            : this.debounceMs;
        this.schedule(fsPath, delay);
    }
    dispose() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    schedule(fsPath, delay) {
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
                this.schedule(fsPath, Math.max(this.suppressionPaddingMs, remaining + this.suppressionPaddingMs));
            }
        }, delay);
    }
}
exports.WorkspaceCommentsWatcherCoordinator = WorkspaceCommentsWatcherCoordinator;
/** Revalidates the effective anchor after the asynchronous document open. */
class WorkspaceCommentOpener {
    constructor(storage, pathResolver) {
        this.storage = storage;
        this.pathResolver = pathResolver;
    }
    async open(threadId, expectedFilePath) {
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
        const documentAnchor = [];
        for (let line = startLine; line <= endLine; line++) {
            documentAnchor.push(document.lineAt(line).text);
        }
        if (documentAnchor.join('\n') !== latest.sourceAnchor) {
            throw new Error('That workspace code comment changed while its file was opening');
        }
        return {
            report: latest,
            document,
            range: new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character),
        };
    }
    requireOpenableReport(threadId, expectedFilePath) {
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
exports.WorkspaceCommentOpener = WorkspaceCommentOpener;
//# sourceMappingURL=wiring.js.map