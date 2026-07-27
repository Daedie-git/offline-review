export interface ExactLineMatch {
    readonly startLine: number;
    readonly endLine: number;
}
export type ExactLineSequenceStatus = 'current' | 'reanchored' | 'notFound' | 'ambiguous';
export interface ExactLineSequenceResolution {
    readonly status: ExactLineSequenceStatus;
    readonly matches: readonly ExactLineMatch[];
    readonly effectiveStartLine?: number;
    readonly effectiveEndLine?: number;
}
/** Split all common line endings without discarding a terminal empty line. */
export declare function splitExactLines(content: string): string[];
/**
 * Resolve an authored exact line sequence in one candidate document. Matches
 * overlap, and an unchanged authored range always wins over duplicate matches.
 */
export declare function resolveExactLineSequence(content: string, sourceAnchor: string, authoredStartLine: number, authoredEndLine: number): ExactLineSequenceResolution;
