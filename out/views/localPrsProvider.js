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
const types_1 = require("../types");
class LocalPrsProvider {
    constructor(localPrManager) {
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.managerChange = this.localPrManager.onDidChange(() => this.refresh());
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const activeId = this.localPrManager.getActiveReview()?.id;
        return this.localPrManager.listReviews().map(review => new LocalPrItem(review, review.id === activeId));
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this.managerChange.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
exports.LocalPrsProvider = LocalPrsProvider;
class LocalPrItem extends vscode.TreeItem {
    constructor(review, isActive) {
        super((0, types_1.formatReviewLabel)(review), vscode.TreeItemCollapsibleState.None);
        this.review = review;
        const created = new Date(review.createdAt).toLocaleString();
        if (review.mode === 'uncommitted') {
            this.tooltip = `Uncommitted changes on ${review.branch}\nCreated: ${created}`;
            this.iconPath = new vscode.ThemeIcon('git-commit');
        }
        else {
            this.tooltip = review.baseBranch === review.targetBranch
                ? `Primary branch self-review (intentionally empty)\nCreated: ${created}`
                : `Branch review\nCreated: ${created}`;
            this.iconPath = new vscode.ThemeIcon('git-pull-request');
        }
        this.contextValue = 'localPr';
        this.description = isActive
            ? `active · ${review.mode}`
            : review.mode;
        if (isActive) {
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        }
        this.command = {
            command: 'localPrReview.activateReview',
            title: 'Activate Review',
            arguments: [this],
        };
    }
}
exports.LocalPrItem = LocalPrItem;
//# sourceMappingURL=localPrsProvider.js.map