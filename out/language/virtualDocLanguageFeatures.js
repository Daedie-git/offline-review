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
exports.getLiveWorktreeUri = getLiveWorktreeUri;
exports.registerVirtualDocLanguageFeatures = registerVirtualDocLanguageFeatures;
const vscode = __importStar(require("vscode"));
const gitService_1 = require("../git/gitService");
/** Map only a live worktree virtual document to its captured on-disk file. */
function getLiveWorktreeUri(virtualUri) {
    const parsed = (0, gitService_1.parseDiffDocumentUri)(virtualUri);
    if (!parsed || parsed.side !== 'modified'
        || parsed.document.kind !== 'worktree' || !parsed.worktreeRoot) {
        return undefined;
    }
    return vscode.Uri.joinPath(vscode.Uri.file(parsed.worktreeRoot), parsed.filePath);
}
/**
 * Forward language navigation only from live WORKTREE documents to the
 * corresponding file captured by the prepared DiffPlan. Immutable Git snapshots
 * are not forwarded because their contents and line positions may differ from
 * every checked-out file.
 */
function registerVirtualDocLanguageFeatures(context, gitService) {
    const selector = { scheme: 'git-local-review' };
    const ensureRealUri = async (virtualUri) => {
        const parsed = (0, gitService_1.parseDiffDocumentUri)(virtualUri);
        const realUri = getLiveWorktreeUri(virtualUri);
        if (!parsed?.worktreeRoot || !realUri
            || !await gitService.isLinkedWorktreeRoot(parsed.worktreeRoot)) {
            return undefined;
        }
        try {
            await vscode.workspace.openTextDocument(realUri);
            return realUri;
        }
        catch {
            return undefined;
        }
    };
    const locations = (command) => async (document, position) => {
        const realUri = await ensureRealUri(document.uri);
        if (!realUri) {
            return undefined;
        }
        return vscode.commands.executeCommand(command, realUri, position);
    };
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: locations('vscode.executeDefinitionProvider'),
    }), vscode.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: locations('vscode.executeTypeDefinitionProvider'),
    }), vscode.languages.registerImplementationProvider(selector, {
        provideImplementation: locations('vscode.executeImplementationProvider'),
    }), vscode.languages.registerReferenceProvider(selector, {
        async provideReferences(document, position) {
            const realUri = await ensureRealUri(document.uri);
            if (!realUri) {
                return undefined;
            }
            return vscode.commands.executeCommand('vscode.executeReferenceProvider', realUri, position);
        },
    }), vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position) {
            const realUri = await ensureRealUri(document.uri);
            if (!realUri) {
                return undefined;
            }
            const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', realUri, position);
            return hovers?.[0];
        },
    }));
}
//# sourceMappingURL=virtualDocLanguageFeatures.js.map