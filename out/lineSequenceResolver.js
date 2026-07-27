"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitExactLines = splitExactLines;
exports.resolveExactLineSequence = resolveExactLineSequence;
/** Split all common line endings without discarding a terminal empty line. */
function splitExactLines(content) {
    return content.split(/\r\n|\r|\n/);
}
/**
 * Resolve an authored exact line sequence in one candidate document. Matches
 * overlap, and an unchanged authored range always wins over duplicate matches.
 */
function resolveExactLineSequence(content, sourceAnchor, authoredStartLine, authoredEndLine) {
    const lines = splitExactLines(content);
    const anchorLines = splitExactLines(sourceAnchor);
    const matches = [];
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
    const authoredMatch = matches.find(match => match.startLine === authoredStartLine
        && match.endLine === authoredEndLine);
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
//# sourceMappingURL=lineSequenceResolver.js.map