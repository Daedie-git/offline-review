export type WorkspaceCommentState = 'resolved' | 'unresolved';
export interface WorkspaceComment {
    id: string;
    body: string;
    author: string;
    timestamp: string;
}
export interface WorkspaceCommentThread {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    state: WorkspaceCommentState;
    sourceAnchor: string;
    createdAt: string;
    comments: WorkspaceComment[];
}
export interface WorkspaceCommentsFile {
    version: 1;
    threads: WorkspaceCommentThread[];
}
export type WorkspacePathStatus = 'current' | 'missing' | 'unsafe';
export type WorkspaceAnchorStatus = 'current' | 'reanchored' | 'notFound' | 'ambiguous' | 'unavailable';
export type WorkspaceRangeStatus = 'current' | 'reanchored' | 'stale' | 'ambiguous' | 'unavailable';
export interface WorkspaceAnchorMatch {
    readonly startLine: number;
    readonly endLine: number;
}
export interface WorkspaceThreadReport extends WorkspaceCommentThread {
    pathStatus: WorkspacePathStatus;
    anchorStatus: WorkspaceAnchorStatus;
    rangeStatus: WorkspaceRangeStatus;
    effectiveStartLine?: number;
    effectiveEndLine?: number;
    matches: readonly WorkspaceAnchorMatch[];
    stale: boolean;
}
