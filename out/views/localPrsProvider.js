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
exports.LocalPrItem = exports.LocalPrsProvider = void 0;
const vscode = __importStar(require("vscode"));
class LocalPrsProvider {
    constructor(localPrManager) {
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.localPrManager.onDidChange(() => this.refresh());
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const reviews = this.localPrManager.listReviews();
        const activeId = this.localPrManager.getActiveReview()?.id;
        return reviews.map(r => new LocalPrItem(r, r.id === activeId));
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
exports.LocalPrsProvider = LocalPrsProvider;
class LocalPrItem extends vscode.TreeItem {
    constructor(review, isActive) {
        super(`${review.targetBranch} -> ${review.sourceBranch}`, vscode.TreeItemCollapsibleState.None);
        this.review = review;
        this.tooltip = `Created: ${new Date(review.createdAt).toLocaleString()}`;
        this.contextValue = 'localPr';
        if (isActive) {
            this.description = 'active';
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        }
        else {
            this.iconPath = new vscode.ThemeIcon('git-pull-request');
        }
        // Click to activate
        this.command = {
            command: 'localPrReview.activateReview',
            title: 'Activate Review',
            arguments: [this],
        };
    }
}
exports.LocalPrItem = LocalPrItem;
//# sourceMappingURL=localPrsProvider.js.map