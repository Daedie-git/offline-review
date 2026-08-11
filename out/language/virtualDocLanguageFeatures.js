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
 * Forward language navigation from coordinate-equivalent modified documents to
 * the corresponding file in the checkout captured by the prepared DiffPlan.
 * Immutable Git snapshots are eligible only while their exact text still
 * matches that real document; stale snapshots and original sides fail closed.
 */
function registerVirtualDocLanguageFeatures(context, gitService) {
    const selector = { scheme: 'git-local-review' };
    const prepareTarget = async (virtualDocument, position, token) => {
        const parsed = (0, gitService_1.parseDiffDocumentUri)(virtualDocument.uri);
        if (!parsed || parsed.side !== 'modified' || !parsed.worktreeRoot
            || token.isCancellationRequested
            || !isValidPosition(virtualDocument, position)
            || !await gitService.isLinkedWorktreeRoot(parsed.worktreeRoot)) {
            return undefined;
        }
        const realUri = vscode.Uri.joinPath(vscode.Uri.file(parsed.worktreeRoot), parsed.filePath);
        try {
            const realDocument = await vscode.workspace.openTextDocument(realUri);
            if (token.isCancellationRequested
                || realDocument.uri.toString() !== realUri.toString()
                || !isValidPosition(realDocument, position)
                || virtualDocument.getText() !== realDocument.getText()) {
                return undefined;
            }
            return {
                realUri,
                realDocument,
                virtualVersion: virtualDocument.version,
                realVersion: realDocument.version,
            };
        }
        catch {
            return undefined;
        }
    };
    const targetIsCurrent = (target, virtualDocument, token) => !token.isCancellationRequested
        && virtualDocument.version === target.virtualVersion
        && target.realDocument.version === target.realVersion
        && virtualDocument.getText() === target.realDocument.getText();
    const execute = async (command, document, position, token) => {
        const target = await prepareTarget(document, position, token);
        if (!target) {
            return undefined;
        }
        const result = await vscode.commands.executeCommand(command, target.realUri, position);
        return targetIsCurrent(target, document, token) ? result : undefined;
    };
    const locations = (command) => async (document, position, token) => execute(command, document, position, token);
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: locations('vscode.executeDefinitionProvider'),
    }), vscode.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: locations('vscode.executeTypeDefinitionProvider'),
    }), vscode.languages.registerImplementationProvider(selector, {
        provideImplementation: locations('vscode.executeImplementationProvider'),
    }), vscode.languages.registerReferenceProvider(selector, {
        provideReferences(document, position, _context, token) {
            return execute('vscode.executeReferenceProvider', document, position, token);
        },
    }), vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position, token) {
            const hovers = await execute('vscode.executeHoverProvider', document, position, token);
            return hovers?.[0];
        },
    }));
}
function isValidPosition(document, position) {
    if (position.line < 0 || position.line >= document.lineCount || position.character < 0) {
        return false;
    }
    return position.character <= document.lineAt(position.line).text.length;
}
//# sourceMappingURL=virtualDocLanguageFeatures.js.map