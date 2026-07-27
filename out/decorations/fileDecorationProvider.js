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
exports.ReviewFileDecorationProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const reviewAnchorResolver_1 = require("../comments/reviewAnchorResolver");
class ReviewFileDecorationProvider {
    constructor(_storageService, gitService, anchorResolver) {
        this.gitService = gitService;
        this.anchorResolver = anchorResolver;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }
    provideFileDecoration(uri) {
        // Only decorate workspace files (file:// scheme)
        if (uri.scheme !== 'file') {
            return undefined;
        }
        const worktreeRoot = this.gitService.getSelectedWorktreeRoot();
        if (!worktreeRoot) {
            return undefined;
        }
        const relative = path.relative(worktreeRoot, uri.fsPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return undefined;
        }
        const relativePath = relative.replace(/\\/g, '/');
        const count = this.getUnresolvedCount(relativePath);
        if (count === 0) {
            return undefined;
        }
        return {
            badge: `${count}`,
            tooltip: `${count} unresolved review comment${count > 1 ? 's' : ''}`,
            color: new vscode.ThemeColor('localPrReview.unresolvedCommentForeground'),
            propagate: true,
        };
    }
    getUnresolvedCount(filePath) {
        const state = this.anchorResolver?.getAppliedState();
        if (!state || state.plan.worktreeRoot !== this.gitService.getSelectedWorktreeRoot()) {
            return 0;
        }
        return state.projections.filter(projection => projection.thread.filePath === filePath
            && projection.thread.state === 'unresolved'
            && (0, reviewAnchorResolver_1.isEffectiveReviewProjection)(projection)).length;
    }
    refresh() {
        this._onDidChangeFileDecorations.fire(undefined);
    }
    dispose() {
        this._onDidChangeFileDecorations.dispose();
    }
}
exports.ReviewFileDecorationProvider = ReviewFileDecorationProvider;
//# sourceMappingURL=fileDecorationProvider.js.map