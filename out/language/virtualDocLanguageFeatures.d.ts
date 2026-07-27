import * as vscode from 'vscode';
/**
 * Forward language navigation from modified-side virtual documents to the
 * corresponding workspace file. Original/base snapshots are never forwarded
 * because their line positions do not describe the target file.
 */
export declare function registerVirtualDocLanguageFeatures(context: vscode.ExtensionContext): void;
