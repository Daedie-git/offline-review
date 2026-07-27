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
export function splitExactLines(content: string): string[] {
    return content.split(/\r\n|\r|\n/);
}

/**
 * Resolve an authored exact line sequence in one candidate document. Matches
 * overlap, and an unchanged authored range always wins over duplicate matches.
 */
export function resolveExactLineSequence(
    content: string,
    sourceAnchor: string,
    authoredStartLine: number,
    authoredEndLine: number
): ExactLineSequenceResolution {
    const lines = splitExactLines(content);
    const anchorLines = splitExactLines(sourceAnchor);
    const matches: ExactLineMatch[] = [];

    for (let startLine = 0; startLine + anchorLines.length <= lines.length; startLine++) {
        let matchesAtLine = true;
        for (let offset = 0; offset < anchorLines.length; offset++) {
            if (lines[startLine + offset] !== anchorLines[offset]) {
                matchesAtLine = false;
                break;
            }
        }
        if (matchesAtLine) {
            matches.push({
                startLine,
                endLine: startLine + anchorLines.length - 1,
            });
        }
    }

    const authoredMatch = matches.find(match =>
        match.startLine === authoredStartLine
        && match.endLine === authoredEndLine
    );
    if (authoredMatch) {
        return {
            status: 'current',
            matches,
            effectiveStartLine: authoredMatch.startLine,
            effectiveEndLine: authoredMatch.endLine,
        };
    }
    if (matches.length === 1) {
        return {
            status: 'reanchored',
            matches,
            effectiveStartLine: matches[0].startLine,
            effectiveEndLine: matches[0].endLine,
        };
    }
    return {
        status: matches.length === 0 ? 'notFound' : 'ambiguous',
        matches,
    };
}
