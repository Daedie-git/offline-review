import * as vscode from 'vscode';
import { GitService, parseDiffDocumentUri } from '../git/gitService';

interface NavigationTarget {
    readonly realUri: vscode.Uri;
    readonly realDocument: vscode.TextDocument;
    readonly virtualVersion: number;
    readonly realVersion: number;
}

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
 * Forward language navigation from coordinate-equivalent modified documents to
 * the corresponding file in the checkout captured by the prepared DiffPlan.
 * Immutable Git snapshots are eligible only while their exact text still
 * matches that real document; stale snapshots and original sides fail closed.
 */
export function registerVirtualDocLanguageFeatures(
    context: vscode.ExtensionContext,
    gitService: GitService
): void {
    const selector: vscode.DocumentSelector = { scheme: 'git-local-review' };

    const prepareTarget = async (
        virtualDocument: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<NavigationTarget | undefined> => {
        const parsed = parseDiffDocumentUri(virtualDocument.uri);
        if (!parsed || parsed.side !== 'modified' || !parsed.worktreeRoot
            || token.isCancellationRequested
            || !isValidPosition(virtualDocument, position)
            || !await gitService.isLinkedWorktreeRoot(parsed.worktreeRoot)) {
            return undefined;
        }

        const realUri = vscode.Uri.joinPath(
            vscode.Uri.file(parsed.worktreeRoot),
            parsed.filePath
        );
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
        } catch {
            return undefined;
        }
    };

    const targetIsCurrent = (
        target: NavigationTarget,
        virtualDocument: vscode.TextDocument,
        token: vscode.CancellationToken
    ): boolean => !token.isCancellationRequested
        && virtualDocument.version === target.virtualVersion
        && target.realDocument.version === target.realVersion
        && virtualDocument.getText() === target.realDocument.getText();

    const execute = async <T>(
        command: string,
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<T | undefined> => {
        const target = await prepareTarget(document, position, token);
        if (!target) {
            return undefined;
        }
        const result = await vscode.commands.executeCommand<T>(
            command,
            target.realUri,
            position
        );
        return targetIsCurrent(target, document, token) ? result : undefined;
    };

    const locations = (
        command: 'vscode.executeDefinitionProvider'
            | 'vscode.executeTypeDefinitionProvider'
            | 'vscode.executeImplementationProvider'
    ) => async (
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> => execute(
        command,
        document,
        position,
        token
    );

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
            provideReferences(document, position, _context, token) {
                return execute<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    document,
                    position,
                    token
                );
            },
        }),
        vscode.languages.registerHoverProvider(selector, {
            async provideHover(document, position, token): Promise<vscode.Hover | undefined> {
                const hovers = await execute<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    document,
                    position,
                    token
                );
                return hovers?.[0];
            },
        })
    );
}

function isValidPosition(document: vscode.TextDocument, position: vscode.Position): boolean {
    if (position.line < 0 || position.line >= document.lineCount || position.character < 0) {
        return false;
    }
    return position.character <= document.lineAt(position.line).text.length;
}
