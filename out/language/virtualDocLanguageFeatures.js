"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerVirtualDocLanguageFeatures = registerVirtualDocLanguageFeatures;
const vscode = require("vscode");
/**
 * Forward LSP navigation from WORKTREE virtual diffs onto the real workspace file.
 * Only bridges modified-side docs — base-pane line numbers do not match disk.
 */
function registerVirtualDocLanguageFeatures(context) {
    const selector = { scheme: 'git-local-review' };
    const isModifiedSide = (uri) => {
        const params = new URLSearchParams(uri.query);
        return params.get('side') === 'modified' || params.get('ref') === 'WORKTREE';
    };
    const toRealUri = (virtualUri) => {
        if (!isModifiedSide(virtualUri)) {
            return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return undefined;
        }
        const filePath = virtualUri.path.startsWith('/') ? virtualUri.path.slice(1) : virtualUri.path;
        if (!filePath) {
            return undefined;
        }
        return vscode.Uri.joinPath(folder.uri, filePath);
    };
    const ensureRealDoc = async (virtualUri) => {
        const realUri = toRealUri(virtualUri);
        if (!realUri) {
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
    const forward = (command) => async (document, position) => {
        const realUri = await ensureRealDoc(document.uri);
        if (!realUri) {
            return undefined;
        }
        return vscode.commands.executeCommand(command, realUri, position);
    };
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: forward('vscode.executeDefinitionProvider'),
    }), vscode.languages.registerTypeDefinitionProvider(selector, {
        provideTypeDefinition: forward('vscode.executeTypeDefinitionProvider'),
    }), vscode.languages.registerImplementationProvider(selector, {
        provideImplementation: forward('vscode.executeImplementationProvider'),
    }), vscode.languages.registerReferenceProvider(selector, {
        provideReferences: forward('vscode.executeReferenceProvider'),
    }), vscode.languages.registerHoverProvider(selector, {
        provideHover: forward('vscode.executeHoverProvider'),
    }));
}
//# sourceMappingURL=virtualDocLanguageFeatures.js.map
