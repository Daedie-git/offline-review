import * as vscode from 'vscode';

/**
 * Forward language navigation from modified-side virtual documents to the
 * corresponding workspace file. Original/base snapshots are never forwarded
 * because their line positions do not describe the target file.
 */
export function registerVirtualDocLanguageFeatures(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = { scheme: 'git-local-review' };

    const toRealUri = (virtualUri: vscode.Uri): vscode.Uri | undefined => {
        const params = new URLSearchParams(virtualUri.query);
        if (params.get('side') !== 'modified' && params.get('ref') !== 'WORKTREE') {
            return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const filePath = virtualUri.path.startsWith('/')
            ? virtualUri.path.slice(1)
            : virtualUri.path;
        if (!folder || !filePath) {
            return undefined;
        }
        return vscode.Uri.joinPath(folder.uri, filePath);
    };

    const ensureRealUri = async (virtualUri: vscode.Uri): Promise<vscode.Uri | undefined> => {
        const realUri = toRealUri(virtualUri);
        if (!realUri) {
            return undefined;
        }
        try {
            await vscode.workspace.openTextDocument(realUri);
            return realUri;
        } catch {
            return undefined;
        }
    };

    const locations = (
        command: 'vscode.executeDefinitionProvider'
            | 'vscode.executeTypeDefinitionProvider'
            | 'vscode.executeImplementationProvider'
    ) => async (
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> => {
        const realUri = await ensureRealUri(document.uri);
        if (!realUri) {
            return undefined;
        }
        return vscode.commands.executeCommand<vscode.Definition | vscode.DefinitionLink[]>(
            command,
            realUri,
            position
        );
    };

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, {
            provideDefinition: locations('vscode.executeDefinitionProvider'),
        }),
        vscode.languages.registerTypeDefinitionProvider(selector, {
            provideTypeDefinition: locations('vscode.executeTypeDefinitionProvider'),
        }),
        vscode.languages.registerImplementationProvider(selector, {
            provideImplementation: locations('vscode.executeImplementationProvider'),
        }),
        vscode.languages.registerReferenceProvider(selector, {
            async provideReferences(document, position): Promise<vscode.Location[] | undefined> {
                const realUri = await ensureRealUri(document.uri);
                if (!realUri) {
                    return undefined;
                }
                return vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    realUri,
                    position
                );
            },
        }),
        vscode.languages.registerHoverProvider(selector, {
            async provideHover(document, position): Promise<vscode.Hover | undefined> {
                const realUri = await ensureRealUri(document.uri);
                if (!realUri) {
                    return undefined;
                }
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    realUri,
                    position
                );
                return hovers?.[0];
            },
        })
    );
}
