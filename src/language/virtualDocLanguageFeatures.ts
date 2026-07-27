import * as vscode from 'vscode';
import { GitService, parseDiffDocumentUri } from '../git/gitService';

/** Map only a live worktree virtual document to its captured on-disk file. */
export function getLiveWorktreeUri(virtualUri: vscode.Uri): vscode.Uri | undefined {
    const parsed = parseDiffDocumentUri(virtualUri);
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
export function registerVirtualDocLanguageFeatures(
    context: vscode.ExtensionContext,
    gitService: GitService
): void {
    const selector: vscode.DocumentSelector = { scheme: 'git-local-review' };

    const ensureRealUri = async (virtualUri: vscode.Uri): Promise<vscode.Uri | undefined> => {
        const parsed = parseDiffDocumentUri(virtualUri);
        const realUri = getLiveWorktreeUri(virtualUri);
        if (!parsed?.worktreeRoot || !realUri
            || !await gitService.isLinkedWorktreeRoot(parsed.worktreeRoot)) {
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
