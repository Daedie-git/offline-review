import * as vscode from 'vscode';
export declare class SuggestChangePanel {
    private readonly originalCode;
    private readonly resolve;
    private panel;
    private resolved;
    /**
     * Open the suggestion composer. Returns the formatted diff comment body,
     * or undefined if the user cancelled.
     */
    static show(extensionUri: vscode.Uri, originalCode: string, filePath: string): Promise<string | undefined>;
    private constructor();
    private formatSuggestion;
    private getHtml;
}
