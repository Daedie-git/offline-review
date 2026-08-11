import * as vscode from 'vscode';
import { WorkspaceCommentController } from './workspaceComments/controller';
export declare function activate(context: vscode.ExtensionContext): Promise<void>;
/** True when the command arg is the thread reply box, not an in-place edit. */
export declare function isCommentReply(arg: unknown): arg is vscode.CommentReply;
export declare function commentBodyText(comment: vscode.Comment): string;
export declare function addOrReplyWorkspaceComment(controller: WorkspaceCommentController, reply: vscode.CommentReply): Promise<void>;
export declare function deactivate(): void;
